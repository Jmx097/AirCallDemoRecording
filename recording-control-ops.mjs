#!/usr/bin/env node
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { hashActivationValue, hashPilotScope } from "./recording-activation-approval.mjs";

const { Client } = pg;
const STALE_SECONDS = 300;
const RETENTION_DAYS = 30;
const OPS_LOCK = 837491028;
const HEX = /^[0-9a-f]{64}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const POLICY_VERSION = "timberline-recording-control-2026-08-02.2";
const CONSENT_COLUMN_ID = "dropdown_mm5v99w5";
const POLICY_HASH = createHash("sha256").update(JSON.stringify({
  version: POLICY_VERSION,
  board: "7727339040",
  state: "text_2",
  phones: ["phone__1", "dup__of_phone7__1", "phone_mkrgdn4"],
  consent: CONSENT_COLUMN_ID,
  eligibleStates: ["TX"],
})).digest("hex");

const STATUS_SQL = `
WITH control AS (
  SELECT actions_enabled, control_epoch, changed_at
  FROM recording_action_control WHERE singleton=true
), summary AS (
  SELECT
    count(*) FILTER (WHERE status='pending')::int AS pending_count,
    count(*) FILTER (WHERE status='leased')::int AS leased_count,
    count(*) FILTER (WHERE status='retry_scheduled')::int AS retry_count,
    count(*) FILTER (WHERE status='dispatching')::int AS dispatching_count,
    count(*) FILTER (WHERE status='outcome_unknown')::int AS outcome_unknown_count,
    count(*) FILTER (WHERE status IN ('succeeded','failed','canceled'))::int AS safe_terminal_count,
    count(*) FILTER (WHERE status IN ('pending','retry_scheduled')
      AND available_at <= clock_timestamp()-($1::int*interval '1 second'))::int AS stale_pending_retry_count,
    CASE WHEN count(*) FILTER (WHERE status IN ('pending','retry_scheduled'))=0 THEN NULL
      ELSE floor(extract(epoch FROM greatest(interval '0 seconds',
        clock_timestamp()-min(updated_at) FILTER (WHERE status IN ('pending','retry_scheduled')))))::bigint
    END AS oldest_pending_retry_age_seconds
  FROM recording_action_outbox
), capability AS (
  SELECT count(*) FILTER (WHERE NOT (key_id=ANY($2::text[])))::int AS unknown_key_count
  FROM recording_action_capabilities
)
SELECT
  c.actions_enabled,
  floor(extract(epoch FROM greatest(interval '0 seconds',clock_timestamp()-c.changed_at)))::bigint AS control_age_seconds,
  CASE WHEN $3::boolean THEN EXISTS (
    SELECT 1 FROM recording_action_activations a
    WHERE a.control_epoch=c.control_epoch AND a.expires_at>clock_timestamp()
      AND a.deployment_hash=$4 AND a.policy_hash=$5 AND a.pilot_hash=$6 AND a.consent_column_hash=$7
  ) ELSE false END AS activation_matches,
  s.*, capability.unknown_key_count
FROM control c CROSS JOIN summary s CROSS JOIN capability`;

export function deriveOperationalInputs(env = process.env) {
  const deploymentId = clean(env.RECORDING_DEPLOYMENT_ID);
  const consentColumnId = clean(env.MONDAY_RECORDING_CONSENT_COLUMN_ID);
  const users = list(env.RECORDING_PILOT_USER_IDS);
  const numbers = list(env.RECORDING_PILOT_NUMBER_IDS);
  const policyVersion = clean(env.RECORDING_CONTROL_POLICY_VERSION);
  const scopeAvailable = Boolean(deploymentId && consentColumnId === CONSENT_COLUMN_ID
    && policyVersion === POLICY_VERSION && users.length && numbers.length);
  const knownKeyIds = [];
  const active = clean(env.RECORDING_CAPABILITY_ACTIVE_KEY_ID);
  if (active && KEY_ID.test(active)) knownKeyIds.push(active);
  for (const entry of String(env.RECORDING_CAPABILITY_PREVIOUS_KEYS ?? "").split(",").filter(Boolean)) {
    const id = entry.slice(0, entry.indexOf(":"));
    if (KEY_ID.test(id) && !knownKeyIds.includes(id)) knownKeyIds.push(id);
  }
  return Object.freeze({
    scopeAvailable,
    knownCapabilityKeysAvailable: knownKeyIds.length > 0,
    knownKeyIds: Object.freeze(knownKeyIds),
    scope: scopeAvailable ? Object.freeze({
      deploymentHash: hashActivationValue("deployment-v1", deploymentId),
      policyHash: POLICY_HASH,
      pilotHash: hashPilotScope(users, numbers),
      consentColumnHash: hashActivationValue("consent-column-v1", consentColumnId),
    }) : null,
  });
}

