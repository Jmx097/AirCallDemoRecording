import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { collectStatus, deriveOperationalInputs, purgeRetention, runCommand } from "./recording-control-ops.mjs";

const { Client } = pg;
const scopeEnv = {
  AIRCALL_CONTROL_DATABASE_URL: "database-url-placeholder",
  RECORDING_DEPLOYMENT_ID: "deploy-v1",
  RECORDING_CONTROL_POLICY_VERSION: "timberline-recording-control-2026-08-02.2",
  MONDAY_RECORDING_CONSENT_COLUMN_ID: "dropdown_mm5v99w5",
  RECORDING_PILOT_USER_IDS: "7",
  RECORDING_PILOT_NUMBER_IDS: "9",
  RECORDING_CAPABILITY_ACTIVE_KEY_ID: "active-v1",
  RECORDING_CAPABILITY_PREVIOUS_KEYS: "old-v1:ignored-key-material",
};

function healthyRow(overrides = {}) {
  return {
    actions_enabled: false, activation_matches: false, pending_count: 0, leased_count: 0,
    retry_count: 0, dispatching_count: 0, outcome_unknown_count: 0, safe_terminal_count: 2,
    stale_pending_retry_count: 0, unknown_key_count: 0, control_age_seconds: "12",
    oldest_pending_retry_age_seconds: null, ...overrides,
  };
}

function statusClient(row) {
  return { query: async (sql, parameters) => {
    assert.match(sql, /stale_pending_retry_count/);
    assert.equal(parameters[0], 300);
    assert.deepEqual(parameters[1], ["active-v1", "old-v1"]);
    assert.equal(parameters[2], true);
    for (const value of parameters.slice(3)) assert.match(value, /^[a-f0-9]{64}$/);
    return { rows: [row], rowCount: 1 };
  } };
}

test("status emits a fixed non-PII shape and reports a healthy disabled controller", async () => {
  const result = await collectStatus(statusClient(healthyRow()), { env: scopeEnv });
  assert.deepEqual(result, {
    ok: true, database: true, actionsEnabled: false, scopeAvailable: true, activationMatches: false,
    knownCapabilityKeysAvailable: true,
    counts: { pending: 0, leased: 0, retry: 0, dispatching: 0, outcomeUnknown: 0,
      safeTerminal: 2, stalePendingRetry: 0, unknownCapabilityKey: 0 },
    freshness: { controlAgeSeconds: 12, oldestPendingRetryAgeSeconds: null, staleThresholdSeconds: 300 },
  });
  const serialized = JSON.stringify(result);
  for (const forbidden of ["deploy-v1", "dropdown_mm5v99w5", "active-v1", "ignored-key-material", "database-url-placeholder"])
    assert.equal(serialized.includes(forbidden), false);
});

test("status fails for every required unsafe condition", async () => {
  for (const override of [
    { actions_enabled: true, activation_matches: false },
    { dispatching_count: 1 }, { outcome_unknown_count: 1 }, { stale_pending_retry_count: 1 }, { unknown_key_count: 1 },
  ]) assert.equal((await collectStatus(statusClient(healthyRow(override)), { env: scopeEnv })).ok, false);
  assert.equal((await collectStatus(statusClient(healthyRow({ actions_enabled: true, activation_matches: true })), { env: scopeEnv })).ok, true);
});

test("activation mismatch is enforced only when complete scope inputs are available", async () => {
  const input = deriveOperationalInputs({ ...scopeEnv, RECORDING_PILOT_USER_IDS: "" });
  assert.equal(input.scopeAvailable, false);
  const client = { query: async (_sql, parameters) => {
    assert.equal(parameters[2], false);
    assert.deepEqual(parameters.slice(3), [null, null, null, null]);
    return { rows: [healthyRow({ actions_enabled: true })] };
  } };
  assert.equal((await collectStatus(client, { env: { ...scopeEnv, RECORDING_PILOT_USER_IDS: "" } })).ok, true);
});

