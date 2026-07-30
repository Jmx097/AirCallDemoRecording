import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { normalizeAuthenticatedAircallRecordingEvent, toDecisionServiceEvent } from "./aircall-recording-event.mjs";

const TOKEN = "aircall-webhook-token_Example-42";
const ROTATED_TOKEN = "aircall-webhook-token_Rotated-99";
const CALL_ID = "call-abc:123";
const PHONE = "15551234567";
const input = (payload, overrides = {}) => ({ payloadJson: JSON.stringify(payload), expectedWebhookToken: TOKEN, ...overrides });
const call = (overrides = {}) => ({ id: CALL_ID, raw_digits: PHONE, ...overrides });
const envelope = (location = "data", overrides = {}) => {
  const payload = { token: TOKEN, event: "call.answered" };
  if (location === "data") payload.data = call();
  if (location === "nested") payload.data = { call: call() };
  if (location === "root") payload.call = call();
  return { ...payload, ...overrides };
};

function accepted(payload, overrides) {
  return normalizeAuthenticatedAircallRecordingEvent(input(payload, overrides));
}

const rejectedReasons = new Set(["invalid_configuration", "invalid_payload", "unauthenticated", "invalid_event", "unsupported_event", "invalid_call"]);
function assertRejected(result, reason) {
  assert.deepEqual(Object.keys(result), ["accepted", "reason"]);
  assert.equal(result.accepted, false);
  assert.ok(rejectedReasons.has(result.reason));
  if (reason) assert.equal(result.reason, reason);
}

test("authenticates raw JSON and normalizes only the observed direct payload.data call", () => {
  const result = accepted(envelope("data"));
  assert.equal(result.accepted, true);
  assert.deepEqual(Object.keys(result), ["accepted", "eventName", "callId", "phoneDigits", "eventKey", "correlation"]);
  assert.equal(result.eventName, "call.answered");
  assert.equal(result.callId, CALL_ID);
  assert.equal(result.phoneDigits, PHONE);
  assert.match(result.eventKey, /^[a-f0-9]{64}$/);
  assert.equal(result.correlation, result.eventKey.slice(0, 24));

  for (const location of ["nested", "root"]) assertRejected(accepted(envelope(location)), "invalid_call");
});

test("token failures have one redacted unauthenticated outcome", () => {
  for (const payload of [
    { event: "call.answered", data: call() },
    envelope("data", { token: "wrong-token" }),
    envelope("data", { token: 42 }),
    envelope("data", { token: "x".repeat(2049) }),
  ]) assertRejected(accepted(payload), "unauthenticated");

  const shortMismatch = accepted(envelope("data", { token: "x" }));
  const longMismatch = accepted(envelope("data", { token: "x".repeat(2048) }));
  assert.deepEqual(shortMismatch, longMismatch);
});

test("only explicitly allowlisted event identifiers are accepted", () => {
  assertRejected(accepted(envelope("data", { event: "call.started" })), "unsupported_event");
  assertRejected(accepted(envelope("data", { event: "call answered" })), "invalid_event");
  assert.equal(accepted(envelope("data", { event: "call.started" }), { allowedEvents: ["call.started"] }).accepted, true);
  for (const allowedEvents of [[], ["call.answered", "call.answered"], ["bad event"], Array.from({ length: 17 }, (_, i) => `event${i}`), "call.answered"]) {
    assertRejected(accepted(envelope("data"), { allowedEvents }), "invalid_configuration");
  }
});

test("requires a raw bounded JSON string and has no parser error leakage", () => {
  for (const payloadJson of [null, {}, []]) {
    assertRejected(normalizeAuthenticatedAircallRecordingEvent({ payloadJson, expectedWebhookToken: TOKEN }), "invalid_configuration");
  }
  for (const payloadJson of ["{", "null", "[]", "x".repeat(128 * 1024 + 1)]) {
    const result = normalizeAuthenticatedAircallRecordingEvent({ payloadJson, expectedWebhookToken: TOKEN });
    assertRejected(result, "invalid_payload");
    assert.doesNotMatch(JSON.stringify(result), /token|secret|SyntaxError/i);
  }
});

