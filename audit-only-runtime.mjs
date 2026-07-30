import { createAuditOnlyReceiver } from "./audit-only-receiver.mjs";
import { createPostgresConsentDecisionStore } from "./postgres-consent-decision-store.mjs";
import { createRequire } from "node:module";
import { TextDecoder } from "node:util";
import { MONDAY_CALLBACK_READ_ONLY_QUERIES } from "./monday-callback-adapter.mjs";

const require = createRequire(import.meta.url);
const auditOnlyPolicy = require("./policy/recording-controller.policy.json");

const HOST = "127.0.0.1";
const MONDAY_ENDPOINT = "https://api.monday.com/v2";
const MAX_MONDAY_RESPONSE_BYTES = 256 * 1024;
const MAX_PORT = 65535;
const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const AUDIT_RULESET = Object.freeze({
  // This is a disabled audit fixture, not a legal ruleset or authorization.
  version: "audit-only-disabled-v1",
  states: Object.freeze({ AL: false, AK: false, AZ: false, AR: false, CA: false, CO: false, CT: false, DE: false, FL: false, GA: false, HI: false, ID: false, IL: false, IN: false, IA: false, KS: false, KY: false, LA: false, ME: false, MD: false, MA: false, MI: false, MN: false, MS: false, MO: false, MT: false, NE: false, NV: false, NH: false, NJ: false, NM: false, NY: false, NC: false, ND: false, OH: false, OK: false, OR: false, PA: false, RI: false, SC: false, SD: false, TN: false, TX: false, UT: false, VT: false, VA: false, WA: false, WV: false, WI: false, WY: false }),
});
const APPROVED_AUDIT_RULESET_VERSIONS = new Set([AUDIT_RULESET.version]);
const ALLOWED_QUERY_TEXT = new Set([MONDAY_CALLBACK_READ_ONLY_QUERIES.native, MONDAY_CALLBACK_READ_ONLY_QUERIES.boardPage]);
const ENVIRONMENT_KEYS = Object.freeze(["AIRCALL_AUDIT_WEBHOOK_TOKEN", "AIRCALL_AUDIT_DATABASE_URL", "MONDAY_API_TOKEN", "AIRCALL_AUDIT_PORT", "AIRCALL_AUDIT_HOST"]);

/** Builds fixed audit-only configuration from a safe data-only environment snapshot; never reads .env files. */
export function readAuditOnlyRuntimeConfig(env = process.env) {
  const safeEnv = snapshotEnvironment(env);
  if (!safeEnv || !isDisabledAuditPolicy(auditOnlyPolicy)) throw new TypeError("invalid_audit_runtime_environment");
  const token = requiredSecret(safeEnv, "AIRCALL_AUDIT_WEBHOOK_TOKEN");
  const databaseUrl = requiredDatabaseUrl(safeEnv, "AIRCALL_AUDIT_DATABASE_URL");
  const mondayToken = requiredSecret(safeEnv, "MONDAY_API_TOKEN");
  const port = optionalPort(safeEnv.AIRCALL_AUDIT_PORT);
  if (safeEnv.AIRCALL_AUDIT_HOST !== undefined && safeEnv.AIRCALL_AUDIT_HOST !== HOST) throw new TypeError("invalid_audit_runtime_host");
  return Object.freeze({ expectedWebhookToken: token, databaseUrl, mondayToken, host: HOST, port,
    canonicalBoardId: "9062504443", stateColumnId: "dropdown_mm5ht9fz", phoneColumnIds: Object.freeze(["phone_mkqkk6nv", "phone_mkqk71tf"]),
    stateSource: "rep_verified_controlled_state_dropdown", ruleset: AUDIT_RULESET, approvedRulesetVersions: APPROVED_AUDIT_RULESET_VERSIONS });
}

/** Creates the only Monday transport used by this runtime: fixed, query-only HTTPS POSTs. */
export function createReadOnlyMondayQuery({ mondayToken, fetchImpl = globalThis.fetch }) {
  if (!safeSecret(mondayToken) || typeof fetchImpl !== "function") throw new TypeError("invalid_monday_read_client_config");
  return async function mondayQuery(request) {
    if (!plainRecord(request) || !ALLOWED_QUERY_TEXT.has(request.query) || !plainRecord(request.variables)) throw new Error("monday_query_rejected");
    try {
      const response = await fetchImpl(MONDAY_ENDPOINT, { method: "POST", headers: Object.freeze({ authorization: mondayToken, "content-type": "application/json", accept: "application/json" }), body: JSON.stringify({ query: request.query, variables: request.variables }), redirect: "error", signal: AbortSignal.timeout(5_000) });
      if (!response || response.ok !== true) throw new Error("monday_read_failed");
      const body = await boundedJson(response);
      const sanitized = sanitizeMondayResponse(request.query, body);
      if (!sanitized) throw new Error("monday_read_failed");
      return sanitized;
    } catch (error) {
      // Provider and stream failures never cross this boundary with raw detail.
      if (error instanceof Error && error.message === "monday_response_too_large") throw error;
      throw new Error("monday_read_failed");
    }
  };
}

