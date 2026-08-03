#!/usr/bin/env node
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { readRecordingControlConfig } from "./recording-control-runtime.mjs";
import { createPostgresRecordingActionStore } from "./postgres-recording-action-store.mjs";

const { Client } = pg;
export const MAX_ACTIVATION_ARTIFACT_BYTES = 64 * 1024;
export const ADMIN_ADVISORY_LOCK = 837491027;
const CORRELATION = /^[0-9a-f]{8,64}$/;
const DISABLE_REASONS = new Set(["emergency_disable", "maintenance_disable"]);
const USAGE = "usage: recording-control-admin.mjs activate --artifact FILE --correlation HEX | disable --reason emergency_disable|maintenance_disable --correlation HEX";

/** Read one JSON approval artifact without following a final-component symlink. */
export async function readActivationArtifact(path) {
  if (typeof path !== "string" || path.length === 0 || /[\r\n\0]/.test(path)) throw new Error("invalid_artifact");
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_ACTIVATION_ARTIFACT_BYTES) throw new Error("invalid_artifact");
    const buffer = Buffer.allocUnsafe(MAX_ACTIVATION_ARTIFACT_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, null);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead === 0 || bytesRead > MAX_ACTIVATION_ARTIFACT_BYTES) throw new Error("invalid_artifact");
    let artifact;
    try { artifact = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")); }
    catch { throw new Error("invalid_artifact"); }
    if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(artifact))) throw new Error("invalid_artifact");
    return artifact;
  } catch {
    throw new Error("invalid_artifact");
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** The sole online enable path: full runtime config plus an exact-scope attestation. */
export async function activateRecordingActions({ artifactPath, correlation, env = process.env }, dependencies = {}) {
  requireCorrelation(correlation);
  const readConfig = dependencies.readConfig ?? readRecordingControlConfig;
  const createStore = dependencies.createStore ?? createPostgresRecordingActionStore;
  const readArtifact = dependencies.readArtifact ?? readActivationArtifact;
  const config = readConfig(env);
  if (config?.envArmed !== true) throw new Error("activation_environment_not_armed");
  const artifact = await readArtifact(artifactPath);
  const store = createStore({
    databaseUrl: config.databaseUrl,
    capabilityKey: config.capabilityKey,
    capabilityKeyId: config.capabilityKeyId,
    previousCapabilityKeys: config.previous,
    approvalPublicKey: config.approvalPublicKey,
    activationScope: config.scope,
    maxDecisionAgeMs: 120000,
    leaseMs: 30000,
  });
  try {
    const result = await store.activateWithAttestation(artifact, { correlation });
    return fixedState(result, true);
  } finally {
    await store?.close?.().catch(() => {});
  }
}

/** Break-glass disable. Deliberately independent of every runtime setting except the DB URL. */
export async function disableRecordingActions({ databaseUrl, reason, correlation }, dependencies = {}) {
  if (typeof databaseUrl !== "string" || databaseUrl.length === 0 || /[\r\n\0]/.test(databaseUrl)) throw new Error("database_url_required");
  if (!DISABLE_REASONS.has(reason)) throw new Error("invalid_disable_reason");
  requireCorrelation(correlation);
  const client = dependencies.createClient
    ? await dependencies.createClient(databaseUrl)
    : new (dependencies.ClientClass ?? Client)({ connectionString: databaseUrl });
  let connected = Boolean(dependencies.createClient);
  let transaction = false;
  client.on?.("error", () => {});
  try {
    if (!connected) { await client.connect(); connected = true; }
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    transaction = true;
    await client.query("SELECT pg_advisory_xact_lock($1)", [ADMIN_ADVISORY_LOCK]);
    const control = await client.query("SELECT actions_enabled, control_epoch FROM recording_action_control WHERE singleton=true FOR UPDATE");
    if (control.rows.length !== 1) throw new Error("control_row_missing");
    const changed = await client.query("UPDATE recording_action_control SET actions_enabled=false, control_epoch=control_epoch+1, changed_at=clock_timestamp() WHERE singleton=true RETURNING actions_enabled, control_epoch");
    if (changed.rows.length !== 1) throw new Error("control_row_missing");
    const output = fixedState(changed.rows[0], false);
    await client.query("INSERT INTO recording_action_control_audit(actions_enabled, control_epoch, reason_code, correlation) VALUES(false, $1, $2, $3)", [output.controlEpoch, reason, correlation]);
    await client.query("COMMIT");
    transaction = false;
    return output;
  } catch (error) {
    if (transaction) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (connected) await client.end?.().catch(() => {});
  }
}

export async function runAdminCommand(argv, { env = process.env, ...dependencies } = {}) {
  const [command, ...args] = argv;
  if (command === "activate") {
    const options = parseOptions(args, new Set(["artifact", "correlation"]));
    return activateRecordingActions({ artifactPath: options.artifact, correlation: options.correlation, env }, dependencies);
  }
  if (command === "disable") {
    const options = parseOptions(args, new Set(["reason", "correlation"]));
    return disableRecordingActions({ databaseUrl: env.AIRCALL_CONTROL_DATABASE_URL, reason: options.reason, correlation: options.correlation }, dependencies);
  }
  throw new Error(USAGE);
}

function parseOptions(args, required) {
  const output = Object.create(null);
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (typeof flag !== "string" || !flag.startsWith("--") || typeof value !== "string" || value.startsWith("--")) throw new Error(USAGE);
    const name = flag.slice(2);
    if (!required.has(name) || Object.hasOwn(output, name)) throw new Error(USAGE);
    output[name] = value;
  }
  if (args.length !== required.size * 2 || [...required].some((name) => !Object.hasOwn(output, name))) throw new Error(USAGE);
  return output;
}
function requireCorrelation(value) { if (typeof value !== "string" || !CORRELATION.test(value)) throw new Error("invalid_correlation"); }
function fixedState(value, expected) {
  const rawEpoch = value?.controlEpoch ?? value?.control_epoch;
  const epoch = typeof rawEpoch === "number" ? rawEpoch : Number(rawEpoch);
  const enabled = value?.actionsEnabled ?? value?.actions_enabled;
  if (enabled !== expected || !Number.isSafeInteger(epoch) || epoch < 0) throw new Error("invalid_control_result");
  return Object.freeze({ actionsEnabled: expected, controlEpoch: epoch });
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const result = await runAdminCommand(argv);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write("recording_control_admin_failed\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
