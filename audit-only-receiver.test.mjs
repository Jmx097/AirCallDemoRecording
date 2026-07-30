import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { createAuditOnlyReceiver } from "./audit-only-receiver.mjs";

const TOKEN = "test-webhook-token";
const PHONE = "15551234567";
const CALL = "call-local-1";
const baseRules = { version: "receiver-v1", states: { TX: true } };

function item() { return { id: "lead-1", board: { id: "board-1" }, column_values: [{ id: "state", text: "TX", type: "status" }, { id: "phone", text: PHONE, type: "phone" }] }; }
function fakeStore(overrides = {}) {
  const calls = { claim: [], finalize: [], release: [], ready: 0, close: 0 };
  const seen = new Set();
  const store = {
    async claim(key) { calls.claim.push(key); if (seen.has(key)) return { claimed: false, key }; seen.add(key); return { claimed: true, key, leaseToken: "lease-1" }; },
    async finalize(claim, outcome, metadata) { calls.finalize.push({ claim, outcome, metadata }); },
    async release(claim) { calls.release.push(claim); },
    async ready() { calls.ready++; },
    async close() { calls.close++; },
    ...overrides,
  };
  return { store, calls };
}
function config(overrides = {}) {
  const fake = fakeStore(); let queries = 0;
  return { fake, get queries() { return queries; }, value: {
    expectedWebhookToken: TOKEN, canonicalBoardId: "board-1", stateColumnId: "state", phoneColumnIds: ["phone"], stateSource: "rep_verified_controlled_state_dropdown",
    mondayQuery(request) { queries++; assert.match(request.query, /ReadCanonicalBoardPage/); return { data: { boards: [{ id: "board-1", items_page: { cursor: null, items: [item()] } }] } }; },
    store: fake.store, ruleset: baseRules, approvedRulesetVersions: new Set(["receiver-v1"]), ...overrides,
  } };
}
function payload(overrides = {}) { return JSON.stringify({ token: TOKEN, event: "call.answered", data: { id: CALL, raw_digits: PHONE }, ...overrides }); }
async function running(overrides = {}) { const made = config(overrides); const receiver = createAuditOnlyReceiver(made.value); const address = await receiver.start(); return { ...made, receiver, url: `http://127.0.0.1:${address.port}` }; }
async function request(base, path, options = {}) { const response = await fetch(base + path, options); return { response, body: await response.json() }; }
function post(base, body = payload(), headers = { "content-type": "application/json" }) { return request(base, "/aircall/recording/audit-events", { method: "POST", headers, body }); }
function assertNoSensitive(body) { const text = JSON.stringify(body); for (const secret of [TOKEN, PHONE, CALL]) assert.equal(text.includes(secret), false); }
function rawRequest(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }); let received = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("raw_socket_timeout")); }, 1_000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(text));
    socket.on("data", (chunk) => { received += chunk; });
    socket.on("close", () => { clearTimeout(timer); resolve(received); });
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
}
function unusedLoopbackPort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => { const { port } = socket.address(); socket.close((error) => error ? reject(error) : resolve(port)); });
  });
}
function connectFails(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(true));
  });
}

test("health is local fixed data and construction performs no request or store work", async () => {
  const made = config(); const receiver = createAuditOnlyReceiver(made.value);
  assert.deepEqual(Object.keys(receiver).sort(), ["close", "start"]);
  assert.equal("server" in receiver, false);
  assert.equal(made.queries, 0); assert.equal(made.fake.calls.claim.length, 0); assert.equal(made.fake.calls.ready, 0);
  const address = await receiver.start(); const { response, body } = await request(`http://127.0.0.1:${address.port}`, "/health");
  assert.equal(response.status, 200); assert.deepEqual(body, { ok: true, service: "timberline-audit-only-receiver", mode: "audit_only" }); await receiver.close();
});

