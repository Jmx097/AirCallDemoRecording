import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
const { Pool } = pg;
const MIGRATIONS = Object.freeze([
  new URL("./migrations/003-two-party-retention-finalizer.sql", import.meta.url),
  new URL("./migrations/004-voiceauth-retention-override.sql", import.meta.url),
]);

/** PostgreSQL durable capability store for the post-asset finalizer. */
export function createPostgresTwoPartyRetentionStore({ databaseUrl, capabilityKey, capabilityKeyId = "retention-v1" } = {}) {
  if (typeof databaseUrl !== "string" || !databaseUrl) throw new TypeError("database_url_required");
  const key = Buffer.from(capabilityKey ?? "", "base64");
  if (key.length !== 32 || key.toString("base64") !== capabilityKey) throw new TypeError("retention_capability_key_required");
  const pool = new Pool({ connectionString: databaseUrl }); pool.on("error", () => {});
  let ready;
  async function initialize() { return ready ??= migrate(pool); }
  async function recordDecision(d) {
    await initialize(); const encrypted = seal(d, key, d.correlation, capabilityKeyId);
    await withTx(pool, async c => {
      await c.query("INSERT INTO timberline_retention_decisions(correlation,provider_call_key_hash,policy_outcome) VALUES($1,$2,'two_party_delete') ON CONFLICT DO NOTHING", [d.correlation,d.providerCallKeyHash]);
      await c.query("INSERT INTO timberline_retention_capabilities(correlation,key_id,ciphertext,iv,auth_tag) VALUES($1,$2,$3,$4,$5) ON CONFLICT(correlation) DO NOTHING", [d.correlation, capabilityKeyId, encrypted.ciphertext, encrypted.iv, encrypted.tag]);
    });
    return Object.freeze({ recorded: true });
  }
  async function enqueueAsset(e) {
    await initialize();
    const r = await pool.query(`INSERT INTO timberline_retention_actions(asset_key,correlation,status)
      SELECT $1,correlation,'delete_pending' FROM timberline_retention_decisions
      WHERE provider_call_key_hash=$2
      ON CONFLICT(asset_key) DO NOTHING RETURNING id`, [e.assetKey, e.providerCallKeyHash]);
    if (r.rows?.length) return Object.freeze({ status: "queued" });
    const existing = await pool.query("SELECT 1 FROM timberline_retention_actions WHERE asset_key=$1", [e.assetKey]);
    return Object.freeze({ status: existing.rows?.length ? "duplicate" : "missing_decision" });
  }
  async function recordVoiceAuthOverride(override) {
    await initialize();
    if (!/^[a-f0-9]{64}$/.test(override?.providerCallKeyHash ?? "") || !/^[a-f0-9]{64}$/.test(override?.eventKeyHash ?? "")) throw new TypeError("invalid_voiceauth_override");
    await pool.query("INSERT INTO timberline_voiceauth_overrides(provider_call_key_hash,event_key_hash) VALUES($1,$2) ON CONFLICT(provider_call_key_hash) DO NOTHING", [override.providerCallKeyHash, override.eventKeyHash]);
    return Object.freeze({ recorded: true });
  }
  async function hasVoiceAuthOverride(providerCallKeyHash) {
    await initialize();
    if (!/^[a-f0-9]{64}$/.test(providerCallKeyHash ?? "")) throw new TypeError("invalid_voiceauth_call_key");
    const result = await pool.query("SELECT 1 FROM timberline_voiceauth_overrides WHERE provider_call_key_hash=$1", [providerCallKeyHash]);
    return result.rows.length === 1;
  }
  async function claimNext() {
    await initialize(); const token=randomUUID();
    return withTx(pool, async c => {
      const r = await c.query(`WITH candidate AS (SELECT id,status FROM timberline_retention_actions
        WHERE status IN ('delete_pending','deleting','delete_requested','confirming','delete_confirmed','clearing') AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp())
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
        UPDATE timberline_retention_actions a SET status=CASE candidate.status WHEN 'delete_pending' THEN 'deleting' WHEN 'delete_requested' THEN 'confirming' WHEN 'delete_confirmed' THEN 'clearing' ELSE candidate.status END,
          lease_token=$1::uuid,lease_expires_at=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp()
        FROM candidate WHERE a.id=candidate.id
        RETURNING a.id`, [token]);
      // PostgreSQL cannot reference c in RETURNING; re-read the single leased capability under the same transaction.
      const id=r.rows[0]?.id; if(!id)return null;
      const cap=await c.query("SELECT a.id,a.status,a.correlation,d.provider_call_key_hash,c.key_id,c.ciphertext,c.iv,c.auth_tag FROM timberline_retention_actions a JOIN timberline_retention_decisions d USING(correlation) JOIN timberline_retention_capabilities c USING(correlation) WHERE a.id=$1 AND a.lease_token=$2::uuid",[id,token]);
      const row=cap.rows[0]; if(!row)throw new Error("retention_claim_lost"); const d=open(row,key,row.correlation);
      const logical={deleting:"delete_requested",confirming:"delete_requested",clearing:"delete_confirmed"}[row.status]??row.status;
      return Object.freeze({id:String(row.id),status:logical,providerCallId:d.providerCallId,callsItemId:d.callsItemId,providerCallKeyHash:row.provider_call_key_hash,leaseToken:token});
    });
  }
  async function transition(id, token, from, to) { await initialize(); const r=await pool.query("UPDATE timberline_retention_actions SET status=$3,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1 AND lease_token=$2::uuid AND status=ANY($4::text[]) RETURNING id",[id,token,to,from]);if(!r.rows?.length)throw new Error("retention_transition_lost"); }
  const markDeleteRequested=a=>transition(a.id,a.leaseToken,["deleting"],"delete_requested");
  const markDeleteConfirmed=a=>transition(a.id,a.leaseToken,["deleting","confirming"],"delete_confirmed");
  const markMondayCleared=a=>transition(a.id,a.leaseToken,["clearing"],"monday_link_cleared");
  const markVoiceAuthRetained=a=>transition(a.id,a.leaseToken,["deleting","confirming","clearing"],"voiceauth_retained");
  async function releaseForReconcile(a) { await transition(a.id,a.leaseToken,["confirming"],"delete_requested"); }
  async function markException(a, code) { await initialize(); await pool.query("UPDATE timberline_retention_actions SET status='exception',exception_code=$3,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1 AND lease_token=$2::uuid AND status <> 'monday_link_cleared'",[a.id,a.leaseToken,code]); }
  return Object.freeze({ initialize, recordDecision, enqueueAsset, recordVoiceAuthOverride, hasVoiceAuthOverride, claimNext, markDeleteRequested, markDeleteConfirmed, markMondayCleared, markVoiceAuthRetained, releaseForReconcile, markException, close: () => pool.end() });
}
async function migrate(pool) { const scripts = await Promise.all(MIGRATIONS.map(url => readFile(url, "utf8"))); await withTx(pool, async c => { await c.query("SELECT pg_advisory_xact_lock(837491028)"); for (const sql of scripts) for (const s of sql.split(/;\s*(?:\n|$)/).map(x=>x.trim()).filter(Boolean)) await c.query(s); }); }
async function withTx(pool, fn) { const c=await pool.connect(); try { await c.query("BEGIN"); const r=await fn(c); await c.query("COMMIT"); return r; } catch(e) { await c.query("ROLLBACK").catch(()=>{}); throw e; } finally { c.release(); } }
function seal(value,key,aad,keyId) { const iv=randomBytes(12), cipher=createCipheriv("aes-256-gcm",key,iv); cipher.setAAD(Buffer.from(`${aad}\0${keyId}`)); return { iv, ciphertext:Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]),tag:cipher.getAuthTag() }; }
function open(row,key,aad) { const d=createDecipheriv("aes-256-gcm",key,Buffer.from(row.iv)); d.setAAD(Buffer.from(`${aad}\0${row.key_id}`)); d.setAuthTag(Buffer.from(row.auth_tag)); return JSON.parse(Buffer.concat([d.update(Buffer.from(row.ciphertext)),d.final()]).toString("utf8")); }
