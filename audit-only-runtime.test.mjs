import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createAuditOnlyRuntime, createReadOnlyMondayQuery, installAuditOnlyShutdown, readAuditOnlyRuntimeConfig, startAuditOnlyRuntime } from "./audit-only-runtime.mjs";
import { MONDAY_CALLBACK_READ_ONLY_QUERIES } from "./monday-callback-adapter.mjs";

const env = Object.freeze({ AIRCALL_AUDIT_WEBHOOK_TOKEN: "webhook-token-with-safe-length", AIRCALL_AUDIT_DATABASE_URL: "postgresql://audit_user:***@127.0.0.1:5432/audit", MONDAY_API_TOKEN: "monday-token-with-safe-length" });
const encoder = new TextEncoder();
function responseFromChunks(chunks, { ok = true, length } = {}) {
  const stream = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk); controller.close(); } });
  return { ok, headers: { get: (name) => name === "content-length" ? (length === undefined ? null : String(length)) : null }, body: stream };
}
function response(body, options = {}) { return responseFromChunks([body], { ...options, length: options.length ?? Buffer.byteLength(body) }); }
function nativeBody() { return JSON.stringify({ data: { items: [{ id: "1", board: { id: "9062504443" }, column_values: [{ id: "dropdown_mm5ht9fz", type: "dropdown", text: "TX" }, { id: "dropdown_mm5rm7vc", type: "dropdown", text: "Verified — Permit Recording" }] }] }, extensions: { secret: "must not escape" } }); }
async function withProcessEnvironment(values, work) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(process.env, key)]));
  try { for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } return await work(); }
  finally { for (const [key, descriptor] of Object.entries(saved)) { if (descriptor) Object.defineProperty(process.env, key, descriptor); else delete process.env[key]; } }
}

test("runtime config requires safe required env, fixes mapping and loopback", () => {
  const config = readAuditOnlyRuntimeConfig(env);
  assert.equal(config.host, "127.0.0.1"); assert.equal(config.port, 8080); assert.equal(config.canonicalBoardId, "9062504443");
  assert.equal(config.consentColumnId, "dropdown_mm5rm7vc"); assert.deepEqual(config.phoneColumnIds, ["phone_mkqkk6nv", "phone_mkqk71tf"]); assert.equal(config.ruleset.version, "audit-only-disabled-v1"); assert.equal(config.ruleset.states.TX, false);
  for (const altered of [{}, { ...env, AIRCALL_AUDIT_WEBHOOK_TOKEN: "short" }, { ...env, AIRCALL_AUDIT_DATABASE_URL: "https://not-postgres.example" }, { ...env, AIRCALL_AUDIT_PORT: "0" }, { ...env, AIRCALL_AUDIT_HOST: "0.0.0.0" }]) assert.throws(() => readAuditOnlyRuntimeConfig(altered));
  assert.equal(readAuditOnlyRuntimeConfig({ ...env, AIRCALL_AUDIT_HOST: "127.0.0.1", AIRCALL_AUDIT_PORT: "3210" }).port, 3210);
  assert.throws(() => readAuditOnlyRuntimeConfig(Object.defineProperty({}, "AIRCALL_AUDIT_WEBHOOK_TOKEN", { get() { throw new Error("must not run"); } })), /invalid_audit_runtime_environment/);
});

test("default Node process.env is snapshotted safely without dotenv or prototype rejection", async () => {
  await withProcessEnvironment({ ...env, AIRCALL_AUDIT_PORT: undefined, AIRCALL_AUDIT_HOST: undefined }, async () => {
    const config = readAuditOnlyRuntimeConfig();
    assert.equal(config.host, "127.0.0.1"); assert.equal(config.port, 8080); assert.equal(config.expectedWebhookToken, env.AIRCALL_AUDIT_WEBHOOK_TOKEN);
  });
});

