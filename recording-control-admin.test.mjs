import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import {
  ADMIN_ADVISORY_LOCK,
  MAX_ACTIVATION_ARTIFACT_BYTES,
  activateRecordingActions,
  disableRecordingActions,
  readActivationArtifact,
  runAdminCommand,
} from "./recording-control-admin.mjs";

const CLI = new URL("./recording-control-admin.mjs", import.meta.url);
const CORRELATION = "0123456789abcdef";

async function tempDir(t) {
  const directory = await mkdtemp(join(tmpdir(), "recording-control-admin-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("activation reads full config, requires envArmed, and creates no store while unarmed", async () => {
  const env = { marker: "full-environment" };
  let receivedEnv;
  let stores = 0;
  await assert.rejects(activateRecordingActions({ artifactPath: "unused", correlation: CORRELATION, env }, {
    readConfig(value) { receivedEnv = value; return { envArmed: false }; },
    createStore() { stores += 1; },
    readArtifact() { throw new Error("must not read"); },
  }), /not_armed/);
  assert.equal(receivedEnv, env);
  assert.equal(stores, 0);
});

test("activation passes exact runtime store configuration and uses only attested enable", async () => {
  const artifact = { payload: {}, signature: "signature" };
  const config = {
    envArmed: true,
    databaseUrl: "db-url",
    capabilityKey: "capability-material",
    capabilityKeyId: "active-2026",
    previous: ["old:key"],
    approvalPublicKey: "public-material",
    scope: { deploymentId: "deployment", policyHash: "policy", pilotHash: "pilot", consentColumnId: "column" },
  };
  let storeOptions;
  let call;
  let closed = false;
  const result = await activateRecordingActions({ artifactPath: "/approval", correlation: CORRELATION, env: {} }, {
    readConfig: () => config,
    readArtifact: async (path) => { assert.equal(path, "/approval"); return artifact; },
    createStore(options) {
      storeOptions = options;
      return {
        async activateWithAttestation(value, metadata) { call = [value, metadata]; return { actionsEnabled: true, controlEpoch: 7 }; },
        setActionsEnabled() { assert.fail("ordinary enable path must never be called"); },
        async close() { closed = true; },
      };
    },
  });
  assert.deepEqual(storeOptions, {
    databaseUrl: config.databaseUrl,
    capabilityKey: config.capabilityKey,
    capabilityKeyId: config.capabilityKeyId,
    previousCapabilityKeys: config.previous,
    approvalPublicKey: config.approvalPublicKey,
    activationScope: config.scope,
    maxDecisionAgeMs: 120000,
    leaseMs: 30000,
  });
  assert.deepEqual(call, [artifact, { correlation: CORRELATION }]);
  assert.deepEqual(result, { actionsEnabled: true, controlEpoch: 7 });
  assert.equal(closed, true);
});

test("artifact reader rejects malformed JSON, non-object roots, symlinks, and oversized files", async (t) => {
  const directory = await tempDir(t);
  const good = join(directory, "good.json");
  await writeFile(good, "{\"payload\":{}}");
  assert.deepEqual(await readActivationArtifact(good), { payload: {} });
  for (const [name, content] of [["malformed", "{"], ["array", "[]"], ["null", "null"]]) {
    const path = join(directory, `${name}.json`);
    await writeFile(path, content);
    await assert.rejects(readActivationArtifact(path), /invalid_artifact/);
  }
  const link = join(directory, "artifact-link.json");
  await symlink(good, link);
  await assert.rejects(readActivationArtifact(link), /invalid_artifact/);
  const large = join(directory, "large.json");
  await writeFile(large, Buffer.alloc(MAX_ACTIVATION_ARTIFACT_BYTES + 1, 0x20));
  await assert.rejects(readActivationArtifact(large), /invalid_artifact/);
});

test("correlation syntax and command options are exact", async () => {
  for (const value of ["abcdefg", "ABCDEF12", "0123456g", "a".repeat(65)]) {
    await assert.rejects(runAdminCommand(["activate", "--artifact", "/x", "--correlation", value], {
      env: {}, readConfig: () => { assert.fail("invalid correlation must fail first"); },
    }));
  }
  await assert.rejects(runAdminCommand(["disable", "--reason", "routine", "--correlation", CORRELATION], {
    env: { AIRCALL_CONTROL_DATABASE_URL: "db-url" }, createClient: () => { assert.fail("invalid reason must not connect"); },
  }));
  await assert.rejects(runAdminCommand(["disable", "--reason", "emergency_disable", "--correlation", CORRELATION, "--extra", "x"], {
    env: { AIRCALL_CONTROL_DATABASE_URL: "db-url" },
  }));
});

function makeClient({ failAudit = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (failAudit && sql.startsWith("INSERT INTO recording_action_control_audit")) throw new Error("sensitive database detail");
      if (sql.includes("SELECT actions_enabled")) return { rows: [{ actions_enabled: true, control_epoch: "9" }] };
      if (sql.startsWith("UPDATE recording_action_control")) return { rows: [{ actions_enabled: false, control_epoch: "10" }] };
      return { rows: [], rowCount: 0 };
    },
    async end() { calls.push({ sql: "END_CLIENT", params: undefined }); },
  };
}

