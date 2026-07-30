import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import pg from "pg";
import { createPostgresConsentDecisionStore } from "./postgres-consent-decision-store.mjs";

const execFile = promisify(execFileCallback);
const { Pool } = pg;

async function dockerAvailable() {
  try { await execFile("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 10_000 }); return true; } catch { return false; }
}
async function waitForPostgres(name) {
  let lastError;
  for (let i = 0; i < 40; i++) {
    try { await execFile("docker", ["exec", name, "psql", "-U", "postgres", "-d", "consent", "-c", "SELECT 1"], { timeout: 5_000 }); return; }
    catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  throw lastError || new Error("PostgreSQL did not become ready");
}

test("PostgreSQL integration: contradictory fenced transitions keep audit atomic and redacted", { timeout: 290_000 }, async (t) => {
  if (!(await dockerAvailable())) { t.skip("Docker unavailable"); return; }
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const name = `consent-store-test-${suffix}`;
  const password = `test-${suffix}`;
  let pool;
  let store;
  let competingStore;
  try {
    await execFile("docker", ["run", "-d", "--rm", "--name", name, "-e", `POSTGRES_PASSWORD=${password}`, "-e", "POSTGRES_DB=consent", "-p", "127.0.0.1::5432", "postgres:16-alpine"], { timeout: 120_000 });
    const { stdout } = await execFile("docker", ["port", name, "5432/tcp"]);
    const match = stdout.match(/:(\d+)\s*$/m);
    assert.ok(match, `could not determine published port: ${stdout}`);
    const databaseUrl = new URL(`postgres://127.0.0.1:${match[1]}/consent`);
    databaseUrl.username = "postgres";
    databaseUrl.password = password;
    const connectionString = databaseUrl.toString();
    await waitForPostgres(name);
    // Independently owned pools initialize concurrently; the transaction-scoped
    // advisory lock must serialize their migrations safely.
    store = createPostgresConsentDecisionStore({ databaseUrl: connectionString, claimTtlMs: 100, randomUUID: (() => { let n = 0; return () => `token-${++n}`; })() });
    competingStore = createPostgresConsentDecisionStore({ databaseUrl: connectionString });
    await Promise.all([store.ready, competingStore.ready]);
    await competingStore.close();
    competingStore = undefined;
    const rawKey = "event-secret-15551234567";
    const first = await store.claim(rawKey);
    assert.equal(first.claimed, true);
    assert.equal((await store.claim(rawKey)).claimed, false, "nonexpired duplicate must not claim");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const recovered = await store.claim(rawKey);
    assert.equal(recovered.claimed, true, "only expired processing leases may recover");
    assert.notEqual(recovered.leaseToken, first.leaseToken);

    await assert.rejects(
      store.finalize({ ...recovered, leaseToken: "wrong-token" }, { outcome: "left_disabled", reason: "not_one_party_state" }, { correlation: "a".repeat(24) }),
      (error) => error.code === "claim_lease_lost",
    );
    pool = new Pool({ connectionString });
    pool.on("error", () => {});
    assert.equal(Number((await pool.query("SELECT COUNT(*) AS count FROM consent_decision_service_schema_versions WHERE version = 1")).rows[0].count), 1);
    assert.equal(Number((await pool.query("SELECT COUNT(*) AS count FROM consent_decision_audit_outbox")).rows[0].count), 0);

    // Force the audit insert to fail in real PostgreSQL. The status update must roll back too.
    await pool.query("ALTER TABLE consent_decision_audit_outbox ADD CONSTRAINT consent_decision_test_force_audit_failure CHECK (false)");
    await assert.rejects(
      store.finalize(recovered, { outcome: "left_disabled", reason: "not_one_party_state" }, { correlation: "b".repeat(24) }),
      /consent_decision_test_force_audit_failure/,
    );
    const failedState = (await pool.query("SELECT status FROM consent_decision_claims WHERE event_key_hash = $1", [createHash("sha256").update(rawKey).digest("hex")])).rows[0];
    assert.equal(failedState.status, "processing", "failed audit must not complete the claim");
    assert.equal(Number((await pool.query("SELECT COUNT(*) AS count FROM consent_decision_audit_outbox")).rows[0].count), 0);
    await pool.query("ALTER TABLE consent_decision_audit_outbox DROP CONSTRAINT consent_decision_test_force_audit_failure");

    // The failed finalization left the valid recovered lease usable.
    const finalClaim = recovered;
    await store.finalize(finalClaim, { outcome: "left_disabled", reason: "not_one_party_state" }, { correlation: "b".repeat(24) });
    assert.equal(Number((await pool.query("SELECT COUNT(*) AS count FROM consent_decision_audit_outbox")).rows[0].count), 1);
    await store.release(finalClaim);
    assert.equal((await store.claim(rawKey)).claimed, false, "release after completed finalization is a no-op");

    const releasableKey = "event-releasable-15550000000";
    const releasable = await store.claim(releasableKey);
    assert.equal(releasable.claimed, true);
    await store.release(releasable);
    assert.equal((await store.claim(releasableKey)).claimed, true, "release must remove only its processing lease");

    const sanitizedKey = "event-sanitized-15559999999";
    const sanitized = await store.claim(sanitizedKey);
    await store.finalize(
      sanitized,
      { outcome: "untrusted-outcome", reason: "untrusted-secret-reason" },
      { correlation: "call-15559999999" },
    );

    const rows = (await pool.query("SELECT event_key_hash, outcome, reason, correlation_prefix FROM consent_decision_audit_outbox")).rows;
    const serialized = JSON.stringify(rows);
    assert.match(rows[0].event_key_hash, /^[a-f0-9]{64}$/);
    assert.deepEqual({ outcome: rows[0].outcome, reason: rows[0].reason, correlation_prefix: rows[0].correlation_prefix }, { outcome: "left_disabled", reason: "not_one_party_state", correlation_prefix: "b".repeat(24) });
    for (const forbidden of [rawKey, "15551234567", finalClaim.leaseToken]) assert.equal(serialized.includes(forbidden), false);
    const sanitizedRow = rows.find((row) => row.event_key_hash === createHash("sha256").update(sanitizedKey).digest("hex"));
    assert.deepEqual(
      { outcome: sanitizedRow.outcome, reason: sanitizedRow.reason, correlation_prefix: sanitizedRow.correlation_prefix },
      { outcome: "left_disabled", reason: "invalid_ruleset", correlation_prefix: null },
    );
    for (const forbidden of [sanitizedKey, "15559999999", "untrusted-secret-reason"]) assert.equal(serialized.includes(forbidden), false);
  } catch (error) {
    const { stdout = "" } = await execFile("docker", ["logs", name], { timeout: 30_000 }).catch(() => ({ stdout: "" }));
    error.message = `${error.message}\nPostgres logs:\n${stdout}`;
    throw error;
  } finally {
    await competingStore?.close().catch(() => {});
    await store?.close().catch(() => {});
    await pool?.end().catch(() => {});
    await execFile("docker", ["rm", "-f", name], { timeout: 30_000 }).catch(() => {});
  }
});