test("Monday transport accepts only fixed query documents and returns bounded redacted shapes", async () => {
  const calls = []; const query = createReadOnlyMondayQuery({ mondayToken: env.MONDAY_API_TOKEN, fetchImpl: async (...args) => { calls.push(args); return response(nativeBody()); } });
  const result = await query({ query: MONDAY_CALLBACK_READ_ONLY_QUERIES.native, variables: { itemId: "1", columnIds: ["dropdown_mm5ht9fz", "dropdown_mm5rm7vc"] } });
  assert.deepEqual(result, { data: { items: [{ id: "1", board: { id: "9062504443" }, column_values: [{ id: "dropdown_mm5ht9fz", type: "dropdown", text: "TX" }, { id: "dropdown_mm5rm7vc", type: "dropdown", text: "Verified — Permit Recording" }] }] } });
  assert.equal(calls.length, 1); assert.equal(calls[0][0], "https://api.monday.com/v2"); assert.equal(calls[0][1].method, "POST"); assert.match(calls[0][1].body, /^\{"query":"query /);
  await assert.rejects(query({ query: "mutation Evil { x }", variables: {} }), /monday_query_rejected/);
  const blankStatePage = JSON.stringify({ data: { items_page_by_column_values: { items: [{ id: "1", board: { id: "9062504443" }, column_values: [{ id: "dropdown_mm5ht9fz", type: "dropdown", text: null }] }] } } });
  const blankStateQuery = createReadOnlyMondayQuery({ mondayToken: env.MONDAY_API_TOKEN, fetchImpl: async () => response(blankStatePage) });
  const blankStateResult = await blankStateQuery({ query: MONDAY_CALLBACK_READ_ONLY_QUERIES.phoneLookup, variables: { boardId: "9062504443", phoneColumnId: "phone_mkqkk6nv", phoneDigits: "15551234567", columnIds: ["dropdown_mm5ht9fz"] } });
  assert.deepEqual(blankStateResult, { data: { items_page_by_column_values: { items: [{ id: "1", board: { id: "9062504443" }, column_values: [{ id: "dropdown_mm5ht9fz", type: "dropdown", text: "" }] }] } } });
});

test("Monday response cap is byte-based for absent length chunked and non-ASCII bodies", async () => {
  const invoke = (fetchImpl) => createReadOnlyMondayQuery({ mondayToken: env.MONDAY_API_TOKEN, fetchImpl })({ query: MONDAY_CALLBACK_READ_ONLY_QUERIES.native, variables: {} });
  const oversized = "x".repeat(256 * 1024 + 1);
  await assert.rejects(invoke(async () => responseFromChunks([oversized.slice(0, 100), oversized.slice(100)])), /monday_response_too_large/);
  const unicode = `{"data":${JSON.stringify("é".repeat(140_000))}}`;
  assert.ok(unicode.length < 256 * 1024); assert.ok(Buffer.byteLength(unicode) > 256 * 1024);
  await assert.rejects(invoke(async () => responseFromChunks([unicode])), /monday_response_too_large/);
  await assert.rejects(invoke(async () => response("{}", { length: 256 * 1024 + 1 })), /monday_response_too_large/);
});

test("runtime composition is unstarted, redacts public config, and passes only fixed loopback settings", async () => {
  const calls = []; const store = { close: async () => { calls.push("store.close"); }, ready: Promise.resolve(), async initialize() { assert.equal(this, store); }, async claim() { assert.equal(this, store); }, async finalize() { assert.equal(this, store); }, async release() { assert.equal(this, store); } };
  const receiver = { start: async () => {}, close: async () => { calls.push("receiver.close"); } };
  const runtime = createAuditOnlyRuntime({ env, createStore: (config) => { calls.push(config); return store; }, createReceiver: (config) => { calls.push(config); return receiver; }, fetchImpl: async () => response(nativeBody()) });
  assert.equal(runtime.receiver, receiver); assert.equal(calls.filter((x) => x === "receiver.close").length, 0);
  assert.deepEqual(runtime.config, { host: "127.0.0.1", port: 8080, canonicalBoardId: "9062504443", stateColumnId: "dropdown_mm5ht9fz", consentColumnId: "dropdown_mm5rm7vc", phoneColumnIds: ["phone_mkqkk6nv", "phone_mkqk71tf"], stateSource: "rep_verified_controlled_state_dropdown", mode: "audit_only", recordingActionsPermitted: false });
  const receiverConfig = calls.find((x) => x && x.host); assert.equal(receiverConfig.host, "127.0.0.1"); assert.equal(receiverConfig.port, 8080); assert.equal("databaseUrl" in receiverConfig, false); assert.equal("mondayToken" in receiverConfig, false); assert.equal("ready" in receiverConfig.store, false); assert.equal(typeof receiverConfig.store.initialize, "function");
  await receiverConfig.store.initialize(); await receiverConfig.store.claim(); await receiverConfig.store.finalize(); await receiverConfig.store.release();
});

test("startup consumes an eager rejected ready promise, fails redacted, closes store, and never binds", async () => {
  let starts = 0; let closes = 0;
  const rejectedReady = Promise.reject(new Error("unreachable database details"));
  const runtime = createAuditOnlyRuntime({ env, createStore: () => ({ ready: rejectedReady, initialize: async () => {}, close: async () => { closes += 1; }, claim: async () => {}, finalize: async () => {}, release: async () => {} }), createReceiver: () => ({ start: async () => { starts += 1; }, close: async () => {} }), fetchImpl: async () => response(nativeBody()) });
  await assert.rejects(startAuditOnlyRuntime(runtime, { startupTimeoutMs: 100 }), (error) => error.message === "audit_runtime_startup_failed");
  assert.equal(starts, 0); assert.equal(closes, 1);
});

test("SIGTERM and SIGINT share testable shutdown: receiver closes before store", async () => {
  const processLike = new EventEmitter(); const order = [];
  const shutdown = installAuditOnlyShutdown({ receiver: { close: async () => { order.push("receiver"); return false; } }, store: { close: async () => { order.push("store"); } }, processLike });
  await Promise.all([shutdown.stop(), shutdown.stop()]); assert.deepEqual(order, ["receiver", "store"]);
  processLike.emit("SIGTERM"); await new Promise((resolve) => setImmediate(resolve)); assert.equal(processLike.exitCode, 0);
});

test("runtime source has no recording client import or dotenv loader", async () => {
  const source = await readFile(new URL("./audit-only-runtime.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /(?:from\s+["']\.\/aircall-recording-client|import\s*\([^)]*aircall-recording-client)/); assert.doesNotMatch(source, /(?:from\s+["']dotenv|import\s*\([^)]*dotenv|config\s*\(\s*\))/);
});