test("routes, methods, and media type fail closed without sensitive reflection", async () => {
  const run = await running();
  for (const [path, options, status] of [["/other", {}, 404], ["/aircall/recording/audit-events", {}, 404], ["/aircall/recording/audit-events", { method: "POST", body: payload() }, 415], ["/aircall/recording/audit-events", { method: "POST", headers: { "content-type": "text/plain" }, body: payload() }, 415]]) {
    const { response, body } = await request(run.url, path, options); assert.equal(response.status, status); assertNoSensitive(body);
  }
  assert.equal(run.fake.calls.claim.length, 0); await run.receiver.close();
});

test("authentication, malformed body, body limit, and valid audit finalization are bounded", async () => {
  const run = await running({ maxBodyBytes: 128 });
  let got = await post(run.url, JSON.stringify({ token: "wrong-token", event: "call.answered", data: { id: CALL, raw_digits: PHONE } })); assert.equal(got.response.status, 401); assertNoSensitive(got.body);
  got = await post(run.url, "{"); assert.equal(got.response.status, 400); assert.deepEqual(got.body, { accepted: false, error: "invalid_event" });
  got = await post(run.url, "x".repeat(129)); assert.equal(got.response.status, 413);
  got = await post(run.url); assert.equal(got.response.status, 202); assert.deepEqual(got.body, { accepted: true, outcome: "left_disabled", reason: "audit_only_eligible_one_party_state" }); assertNoSensitive(got.body);
  assert.equal(run.fake.calls.finalize.length, 1); const [{ claim, outcome, metadata }] = run.fake.calls.finalize;
  assert.match(claim.key, /^[a-f0-9]{64}$/); assert.deepEqual(outcome, { outcome: "left_disabled", reason: "audit_only_eligible_one_party_state" }); assert.deepEqual(Object.keys(metadata), ["correlation"]);
  assert.equal(JSON.stringify(metadata).includes(PHONE), false); assert.equal(JSON.stringify(metadata).includes(CALL), false); await run.receiver.close();
});

test("duplicates and dependency failures have allowlisted responses", async () => {
  const run = await running();
  assert.equal((await post(run.url)).response.status, 202); const duplicate = await post(run.url); assert.equal(duplicate.response.status, 202); assert.deepEqual(duplicate.body, { accepted: true, duplicate: true }); assertNoSensitive(duplicate.body); await run.receiver.close();
  const failed = await running({ store: fakeStore({ async claim() { throw new Error("secret failure"); } }).store }); const response = await post(failed.url); assert.equal(response.response.status, 503); assert.deepEqual(response.body, { accepted: false, reason: "dependency_failure" }); await failed.receiver.close();
});

test("ready is deferred, bounded, masked on failure, and injected store is never closed", async () => {
  const run = await running(); let result = await request(run.url, "/ready"); assert.equal(result.response.status, 200); assert.deepEqual(result.body, { ok: true, mode: "audit_only", readiness: "injected_store_ready" }); assert.equal(run.fake.calls.ready, 1); await run.receiver.close(); assert.equal(run.fake.calls.close, 0);
  const bad = await running({ store: fakeStore({ async ready() { throw new Error("credential"); } }).store }); result = await request(bad.url, "/ready"); assert.equal(result.response.status, 503); assert.deepEqual(result.body, { ok: false }); await bad.receiver.close();
});

test("hanging concurrent readiness joins one short attempt and does not occupy audit capacity", async () => {
  let calls = 0;
  const run = await running({ maxInFlight: 1, readinessTimeoutMs: 25, store: fakeStore({ async ready() { calls++; return new Promise(() => {}); } }).store });
  const [first, second] = await Promise.all([request(run.url, "/ready"), request(run.url, "/ready")]);
  for (const result of [first, second]) { assert.equal(result.response.status, 503); assert.deepEqual(result.body, { ok: false }); }
  // A timed-out adapter stays fail-closed until it actually settles; repeated
  // probes must join the same failed result instead of spawning more hangs.
  const later = await request(run.url, "/ready"); assert.equal(later.response.status, 503);
  assert.equal(calls, 1);
  assert.equal((await request(run.url, "/health")).response.status, 200);
  await run.receiver.close();
});