/** Composes the approved audit receiver. Construction does not listen; readiness is observed immediately to prevent an unhandled eager-store rejection. */
export function createAuditOnlyRuntime({ env = process.env, createStore = createPostgresConsentDecisionStore, createReceiver = createAuditOnlyReceiver, fetchImpl = globalThis.fetch } = {}) {
  const config = readAuditOnlyRuntimeConfig(env);
  if (typeof createStore !== "function" || typeof createReceiver !== "function") throw new TypeError("invalid_audit_runtime_dependencies");
  const store = createStore({ databaseUrl: config.databaseUrl });
  const storeReady = observeStoreReadiness(store);
  const receiverStore = receiverStoreFacade(store);
  const mondayQuery = createReadOnlyMondayQuery({ mondayToken: config.mondayToken, fetchImpl });
  let receiver;
  try {
    receiver = createReceiver({ expectedWebhookToken: config.expectedWebhookToken, canonicalBoardId: config.canonicalBoardId, stateColumnId: config.stateColumnId, phoneColumnIds: config.phoneColumnIds, stateSource: config.stateSource, mondayQuery, store: receiverStore, ruleset: config.ruleset, approvedRulesetVersions: config.approvedRulesetVersions, allowedPhoneColumnTypes: ["phone"], host: config.host, port: config.port });
  } catch (error) {
    void closeQuietly(store);
    throw error;
  }
  return Object.freeze({ receiver, store, storeReady, config: publicRuntimeConfig(config) });
}

/** Waits for durable-store initialization before binding loopback ingress. Any failure is redacted, closes the store, and leaves the receiver unstarted. */
export async function startAuditOnlyRuntime(runtime, { startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS } = {}) {
  if (!runtime || !runtime.receiver || typeof runtime.receiver.start !== "function" || !runtime.store || typeof runtime.store.close !== "function" || !(runtime.storeReady instanceof Promise) || !Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 1 || startupTimeoutMs > 60_000) throw new TypeError("invalid_audit_runtime_startup");
  try {
    await awaitBounded(runtime.storeReady, startupTimeoutMs);
    return await runtime.receiver.start();
  } catch {
    await closeQuietly(runtime.store);
    throw new Error("audit_runtime_startup_failed");
  }
}

/** Stops ingress first (bounded receiver drain), then closes the store. A timed-out in-flight dependency is failed closed by the receiver. */
export function installAuditOnlyShutdown({ receiver, store, processLike = process }) {
  if (!receiver || typeof receiver.close !== "function" || !store || typeof store.close !== "function" || !processLike || typeof processLike.once !== "function") throw new TypeError("invalid_audit_shutdown_dependencies");
  let stopping;
  const stop = async () => {
    if (!stopping) stopping = (async () => { try { await receiver.close(); } finally { await closeQuietly(store); } })();
    return stopping;
  };
  const onSignal = () => { void stop().then(() => { processLike.exitCode = 0; }, () => { processLike.exitCode = 1; }); };
  processLike.once("SIGTERM", onSignal); processLike.once("SIGINT", onSignal);
  return Object.freeze({ stop });
}

async function main() {
  let runtime;
  try { runtime = createAuditOnlyRuntime(); installAuditOnlyShutdown(runtime); await startAuditOnlyRuntime(runtime); } catch { process.exitCode = 1; }
}

