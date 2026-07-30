import http from "node:http";
import { TextDecoder } from "node:util";
import { normalizeAuthenticatedAircallRecordingEvent, toDecisionServiceEvent } from "./aircall-recording-event.mjs";
import { createMondayCallbackAdapter } from "./monday-callback-adapter.mjs";
import { createConsentDecisionService } from "./consent-decision-service.mjs";

const MAX_BODY_BYTES = 128 * 1024;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const MAX_IN_FLIGHT = 32;
const DEFAULT_MAX_IN_FLIGHT = 32;
const DEFAULT_READINESS_TIMEOUT_MS = 250;
const MAX_READINESS_TIMEOUT_MS = 1_000;
const SERVER_REQUEST_TIMEOUT_MS = 5_000;
const SERVER_HEADERS_TIMEOUT_MS = 5_000;
const SERVER_KEEP_ALIVE_TIMEOUT_MS = 1_000;
const SERVER_MAX_HEADER_BYTES = 8 * 1024;
const SERVER_MAX_REQUESTS_PER_SOCKET = 16;
const ALLOWED_REASONS = new Set([
  "audit_only_eligible_one_party_state", "not_one_party_state", "invalid_state", "invalid_ruleset",
  "resolver_not_found", "resolver_not_unique", "resolver_denied",
]);
const CONFIG_KEYS = new Set([
  "expectedWebhookToken", "canonicalBoardId", "stateColumnId", "consentColumnId", "phoneColumnIds", "stateSource", "mondayQuery",
  "store", "ruleset", "approvedRulesetVersions", "allowedPhoneColumnTypes", "host", "port", "maxBodyBytes",
  "shutdownTimeoutMs", "maxInFlight", "readinessTimeoutMs",
]);