test("disable uses serializable lock/row-lock/update/audit/commit ordering and exact audit values", async () => {
  const client = makeClient();
  const output = await disableRecordingActions({ databaseUrl: "db-url", reason: "emergency_disable", correlation: CORRELATION }, { createClient: async () => client });
  assert.deepEqual(output, { actionsEnabled: false, controlEpoch: 10 });
  assert.deepEqual(client.calls.map((entry) => entry.sql), [
    "BEGIN ISOLATION LEVEL SERIALIZABLE",
    "SELECT pg_advisory_xact_lock($1)",
    "SELECT actions_enabled, control_epoch FROM recording_action_control WHERE singleton=true FOR UPDATE",
    "UPDATE recording_action_control SET actions_enabled=false, control_epoch=control_epoch+1, changed_at=clock_timestamp() WHERE singleton=true RETURNING actions_enabled, control_epoch",
    "INSERT INTO recording_action_control_audit(actions_enabled, control_epoch, reason_code, correlation) VALUES(false, $1, $2, $3)",
    "COMMIT",
    "END_CLIENT",
  ]);
  assert.deepEqual(client.calls[1].params, [ADMIN_ADVISORY_LOCK]);
  assert.deepEqual(client.calls[4].params, [10, "emergency_disable", CORRELATION]);
});

test("disable rolls back on audit failure and needs no runtime configuration", async () => {
  const client = makeClient({ failAudit: true });
  await assert.rejects(runAdminCommand(["disable", "--reason", "maintenance_disable", "--correlation", CORRELATION], {
    env: { AIRCALL_CONTROL_DATABASE_URL: "db-url" },
    createClient: async () => client,
    readConfig: () => { assert.fail("disable must not read runtime config"); },
  }), /sensitive/);
  assert.deepEqual(client.calls.slice(-2).map((entry) => entry.sql), ["ROLLBACK", "END_CLIENT"]);
  assert.equal(client.calls.some((entry) => entry.sql === "COMMIT"), false);
});

test("CLI errors are fixed and redact database details", () => {
  const marker = "not-for-output-marker";
  const result = spawnSync(process.execPath, [CLI.pathname, "disable", "--reason", "emergency_disable", "--correlation", CORRELATION], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, AIRCALL_CONTROL_DATABASE_URL: `postgresql://${marker}@127.0.0.1:1/db` },
    timeout: 5000,
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "recording_control_admin_failed\n");
  assert.equal(result.stderr.includes(marker), false);
});

test("disposable PostgreSQL: disable increments epoch and writes matching audit", { timeout: 30000 }, async (t) => {
  const url = process.env.RECORDING_CONTROL_ADMIN_TEST_DATABASE_URL;
  if (!url) { t.skip("set RECORDING_CONTROL_ADMIN_TEST_DATABASE_URL to an explicitly disposable PostgreSQL database"); return; }
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const schema = `recording_admin_${process.pid}_${Date.now()}`;
  t.after(async () => { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`CREATE TABLE ${schema}.recording_action_control(singleton boolean PRIMARY KEY CHECK(singleton), actions_enabled boolean NOT NULL, control_epoch bigint NOT NULL, changed_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
  await admin.query(`CREATE TABLE ${schema}.recording_action_control_audit(id bigserial PRIMARY KEY, actions_enabled boolean NOT NULL, control_epoch bigint NOT NULL, reason_code text NOT NULL, correlation varchar(64), created_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
  await admin.query(`INSERT INTO ${schema}.recording_action_control VALUES(true,true,41,clock_timestamp())`);
  const output = await disableRecordingActions({ databaseUrl: url, reason: "maintenance_disable", correlation: CORRELATION }, {
    createClient: async () => {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      await client.query(`SET search_path TO ${schema}`);
      return client;
    },
  });
  assert.deepEqual(output, { actionsEnabled: false, controlEpoch: 42 });
  const result = await admin.query(`SELECT c.actions_enabled,c.control_epoch,a.reason_code,a.correlation,a.control_epoch audit_epoch FROM ${schema}.recording_action_control c JOIN ${schema}.recording_action_control_audit a ON a.control_epoch=c.control_epoch`);
  assert.deepEqual(result.rows, [{ actions_enabled: false, control_epoch: "42", reason_code: "maintenance_disable", correlation: CORRELATION, audit_epoch: "42" }]);
});
