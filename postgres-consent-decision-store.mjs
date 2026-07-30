import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const OPAQUE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CORRELATION = /^[a-f0-9]{8,64}$/;
const OUTCOMES = new Set(["left_disabled"]);
const REASONS = new Set([
  "audit_only_eligible_one_party_state", "not_one_party_state", "invalid_state", "invalid_ruleset",
  "resolver_not_found", "resolver_not_unique", "resolver_denied",
]);
const FALLBACK = Object.freeze({ outcome: "left_disabled", reason: "invalid_ruleset" });
const MIGRATION_URL = new URL("./migrations/001-consent-decision-store.sql", import.meta.url);
// A stable namespace-specific key serializes this store's schema initialization across processes.
const MIGRATION_ADVISORY_LOCK = 837491026;

/**
 * A PostgreSQL durable store for the isolated, audit-only decision service.
 * The store exclusively owns its pg Pool; query, client, pool, and facade
 * injection are intentionally unsupported.
 */
export function createPostgresConsentDecisionStore(config = {}) {
  config = validateStoreConfig(config);
  const claimTtlMs = safeTtl(config.claimTtlMs);
  const executor = makeExecutor(config);
  const uuid = typeof config.randomUUID === "function" ? config.randomUUID : nodeRandomUUID;
  let initialization;
  let closed = false;

  function assertOpen() {
    if (closed) throw new Error("consent_decision_store_closed");
  }

  async function initialize() {
    if (!initialization) {
      initialization = (async () => {
        const migration = await readFile(fileURLToPath(MIGRATION_URL), "utf8");
        const statements = splitMigrationStatements(migration);
        await executor.withClient(async (client) => {
          let began = false;
          try {
            await client.query("BEGIN"); began = true;
            await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_ADVISORY_LOCK]);
            for (const statement of statements) await client.query(statement);
            await client.query("COMMIT"); began = false;
          } catch (error) {
            if (began) {
              try { await client.query("ROLLBACK"); } catch { /* preserve original failure */ }
            }
            throw error;
          }
        });
      })();
    }
    return initialization;
  }

  async function claim(key) {
    await initialize();
    assertOpen();
    if (!isOpaqueKey(key)) throw new TypeError("invalid_claim_key");
    const token = String(uuid());
    const result = await executor.query(
      `INSERT INTO consent_decision_claims (event_key_hash, status, lease_token, lease_expires_at)
       VALUES ($1, 'processing', $2, NOW() + ($3 * INTERVAL '1 millisecond'))
       ON CONFLICT (event_key_hash) DO UPDATE
       SET status = 'processing', lease_token = EXCLUDED.lease_token, lease_expires_at = EXCLUDED.lease_expires_at
       WHERE consent_decision_claims.status = 'processing'
         AND consent_decision_claims.lease_expires_at <= NOW()
       RETURNING event_key_hash`,
      [hashKey(key), token, claimTtlMs],
    );
    return result.rows?.length ? Object.freeze({ claimed: true, key, leaseToken: token }) : Object.freeze({ claimed: false, key });
  }

  async function finalize(claimRecord, outcome, metadata = {}) {
    await initialize();
    assertOpen();
    const claim = safeClaim(claimRecord);
    if (!claim) throw leaseLost();
    const decision = safeDecision(outcome);
    const correlation = safeCorrelation(metadata);
    const keyHash = hashKey(claim.key);
    await executor.withClient(async (client) => {
      let began = false;
      try {
        // Every statement is deliberately issued through this one acquired client.
        await client.query("BEGIN"); began = true;
        const fenced = await client.query(
          `UPDATE consent_decision_claims
           SET status = 'completed', lease_token = NULL, lease_expires_at = NULL, completed_at = NOW()
           WHERE event_key_hash = $1 AND lease_token = $2 AND status = 'processing' AND lease_expires_at > NOW()
           RETURNING event_key_hash`,
          [keyHash, claim.leaseToken],
        );
        if (!fenced.rows?.length) {
          await client.query("ROLLBACK"); began = false;
          throw leaseLost();
        }
        await client.query(
          `INSERT INTO consent_decision_audit_outbox (event_key_hash, outcome, reason, correlation_prefix)
           VALUES ($1, $2, $3, $4)`,
          [keyHash, decision.outcome, decision.reason, correlation],
        );
        await client.query("COMMIT"); began = false;
      } catch (error) {
        if (began) {
          try { await client.query("ROLLBACK"); } catch { /* preserve original failure */ }
        }
        throw error;
      }
    });
  }

  async function release(claimRecord) {
    await initialize();
    assertOpen();
    const claim = safeClaim(claimRecord);
    if (!claim) return;
    await executor.query(
      `DELETE FROM consent_decision_claims
       WHERE event_key_hash = $1 AND lease_token = $2 AND status = 'processing'`,
      [hashKey(claim.key), claim.leaseToken],
    );
  }

  async function close() {
    if (closed) return;
    closed = true;
    await executor.close();
  }

  const ready = initialize();
  return Object.freeze({ claim, finalize, release, initialize, ready, close });
}

function makeExecutor(config) {
  validateStoreConfig(config);
  const pool = new Pool({ connectionString: config.databaseUrl });
  pool.on("error", () => {});
  return {
    query: pool.query.bind(pool),
    withClient: async (work) => {
      const client = await pool.connect();
      try { return await work(client); } finally { client.release(); }
    },
    close: () => pool.end(),
  };
}

function validateStoreConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new TypeError("store config must be an object with databaseUrl");
  const prototype = Object.getPrototypeOf(config);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("store config must be a plain object with databaseUrl");
  const allowed = new Set(["databaseUrl", "claimTtlMs", "randomUUID"]);
  for (const option of Reflect.ownKeys(config)) {
    if (!allowed.has(option)) throw new TypeError(`unsupported store option: ${option}; databaseUrl-only connection ownership is required`);
  }
  if (typeof config.databaseUrl !== "string" || config.databaseUrl.trim().length === 0) {
    throw new TypeError("databaseUrl is required");
  }
  return config;
}

// The migration is static and contains no procedural bodies; issue each statement separately
// because node-postgres must not receive a multi-statement prepared query.
function splitMigrationStatements(migration) {
  return migration.split(/;\s*(?:\r?\n|$)/).map((statement) => statement.trim()).filter(Boolean);
}
function safeTtl(value) {
  if (value === undefined) return 60_000;
  if (!Number.isInteger(value) || value < 1 || value > 86_400_000) throw new TypeError("claimTtlMs must be an integer between 1 and 86400000");
  return value;
}
function isOpaqueKey(value) { return typeof value === "string" && OPAQUE_KEY.test(value); }
function hashKey(key) { return createHash("sha256").update(key).digest("hex"); }
function safeClaim(value) {
  if (!value || typeof value !== "object" || value.claimed !== true || !isOpaqueKey(value.key)
    || typeof value.leaseToken !== "string" || value.leaseToken.length < 1 || value.leaseToken.length > 200) return null;
  return { key: value.key, leaseToken: value.leaseToken };
}
function safeDecision(value) {
  const outcome = value?.outcome;
  const reason = value?.reason;
  return OUTCOMES.has(outcome) && REASONS.has(reason) ? { outcome, reason } : FALLBACK;
}
function safeCorrelation(value) {
  const correlation = value?.correlation;
  return typeof correlation === "string" && CORRELATION.test(correlation) ? correlation.slice(0, 64) : null;
}
function leaseLost() { const error = new Error("claim_lease_lost"); error.code = "claim_lease_lost"; return error; }