/** Creates an explicitly loopback-only, unprovisioned audit ingress. */
export function createAuditOnlyReceiver(config) {
  const safe = snapshotConfig(config);
  if (!safe) throw new TypeError("invalid_audit_only_receiver_config");

  let monday; let decisionService;
  try {
    monday = createMondayCallbackAdapter({
      canonicalBoardId: safe.canonicalBoardId, stateColumnId: safe.stateColumnId, consentColumnId: safe.consentColumnId, phoneColumnIds: safe.phoneColumnIds,
      stateSource: safe.stateSource, query: safe.mondayQuery, ...(safe.allowedPhoneColumnTypes ? { allowedPhoneColumnTypes: safe.allowedPhoneColumnTypes } : {}),
    });
    decisionService = createConsentDecisionService({
      store: safe.store, canonicalBoardId: safe.canonicalBoardId, stateSource: safe.stateSource, ruleset: safe.ruleset,
      approvedRulesetVersions: safe.approvedRulesetVersions,
      getConsentLeadById: monday.getConsentLeadById, findConsentLeadsByPhone: monday.findConsentLeadsByPhone,
    });
  } catch { throw new TypeError("invalid_audit_only_receiver_config"); }

  let closing = false;
  let started = false;
  let binding = null;
  let inFlight = 0;
  let readinessCheck = null;
  const sockets = new Set();
  const waiters = new Set();
  const server = http.createServer({ maxHeaderSize: SERVER_MAX_HEADER_BYTES }, (request, response) => { void handle(request, response); });
  server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS;
  server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = SERVER_KEEP_ALIVE_TIMEOUT_MS;
  server.maxRequestsPerSocket = SERVER_MAX_REQUESTS_PER_SOCKET;
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });

  async function handle(request, response) {
    if (closing) return rejectRequest(request, response, 503, { ok: false });
    // Health/readiness probes are bounded separately from audit-event capacity.
    // A slow dependency probe must never consume a scarce webhook work slot.
    if (request.method === "GET" && request.url === "/health") return send(response, 200, { ok: true, service: "timberline-audit-only-receiver", mode: "audit_only" });
    if (request.method === "GET" && request.url === "/ready") return await ready(response);
    if (inFlight >= safe.maxInFlight) return rejectRequest(request, response, 429, { accepted: false, error: "too_many_requests" });
    inFlight += 1;
    try {
      if (request.method !== "POST" || request.url !== "/aircall/recording/audit-events") return rejectRequest(request, response, 404, { error: "not_found" });
      if (!jsonContentType(request.headers["content-type"])) return rejectRequest(request, response, 415, { accepted: false, error: "unsupported_media_type" });
      if (contentLengthTooLarge(request.headers["content-length"], safe.maxBodyBytes)) return rejectRequest(request, response, 413, { accepted: false, error: "payload_too_large" });
      const body = await readBody(request, safe.maxBodyBytes);
      if (body.kind === "too_large") return rejectRequest(request, response, 413, { accepted: false, error: "payload_too_large" });
      if (body.kind !== "ok") return rejectRequest(request, response, 400, { accepted: false, error: "invalid_event" });
      let payloadJson;
      try { payloadJson = new TextDecoder("utf-8", { fatal: true }).decode(body.value); } catch { return send(response, 400, { accepted: false, error: "invalid_event" }); }
      const normalized = normalizeAuthenticatedAircallRecordingEvent({ payloadJson, expectedWebhookToken: safe.expectedWebhookToken });
      if (!normalized.accepted) return send(response, normalized.reason === "unauthenticated" ? 401 : 400,
        { accepted: false, error: normalized.reason === "unauthenticated" ? "unauthenticated" : "invalid_event" });
      const event = toDecisionServiceEvent(normalized);
      if (!event) return send(response, 400, { accepted: false, error: "invalid_event" });
      const result = await decisionService.process({ eventKey: event.eventKey, callId: event.callId, phoneDigits: event.phoneDigits });
      const publicResult = publicDecision(result);
      return send(response, publicResult.status, publicResult.body);
    } catch {
      return send(response, 503, { accepted: false, reason: "dependency_failure" });
    } finally {
      inFlight -= 1;
      if (inFlight === 0) { for (const wake of waiters) wake(); waiters.clear(); }
    }
  }

  async function ready(response) {
    const readiness = safe.ready || safe.initialize;
    if (typeof readiness !== "function") return send(response, 503, { ok: false });
    // Concurrent requests join one bounded attempt. A completed attempt is not cached:
    // a later /ready is a recheck, never a claim about external integrations.
    if (!readinessCheck) readinessCheck = boundedReadiness(readiness);
    const readyNow = await readinessCheck;
    return send(response, readyNow ? 200 : 503, readyNow ? { ok: true, mode: "audit_only", readiness: "injected_store_ready" } : { ok: false });
  }

  function boundedReadiness(readiness) {
    // A deadline bounds the HTTP probe, but cannot cancel an arbitrary injected
    // dependency promise. Keep its failed shared result until that dependency
    // actually settles; otherwise repeated /ready calls could create unlimited
    // permanently pending probes.
    const dependency = Promise.resolve().then(() => readiness.call(safe.store)).then(() => true, () => false);
    const deadline = new Promise((resolve) => setTimeout(() => resolve(false), safe.readinessTimeoutMs));
    const shared = Promise.race([dependency, deadline]);
    readinessCheck = shared;
    void dependency.then(() => { if (readinessCheck === shared) readinessCheck = null; });
    return shared;
  }

  function start() {
    if (closing || started || binding) return Promise.reject(new Error("receiver_not_startable"));
    binding = new Promise((resolve, reject) => {
      const fail = (error) => { server.off("listening", listening); reject(error); };
      const listening = () => {
        server.off("error", fail);
        if (closing) { resolve(null); return; }
        started = true;
        const address = server.address();
        resolve(Object.freeze({ address: typeof address === "object" && address ? address.address : safe.host, port: typeof address === "object" && address ? address.port : safe.port }));
      };
      server.once("error", fail);
      server.once("listening", listening);
      server.listen(safe.port, safe.host);
    });
    return binding.then((address) => {
      if (!address) throw new Error("receiver_not_startable");
      return address;
    }, (error) => { throw error; });
  }

  async function close() {
    closing = true;
    // listen() is asynchronous. Do not observe server.listening until its binding
    // settles, otherwise close() can return while that binding starts accepting.
    if (binding) { try { await binding; } catch { /* no listener was established */ } }
    const closingServer = server.listening ? new Promise((resolve) => server.close(resolve)) : Promise.resolve();
    if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
    const drained = await waitForRequests();
    if (!drained) for (const socket of sockets) socket.destroy();
    await closingServer;
    return drained;
  }

  function waitForRequests() {
    if (inFlight === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { waiters.delete(done); resolve(false); }, safe.shutdownTimeoutMs);
      const done = () => { clearTimeout(timer); resolve(true); };
      waiters.add(done);
    });
  }

  return Object.freeze({ start, close });
}