function purgeClient() {
  const calls = [];
  const client = { calls, async query(sql, parameters = []) {
    calls.push({ sql, parameters });
    if (/control_epoch FROM recording_action_control/.test(sql)) return { rows: [{ control_epoch: 1 }], rowCount: 1 };
    if (/clock_timestamp\(\)-interval '30 days'/.test(sql)) return { rows: [{ cutoff: new Date("2026-07-03T00:00:00Z") }], rowCount: 1 };
    if (/DELETE FROM recording_action_capabilities/.test(sql)) return { rows: [{}], rowCount: 1 };
    if (/DELETE FROM recording_action_outbox/.test(sql)) return { rows: [{}, {}], rowCount: 2 };
    if (/DELETE FROM recording_action_decisions/.test(sql)) return { rows: [{}, {}, {}], rowCount: 3 };
    if (/DELETE FROM recording_action_activations/.test(sql)) return { rows: [{}], rowCount: 1 };
    if (/DELETE FROM recording_action_control_audit/.test(sql)) return { rows: [{}, {}], rowCount: 2 };
    return { rows: [], rowCount: 0 };
  } };
  return client;
}

test("purge-retention is transactional, advisory-locked, fixed at DB-clock 30 days, and dry-run by default", async () => {
  const client = purgeClient();
  const result = await purgeRetention(client);
  assert.deepEqual(result, { ok: true, executed: false, retentionDays: 30,
    counts: { capabilities: 1, outbox: 2, decisions: 3, activations: 1, controlAudit: 2 } });
  assert.match(client.calls[0].sql, /^BEGIN ISOLATION LEVEL SERIALIZABLE$/);
  assert.match(client.calls[1].sql, /pg_advisory_xact_lock/);
  assert.match(client.calls[2].sql, /recording_action_control.*FOR UPDATE/);
  assert.equal(client.calls.at(-1).sql, "ROLLBACK");
  for (const call of client.calls.filter((entry) => /DELETE FROM/.test(entry.sql))) {
    assert.equal(call.parameters.length, 1);
    assert.equal(call.parameters[0] instanceof Date, true);
  }
  const dangerousDelete = client.calls.find((entry) => /DELETE FROM recording_action_outbox/.test(entry.sql)).sql;
  assert.match(dangerousDelete, /'succeeded','failed','canceled'/);
  for (const status of ["pending", "leased", "retry_scheduled", "dispatching", "outcome_unknown"])
    assert.equal(dangerousDelete.includes(`'${status}'`), false);
});

test("--execute commits and CLI rejects retention overrides without opening the database", async () => {
  const client = purgeClient();
  assert.equal((await purgeRetention(client, { execute: true })).executed, true);
  assert.equal(client.calls.at(-1).sql, "COMMIT");
  let connections = 0;
  const result = await runCommand(["purge-retention", "--days=31"], { env: scopeEnv, connect: async () => { connections += 1; } });
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.error, "invalid_arguments");
  assert.equal(connections, 0);
});

test("CLI converts database failures to a fixed error without leaking exception text", async () => {
  const result = await runCommand(["status"], { env: scopeEnv, connect: async () => ({
    query: async () => { throw new Error("sensitive database exception"); }, end: async () => {},
  }) });
  assert.deepEqual(result, { exitCode: 1, output: { ok: false, database: false, error: "database_error" } });
  assert.equal(JSON.stringify(result).includes("sensitive"), false);
});