test("constructor rejects public hosts, getters, unknown keys, and proxies", () => {
  for (const extra of [{ host: "0.0.0.0" }, { unexpected: true }]) assert.throws(() => createAuditOnlyReceiver({ ...config().value, ...extra }), TypeError);
  const getter = { ...config().value }; Object.defineProperty(getter, "host", { enumerable: true, get() { return "127.0.0.1"; } });
  assert.throws(() => createAuditOnlyReceiver(getter), TypeError);
  assert.throws(() => createAuditOnlyReceiver(new Proxy(config().value, { getPrototypeOf() { throw new Error("no"); } })), TypeError);
});

test("close denies new work while draining an in-flight audit request", async () => {
  let release; const pending = new Promise((resolve) => { release = resolve; });
  const run = await running({ mondayQuery() { return pending; }, shutdownTimeoutMs: 1_000 });
  const inFlight = post(run.url); await new Promise((resolve) => setTimeout(resolve, 10));
  const closing = run.receiver.close();
  // close() immediately stops accepting new connections while allowing the
  // already-accepted request to drain.
  const refused = await fetch(run.url + "/health").then(() => false, () => true); assert.equal(refused, true);
  release({ data: { boards: [{ id: "board-1", items_page: { cursor: null, items: [item()] } }] } });
  assert.equal((await inFlight).response.status, 202); assert.equal(await closing, true);
});

test("bounded in-flight audit work returns 429 without processing excess requests", async () => {
  let release; let queryStarted;
  const pending = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { queryStarted = resolve; });
  const run = await running({ maxInFlight: 1, mondayQuery() { queryStarted(); return pending; } });
  const first = post(run.url);
  await started;
  const excess = await post(run.url, JSON.stringify({ token: TOKEN, event: "call.answered", data: { id: "call-excess", raw_digits: PHONE } }));
  assert.equal(excess.response.status, 429);
  assert.deepEqual(excess.body, { accepted: false, error: "too_many_requests" });
  release({ data: { boards: [{ id: "board-1", items_page: { cursor: null, items: [item()] } }] } });
  assert.equal((await first).response.status, 202);
  await run.receiver.close();
});

test("close waits for an in-progress bind and leaves its port non-accepting", async () => {
  const port = await unusedLoopbackPort();
  const made = config({ port }); const receiver = createAuditOnlyReceiver(made.value);
  const starting = receiver.start();
  assert.equal(await receiver.close(), true);
  await assert.rejects(starting, /receiver_not_startable/);
  assert.equal(await connectFails(port), true);
});

test("raw oversized and unfinished rejected requests are bounded, closed, and redacted", async () => {
  const run = await running({ maxBodyBytes: 32 }); const port = Number(new URL(run.url).port);
  const cases = [
    `POST /aircall/recording/audit-events HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 33\r\n\r\n`,
    `POST /aircall/recording/audit-events HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n21\r\n${"x".repeat(33)}\r\n`,
    "POST /other HTTP/1.1\r\nHost: localhost\r\nContent-Type: text/plain\r\nContent-Length: 999\r\n\r\npartial",
    "POST /aircall/recording/audit-events HTTP/1.1\r\nHost: localhost\r\nContent-Type: text/plain\r\nContent-Length: 999\r\n\r\npartial",
  ];
  const expected = [413, 413, 404, 415];
  for (let index = 0; index < cases.length; index++) {
    const response = await rawRequest(port, cases[index]);
    assert.match(response, new RegExp(`HTTP/1\\.1 ${expected[index]}`));
    assert.equal(response.includes(TOKEN), false); assert.equal(response.includes(PHONE), false); assert.equal(response.includes(CALL), false);
  }
  await run.receiver.close();
});