test("rejects unverified alternate, excessive, and malformed call envelopes", () => {
  assertRejected(accepted({ token: TOKEN, event: "call.answered", data: { call: call() } }), "invalid_call");
  assertRejected(accepted({ token: TOKEN, event: "call.answered", call: call() }), "invalid_call");
  assertRejected(accepted({ ...envelope("data"), call: call() }), "invalid_call");
  assertRejected(accepted({ token: TOKEN, event: "call.answered", data: { ...call(), call: call() } }), "invalid_call");
  assertRejected(accepted({ token: TOKEN, event: "call.answered", data: { id: CALL_ID } }), "invalid_call");
  assertRejected(accepted({ token: TOKEN, event: "call.answered", data: Array.from({ length: 65 }, () => 1) }), "invalid_call");
  assertRejected(accepted(Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`key${index}`, index]))), "invalid_payload");
});

test("requires safe call IDs and exact 10-15 ASCII raw digits without normalization", () => {
  for (const malformed of [
    { id: "" }, { id: "bad id" }, { id: "a".repeat(129) }, { id: 1 },
    { raw_digits: "555-123-4567" }, { raw_digits: "+155****4567" }, { raw_digits: "555123456" },
    { raw_digits: "1".repeat(16) }, { raw_digits: 15551234567 },
  ]) assertRejected(accepted({ token: TOKEN, event: "call.answered", data: call(malformed) }), "invalid_call");
});

test("event key is token-keyed opaque audit correlation, stable for phone changes, and rotates with the token", () => {
  const first = accepted(envelope("data"));
  const changedPhone = accepted({ token: TOKEN, event: "call.answered", data: call({ raw_digits: "4415551234567" }) });
  const rotated = normalizeAuthenticatedAircallRecordingEvent(input(
    { token: ROTATED_TOKEN, event: "call.answered", data: call() },
    { expectedWebhookToken: ROTATED_TOKEN },
  ));
  const structuralInput = `aircall-recording-v1\0call.answered\0${CALL_ID}`;
  const expected = createHmac("sha256", TOKEN).update(structuralInput, "utf8").digest("hex");
  const unkeyedHash = createHash("sha256").update(structuralInput, "utf8").digest("hex");
  assert.equal(first.eventKey, expected);
  assert.equal(first.eventKey, changedPhone.eventKey);
  assert.notEqual(first.phoneDigits, changedPhone.phoneDigits);
  assert.notEqual(first.eventKey, rotated.eventKey);
  assert.notEqual(first.eventKey, unkeyedHash);
  assert.equal(first.correlation, first.eventKey.slice(0, 24));
  assert.doesNotMatch(first.eventKey, /15551234567|aircall-webhook-token/i);
});

test("configuration getters and proxies fail closed without exposing their errors", () => {
  const getterConfig = { payloadJson: JSON.stringify(envelope("data")), get expectedWebhookToken() { throw new Error("secret-token"); } };
  const proxyConfig = new Proxy({}, { getPrototypeOf() { throw new Error("secret-proxy"); } });
  assertRejected(normalizeAuthenticatedAircallRecordingEvent(getterConfig), "invalid_configuration");
  assertRejected(normalizeAuthenticatedAircallRecordingEvent(proxyConfig), "invalid_configuration");
});

test("decision bridge returns only minimal accepted normalized data", () => {
  const normalized = accepted(envelope("data"));
  assert.deepEqual(toDecisionServiceEvent(normalized), {
    eventKey: normalized.eventKey, callId: CALL_ID, phoneDigits: PHONE, correlation: normalized.correlation,
  });
  assert.equal(toDecisionServiceEvent({ accepted: true, eventKey: "a".repeat(64), callId: CALL_ID, phoneDigits: PHONE, correlation: "wrong" }), null);
  assert.equal(toDecisionServiceEvent({ accepted: false }), null);
  assert.equal(toDecisionServiceEvent(new Proxy({}, { getPrototypeOf() { throw new Error("secret"); } })), null);
});