function snapshotConfig(config) {
  try {
    if (!plainRecord(config) || Object.getOwnPropertySymbols(config).length) return null;
    const names = Object.getOwnPropertyNames(config);
    if (names.some((name) => !CONFIG_KEYS.has(name))) return null;
    const value = (name, optional = false) => {
      const descriptor = Object.getOwnPropertyDescriptor(config, name);
      if (!descriptor) return optional ? undefined : null;
      if (!("value" in descriptor)) throw new Error("getter");
      return descriptor.value;
    };
    const required = ["expectedWebhookToken", "canonicalBoardId", "stateColumnId", "consentColumnId", "phoneColumnIds", "stateSource", "mondayQuery", "store", "ruleset", "approvedRulesetVersions"];
    if (required.some((name) => value(name) == null)) return null;
    const expectedWebhookToken = value("expectedWebhookToken"); const canonicalBoardId = value("canonicalBoardId"); const stateColumnId = value("stateColumnId"); const consentColumnId = value("consentColumnId"); const stateSource = value("stateSource");
    const phoneColumnIds = value("phoneColumnIds"); const mondayQuery = value("mondayQuery"); const store = value("store"); const ruleset = value("ruleset"); const approvedRulesetVersions = value("approvedRulesetVersions");
    const allowedPhoneColumnTypes = value("allowedPhoneColumnTypes", true); const host = value("host", true) ?? "127.0.0.1"; const port = value("port", true) ?? 0; const maxBodyBytes = value("maxBodyBytes", true) ?? MAX_BODY_BYTES; const shutdownTimeoutMs = value("shutdownTimeoutMs", true) ?? DEFAULT_SHUTDOWN_TIMEOUT_MS; const maxInFlight = value("maxInFlight", true) ?? DEFAULT_MAX_IN_FLIGHT; const readinessTimeoutMs = value("readinessTimeoutMs", true) ?? DEFAULT_READINESS_TIMEOUT_MS;
    if (![expectedWebhookToken, canonicalBoardId, stateColumnId, consentColumnId, stateSource].every((x) => typeof x === "string" && x.length > 0)
      || !plainArray(phoneColumnIds) || typeof mondayQuery !== "function" || !plainRecord(store) || !plainRecord(ruleset) || !(approvedRulesetVersions instanceof Set)
      || !["127.0.0.1", "::1"].includes(host) || !Number.isInteger(port) || port < 0 || port > 65535
      || !Number.isInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > MAX_BODY_BYTES
      || !Number.isInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1 || shutdownTimeoutMs > DEFAULT_SHUTDOWN_TIMEOUT_MS
      || !Number.isInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > MAX_IN_FLIGHT
      || !Number.isInteger(readinessTimeoutMs) || readinessTimeoutMs < 10 || readinessTimeoutMs > MAX_READINESS_TIMEOUT_MS) return null;
    if (allowedPhoneColumnTypes !== undefined && !plainArray(allowedPhoneColumnTypes)) return null;
    for (const method of ["claim", "finalize", "release"]) if (typeof ownData(store, method) !== "function") return null;
    const ready = ownData(store, "ready"); const initialize = ownData(store, "initialize");
    if (ready !== undefined && typeof ready !== "function") return null;
    if (initialize !== undefined && typeof initialize !== "function") return null;
    return Object.freeze({ expectedWebhookToken, canonicalBoardId, stateColumnId, consentColumnId, phoneColumnIds: Object.freeze([...phoneColumnIds]), stateSource, mondayQuery, store, ruleset, approvedRulesetVersions, allowedPhoneColumnTypes: allowedPhoneColumnTypes && Object.freeze([...allowedPhoneColumnTypes]), host, port, maxBodyBytes, shutdownTimeoutMs, maxInFlight, readinessTimeoutMs, ready, initialize });
  } catch { return null; }
}
function plainRecord(value) { return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype; }
function plainArray(value) { return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype; }
function ownData(object, key) { const descriptor = Object.getOwnPropertyDescriptor(object, key); return descriptor && "value" in descriptor ? descriptor.value : undefined; }
function jsonContentType(value) { return typeof value === "string" && /^\s*application\/json\s*(?:;\s*charset\s*=\s*utf-8\s*)?$/i.test(value); }
function contentLengthTooLarge(value, limit) { return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value) && Number(value) > limit; }
function send(response, status, body, close = false) { if (!response.writableEnded) { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(close ? { connection: "close" } : {}) }); response.end(JSON.stringify(body)); } }
function rejectRequest(request, response, status, body) {
  request.resume();
  response.once("finish", () => request.socket.destroy());
  send(response, status, body, true);
}
function readBody(request, limit) {
  return new Promise((resolve) => {
    let size = 0; const chunks = []; let settled = false;
    const done = (result) => { if (!settled) { settled = true; cleanup(); resolve(result); } };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) return done({ kind: "too_large" });
      chunks.push(chunk);
    };
    const onEnd = () => done({ kind: "ok", value: Buffer.concat(chunks) });
    const onError = () => done({ kind: "stream_error" });
    const onAborted = () => done({ kind: "stream_error" });
    const cleanup = () => { request.off("data", onData); request.off("end", onEnd); request.off("error", onError); request.off("aborted", onAborted); };
    request.on("data", onData); request.once("end", onEnd); request.once("error", onError); request.once("aborted", onAborted);
  });
}
function publicDecision(result) {
  try {
    if (!plainRecord(result)) return { status: 503, body: { accepted: false, reason: "dependency_failure" } };
    const outcome = ownData(result, "outcome"); const reason = ownData(result, "reason");
    if (outcome === "duplicate" && reason === "already_claimed_or_completed") return { status: 202, body: { accepted: true, duplicate: true } };
    if (outcome === "left_disabled" && reason === "dependency_failure") return { status: 503, body: { accepted: false, reason: "dependency_failure" } };
    if (outcome === "left_disabled" && ALLOWED_REASONS.has(reason)) return { status: 202, body: { accepted: true, outcome: "left_disabled", reason } };
  } catch { /* fail closed */ }
  return { status: 503, body: { accepted: false, reason: "dependency_failure" } };
}