export async function collectStatus(client, { env = process.env, staleSeconds = STALE_SECONDS } = {}) {
  if (!client || typeof client.query !== "function") throw new TypeError("database client required");
  if (!Number.isInteger(staleSeconds) || staleSeconds < 1) throw new TypeError("invalid stale threshold");
  const input = deriveOperationalInputs(env);
  const scope = input.scope ?? {};
  const result = await client.query(STATUS_SQL, [staleSeconds, input.knownKeyIds, input.scopeAvailable,
    scope.deploymentHash ?? null, scope.policyHash ?? null, scope.pilotHash ?? null, scope.consentColumnHash ?? null]);
  if (result.rows.length !== 1) throw new Error("control_row_missing");
  const row = result.rows[0];
  const counts = Object.freeze({
    pending: integer(row.pending_count), leased: integer(row.leased_count), retry: integer(row.retry_count),
    dispatching: integer(row.dispatching_count), outcomeUnknown: integer(row.outcome_unknown_count),
    safeTerminal: integer(row.safe_terminal_count), stalePendingRetry: integer(row.stale_pending_retry_count),
    unknownCapabilityKey: integer(row.unknown_key_count),
  });
  const unhealthy = (row.actions_enabled === true && input.scopeAvailable && row.activation_matches !== true)
    || counts.dispatching > 0 || counts.outcomeUnknown > 0 || counts.stalePendingRetry > 0
    || counts.unknownCapabilityKey > 0;
  return Object.freeze({
    ok: !unhealthy, database: true, actionsEnabled: row.actions_enabled === true,
    scopeAvailable: input.scopeAvailable, activationMatches: input.scopeAvailable && row.activation_matches === true,
    knownCapabilityKeysAvailable: input.knownCapabilityKeysAvailable,
    counts,
    freshness: Object.freeze({
      controlAgeSeconds: nullableInteger(row.control_age_seconds),
      oldestPendingRetryAgeSeconds: nullableInteger(row.oldest_pending_retry_age_seconds),
      staleThresholdSeconds: staleSeconds,
    }),
  });
}

export async function purgeRetention(client, { execute = false } = {}) {
  if (!client || typeof client.query !== "function") throw new TypeError("database client required");
  if (typeof execute !== "boolean") throw new TypeError("execute must be boolean");
  let transaction = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE"); transaction = true;
    await client.query("SELECT pg_advisory_xact_lock($1)", [OPS_LOCK]);
    const control = await client.query("SELECT control_epoch FROM recording_action_control WHERE singleton=true FOR UPDATE");
    if (control.rows.length !== 1) throw new Error("control_row_missing");
    const clock = await client.query("SELECT clock_timestamp()-interval '30 days' AS cutoff");
    const cutoff = clock.rows[0]?.cutoff;
    if (!cutoff) throw new Error("database_clock_unavailable");

    const capabilities = await client.query(`DELETE FROM recording_action_capabilities cap USING recording_action_outbox outbox
      WHERE cap.action_key_hash=outbox.action_key_hash
        AND outbox.status IN ('succeeded','failed','canceled') AND outbox.completed_at<$1
      RETURNING cap.action_key_hash`, [cutoff]);
    const outbox = await client.query(`DELETE FROM recording_action_outbox
      WHERE status IN ('succeeded','failed','canceled') AND completed_at<$1
      RETURNING decision_id`, [cutoff]);
    const decisions = await client.query(`DELETE FROM recording_action_decisions decision
      WHERE decision.decided_at<$1 AND NOT EXISTS (
        SELECT 1 FROM recording_action_outbox outbox WHERE outbox.decision_id=decision.id)
      RETURNING decision.id`, [cutoff]);
    const activations = await client.query(`DELETE FROM recording_action_activations activation
      WHERE activation.expires_at<$1
        AND NOT EXISTS (SELECT 1 FROM recording_action_control control
          WHERE control.singleton=true AND control.control_epoch=activation.control_epoch)
      RETURNING activation.control_epoch`, [cutoff]);
    const audit = await client.query(`DELETE FROM recording_action_control_audit audit
      WHERE audit.created_at<$1
        AND NOT EXISTS (SELECT 1 FROM recording_action_control control
          WHERE control.singleton=true AND control.control_epoch=audit.control_epoch)
      RETURNING audit.id`, [cutoff]);
    const counts = Object.freeze({ capabilities: capabilities.rowCount, outbox: outbox.rowCount,
      decisions: decisions.rowCount, activations: activations.rowCount, controlAudit: audit.rowCount });
    await client.query(execute ? "COMMIT" : "ROLLBACK"); transaction = false;
    return Object.freeze({ ok: true, executed: execute, retentionDays: RETENTION_DAYS, counts });
  } catch (error) {
    if (transaction) await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export async function runCommand(argv, { env = process.env, connect } = {}) {
  const [command, ...flags] = argv;
  if (!env.AIRCALL_CONTROL_DATABASE_URL) return failure("database_url_missing");
  if (command === "status" && flags.length) return failure("invalid_arguments");
  if (command === "purge-retention" && (flags.some((flag) => flag !== "--execute")
    || flags.filter((flag) => flag === "--execute").length > 1))
    return failure("invalid_arguments");
  if (!new Set(["status", "purge-retention"]).has(command)) return failure("usage");
  let client;
  try {
    client = connect ? await connect(env.AIRCALL_CONTROL_DATABASE_URL) : new Client({ connectionString: env.AIRCALL_CONTROL_DATABASE_URL });
    if (!connect) await client.connect();
    const output = command === "status" ? await collectStatus(client, { env })
      : await purgeRetention(client, { execute: flags.includes("--execute") });
    return Object.freeze({ exitCode: output.ok ? 0 : 1, output });
  } catch {
    return failure("database_error", { database: false });
  } finally {
    if (client && typeof client.end === "function") {
      try { await client.end(); } catch { /* fixed error output must not be replaced by close failures */ }
    }
  }
}

function failure(reason, extra = {}) {
  return Object.freeze({ exitCode: 1, output: Object.freeze({ ok: false, ...extra, error: reason }) });
}
function clean(value) { return typeof value === "string" && value.length > 0 && !/[\r\n\0]/.test(value) ? value : null; }
function list(value) {
  if (typeof value !== "string" || value.length === 0) return [];
  const values = value.split(",");
  return values.every((entry) => entry && entry === entry.trim()) && new Set(values).size === values.length ? values : [];
}
function integer(value) { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw new Error("invalid_database_count"); return n; }
function nullableInteger(value) { return value == null ? null : integer(value); }

export async function main(argv = process.argv.slice(2)) {
  const result = await runCommand(argv);
  process.stdout.write(`${JSON.stringify(result.output)}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