const integrationUrl = process.env.AIRCALL_CONTROL_OPS_TEST_DATABASE_URL;
test("disposable PostgreSQL integration preserves unsafe/current rows and purges only eligible history", { skip: !integrationUrl }, async (t) => {
  const client = new Client({ connectionString: integrationUrl });
  await client.connect();
  const schema = `ops_${process.pid}_${Date.now()}`;
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}`);
  t.after(async () => {
    await client.query("SET search_path TO public");
    await client.query(`DROP SCHEMA ${schema} CASCADE`);
    await client.end();
  });
  const migration = await readFile(new URL("./migrations/002-recording-action-store.sql", import.meta.url), "utf8");
  await client.query(migration);
  const hash = (character) => character.repeat(64);
  const decisions = await client.query(`INSERT INTO recording_action_decisions
    (decision_key_hash,approved,reason_code,policy_key_hash,evidence_digest,decided_at)
    VALUES ($1,true,'approved_explicit_consent',$2,$3,clock_timestamp()-interval '31 days'),
           ($4,true,'approved_explicit_consent',$5,$6,clock_timestamp()-interval '31 days'),
           ($7,false,'denied',$8,NULL,clock_timestamp()-interval '31 days') RETURNING id`,
  [hash("1"), hash("a"), hash("b"), hash("2"), hash("c"), hash("d"), hash("3"), hash("e")]);
  await client.query(`INSERT INTO recording_action_outbox
    (action_key_hash,target_key_hash,decision_id,action_type,status,max_attempts,completed_at,created_at,updated_at)
    VALUES ($1,$2,$3,'resume_recording','succeeded',3,clock_timestamp()-interval '31 days',clock_timestamp()-interval '31 days',clock_timestamp()-interval '31 days'),
           ($4,$5,$6,'resume_recording','outcome_unknown',3,clock_timestamp()-interval '31 days',clock_timestamp()-interval '31 days',clock_timestamp()-interval '31 days')`,
  [hash("4"), hash("5"), decisions.rows[0].id, hash("6"), hash("7"), decisions.rows[1].id]);
  await client.query(`INSERT INTO recording_action_capabilities
    (action_key_hash,key_id,ciphertext,iv,auth_tag,expires_at,created_at)
    VALUES ($1,'active-v1',decode('01','hex'),decode(repeat('01',12),'hex'),decode(repeat('01',16),'hex'),clock_timestamp()+interval '1 day',clock_timestamp()-interval '31 days'),
           ($2,'unknown-v1',decode('01','hex'),decode(repeat('01',12),'hex'),decode(repeat('01',16),'hex'),clock_timestamp()+interval '1 day',clock_timestamp()-interval '31 days')`,
  [hash("4"), hash("6")]);
  await client.query(`UPDATE recording_action_control SET control_epoch=1,changed_at=clock_timestamp()-interval '31 days' WHERE singleton=true`);
  await client.query(`INSERT INTO recording_action_activations
    (deployment_hash,policy_hash,pilot_hash,consent_column_hash,approver_reference_hash,control_epoch,expires_at,artifact_digest,created_at)
    VALUES ($1,$2,$3,$4,$5,1,clock_timestamp()-interval '31 days',$6,clock_timestamp()-interval '40 days'),
           ($7,$8,$9,$1,$2,2,clock_timestamp()-interval '31 days',$3,clock_timestamp()-interval '40 days')`,
  [hash("8"), hash("9"), hash("a"), hash("b"), hash("c"), hash("d"), hash("e"), hash("f"), hash("0")]);
  await client.query(`INSERT INTO recording_action_control_audit(actions_enabled,control_epoch,reason_code,created_at)
    VALUES(false,1,'maintenance_disable',clock_timestamp()-interval '31 days'),
          (false,2,'maintenance_disable',clock_timestamp()-interval '31 days')`);

  const status = await collectStatus(client, { env: scopeEnv });
  assert.equal(status.ok, false);
  assert.equal(status.counts.outcomeUnknown, 1);
  assert.equal(status.counts.unknownCapabilityKey, 1);
  assert.equal(JSON.stringify(status).includes(hash("6")), false);

  const preview = await purgeRetention(client);
  assert.deepEqual(preview.counts, { capabilities: 1, outbox: 1, decisions: 2, activations: 1, controlAudit: 1 });
  assert.equal(Number((await client.query("SELECT count(*) n FROM recording_action_outbox")).rows[0].n), 2);
  const executed = await purgeRetention(client, { execute: true });
  assert.deepEqual(executed.counts, preview.counts);
  assert.equal(Number((await client.query("SELECT count(*) n FROM recording_action_outbox")).rows[0].n), 1);
  assert.equal((await client.query("SELECT status FROM recording_action_outbox")).rows[0].status, "outcome_unknown");
  assert.equal(Number((await client.query("SELECT count(*) n FROM recording_action_activations WHERE control_epoch=1")).rows[0].n), 1);
  assert.equal(Number((await client.query("SELECT count(*) n FROM recording_action_control_audit WHERE control_epoch=1")).rows[0].n), 1);
});