function snapshotEnvironment(env) {
  try {
    // Node's process.env has a special prototype. Trust only that exact host object,
    // and copy only the named own data values into a null-prototype snapshot.
    if (env !== process.env && !plainRecord(env)) return null;
    const snapshot = Object.create(null);
    for (const name of ENVIRONMENT_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(env, name);
      if (!descriptor) continue;
      if (!("value" in descriptor) || typeof descriptor.value !== "string") return null;
      snapshot[name] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch { return null; }
}
function observeStoreReadiness(store) {
  try {
    if (!store || typeof store !== "object") throw new Error();
    const ready = ownData(store, "ready"); const initialize = ownData(store, "initialize");
    const pending = ready !== undefined ? ready : (typeof initialize === "function" ? initialize.call(store) : Promise.resolve());
    const observed = Promise.resolve(pending).then(() => undefined);
    // Install rejection handling synchronously, including for eager store.ready promises.
    void observed.catch(() => undefined);
    return observed;
  } catch {
    const failed = Promise.reject(new Error("store_readiness_invalid"));
    void failed.catch(() => undefined);
    return failed;
  }
}
function receiverStoreFacade(store) {
  try {
    if (!store || typeof store !== "object") throw new Error();
    const claim = ownData(store, "claim"); const finalize = ownData(store, "finalize"); const release = ownData(store, "release"); const initialize = ownData(store, "initialize");
    if (![claim, finalize, release, initialize].every((value) => typeof value === "function")) throw new Error();
    // Bind methods to the original store so the receiver/service cannot alter their receiver.
    return Object.freeze({ claim: claim.bind(store), finalize: finalize.bind(store), release: release.bind(store), initialize: initialize.bind(store) });
  } catch { throw new TypeError("invalid_audit_runtime_store"); }
}
async function awaitBounded(promise, timeoutMs) {
  let timer;
  try { await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("startup_timeout")), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
function requiredSecret(env, name) { const value = env[name]; if (!safeSecret(value)) throw new TypeError(`invalid_${name.toLowerCase()}`); return value; }
function safeSecret(value) { return typeof value === "string" && value.length >= 16 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value); }
function requiredDatabaseUrl(env, name) { const value = env[name]; if (typeof value !== "string" || value.length < 16 || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError(`invalid_${name.toLowerCase()}`); try { const url = new URL(value); if (!new Set(["postgres:", "postgresql:"]).has(url.protocol) || !url.hostname) throw new Error(); } catch { throw new TypeError(`invalid_${name.toLowerCase()}`); } return value; }
function optionalPort(value) { if (value === undefined) return 8080; if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,4})$/.test(value)) throw new TypeError("invalid_aircall_audit_port"); const port = Number(value); if (port < 1 || port > MAX_PORT) throw new TypeError("invalid_aircall_audit_port"); return port; }
function plainRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function ownData(object, key) { const descriptor = Object.getOwnPropertyDescriptor(object, key); return descriptor && "value" in descriptor ? descriptor.value : undefined; }
function isDisabledAuditPolicy(policy) { return plainRecord(policy) && policy.controllerStatus === "DISABLED" && policy.operatingMode === "AUDIT_ONLY" && policy.recordingActionsPermitted === false && policy.legalRuleset === null && policy.approvalGate?.status === "NOT_APPROVED"; }
async function boundedJson(response) {
  const declared = response.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_MONDAY_RESPONSE_BYTES)) throw new Error("monday_response_too_large");
  const bytes = await readCappedResponseBytes(response.body, MAX_MONDAY_RESPONSE_BYTES);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); return JSON.parse(text); } catch { throw new Error("monday_invalid_response"); }
}
async function readCappedResponseBytes(body, limit) {
  if (!body) throw new Error("monday_invalid_response");
  const chunks = []; let size = 0;
  const append = (chunk) => { const bytes = toBytes(chunk); if (!bytes || bytes.byteLength > limit - size) throw new Error("monday_response_too_large"); size += bytes.byteLength; chunks.push(bytes); };
  if (typeof body.getReader === "function") {
    const reader = body.getReader();
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; append(value); } }
    catch (error) { try { await reader.cancel(); } catch {} throw error; }
    finally { try { reader.releaseLock(); } catch {} }
  } else if (typeof body[Symbol.asyncIterator] === "function") {
    for await (const chunk of body) append(chunk);
  } else throw new Error("monday_invalid_response");
  return Buffer.concat(chunks, size);
}
function toBytes(value) { if (value instanceof Uint8Array) return value; if (value instanceof ArrayBuffer) return new Uint8Array(value); return null; }
function sanitizeMondayResponse(query, value) {
  if (!plainRecord(value) || !plainRecord(value.data)) return null;
  if (query === MONDAY_CALLBACK_READ_ONLY_QUERIES.native) { const items = sanitizeItems(value.data.items, 1); return items ? { data: { items } } : null; }
  const boards = value.data.boards;
  if (!Array.isArray(boards) || boards.length !== 1 || !plainRecord(boards[0]) || typeof boards[0].id !== "string" || !plainRecord(boards[0].items_page)) return null;
  const page = boards[0].items_page; const items = sanitizeItems(page.items, 500);
  if (!items || !(page.cursor === null || typeof page.cursor === "string" && page.cursor.length <= 2048)) return null;
  return { data: { boards: [{ id: boards[0].id, items_page: { cursor: page.cursor, items } }] } };
}
function sanitizeItems(items, limit) { if (!Array.isArray(items) || items.length > limit) return null; const sanitized = []; for (const item of items) { if (!plainRecord(item) || typeof item.id !== "string" || !plainRecord(item.board) || typeof item.board.id !== "string" || !Array.isArray(item.column_values) || item.column_values.length > 3) return null; const columns = []; for (const column of item.column_values) { if (!plainRecord(column) || typeof column.id !== "string" || typeof column.type !== "string" || !(typeof column.text === "string" || column.text === null) || (typeof column.text === "string" && column.text.length > 256)) return null; columns.push({ id: column.id, type: column.type, text: column.text ?? "" }); } sanitized.push({ id: item.id, board: { id: item.board.id }, column_values: columns }); } return sanitized; }
function publicRuntimeConfig(config) { return Object.freeze({ host: config.host, port: config.port, canonicalBoardId: config.canonicalBoardId, stateColumnId: config.stateColumnId, phoneColumnIds: config.phoneColumnIds, stateSource: config.stateSource, mode: "audit_only", recordingActionsPermitted: false }); }
async function closeQuietly(store) { try { await store.close(); } catch { /* no dependency details cross the runtime boundary */ } }

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) void main();
