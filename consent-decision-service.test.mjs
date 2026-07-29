import assert from "node:assert/strict";
import test from "node:test";
import { createConsentDecisionService } from "./consent-decision-service.mjs";

const BOARD = "canonical-board";
const SOURCE = "rep_verified_controlled_state_dropdown";
const PHONE = "15551234567";
const EVENT_KEY = "event-opaque-1";
const CALL_ID = "call-opaque-1";
const CREDENTIAL = "credential-must-not-leak";
const ruleset = { version: "test-v1", states: { TX: true, CA: false } };
const approvedRulesetVersions = new Set(["test-v1"]);
const json = (value) => JSON.stringify(value);
function lead(overrides = {}) { return { id: "lead-1", boardId: BOARD, phoneDigits: PHONE, state: { value: "TX", source: SOURCE, verified: true }, ...overrides }; }
function event(overrides = {}) { return { eventKey: EVENT_KEY, callId: CALL_ID, nativeItemId: "native-1", phoneDigits: PHONE, ...overrides }; }
function fakeStore(overrides = {}) {
  const calls = { claim: [], finalize: [], release: [] };
  const store = {
    async claim(key) { calls.claim.push(key); return { claimed: true, key, leaseToken: "lease-1" }; },
    async finalize(claim, outcome, correlation) { calls.finalize.push({ claim, outcome, correlation }); },
    async release(claim) { calls.release.push(claim); },
    ...overrides,
  };
  return { store, calls };
}
function service({ store, getConsentLeadById, findConsentLeadsByPhone } = {}) {
  return createConsentDecisionService({ store, canonicalBoardId: BOARD, stateSource: SOURCE, ruleset, approvedRulesetVersions,
    getConsentLeadById: getConsentLeadById || (async (id) => json(lead({ id }))),
    findConsentLeadsByPhone: findConsentLeadsByPhone || (async () => json([lead()])), });
}
function assertFinalizedAuditOnly(calls, expectedReason) {
  assert.deepEqual(calls.finalize.map(({ outcome }) => outcome), [{ outcome: "left_disabled", reason: expectedReason }]);
  assert.equal(calls.release.length, 0);
}

test("native JSON and unique-phone JSON fallback atomically finalize audit-only outcomes", async () => {
  const native = fakeStore();
  assert.deepEqual(await service({ store: native.store }).process(event()), { outcome: "left_disabled", reason: "audit_only_eligible_one_party_state" });
  assertFinalizedAuditOnly(native.calls, "audit_only_eligible_one_party_state");
  const phone = fakeStore(); let phoneLookups = 0;
  assert.deepEqual(await service({ store: phone.store, getConsentLeadById: async () => null, findConsentLeadsByPhone: async (digits) => { phoneLookups++; assert.equal(digits, PHONE); return json([lead({ id: "phone-lead" })]); } }).process(event({ nativeItemId: "missing-native" })), { outcome: "left_disabled", reason: "audit_only_eligible_one_party_state" });
  assert.equal(phoneLookups, 1); assertFinalizedAuditOnly(phone.calls, "audit_only_eligible_one_party_state");
});

test("duplicate claim performs no resolver or finalization", async () => {
  const { store, calls } = fakeStore({ async claim() { calls.claim.push("claimed"); return { claimed: false, key: EVENT_KEY }; } });
  let resolverCalls = 0;
  assert.deepEqual(await service({ store, getConsentLeadById: async () => { resolverCalls++; return json(lead()); } }).process(event()), { outcome: "duplicate", reason: "already_claimed_or_completed" });
  assert.equal(resolverCalls, 0); assert.equal(calls.finalize.length, 0); assert.equal(calls.release.length, 0);
});

test("invalid, getter-backed, ownKeys-proxy, and getPrototypeOf-proxy events never reject or touch store", async () => {
  const { store, calls } = fakeStore();
  const getterEvent = { eventKey: EVENT_KEY, callId: CALL_ID, get phoneDigits() { throw new Error(CREDENTIAL); } };
  const ownKeysProxy = new Proxy(event(), { ownKeys() { throw new Error(CREDENTIAL); } });
  const prototypeProxy = new Proxy(event(), { getPrototypeOf() { throw new Error(CREDENTIAL); } });
  for (const malformed of [null, [], { eventKey: EVENT_KEY, callId: CALL_ID }, { ...event(), extra: "no" }, getterEvent, ownKeysProxy, prototypeProxy]) {
    const result = await service({ store }).process(malformed);
    assert.deepEqual(result, { outcome: "left_disabled", reason: "invalid_event" });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(CREDENTIAL));
  }
  assert.equal(calls.claim.length, 0);
});

test("resolver failures release processing claims and do not finalize", async () => {
  for (const scenario of [async () => { throw new Error(CREDENTIAL); }, async () => null]) {
    const fake = fakeStore();
    const result = await service({ store: fake.store, getConsentLeadById: scenario, findConsentLeadsByPhone: async () => { throw new Error(CREDENTIAL); } }).process(event());
    assert.deepEqual(result, { outcome: "left_disabled", reason: "dependency_failure" });
    assert.equal(fake.calls.release.length, 1); assert.equal(fake.calls.finalize.length, 0);
  }
});

test("malformed resolver data is controlled and atomically finalized", async () => {
  const fake = fakeStore();
  assert.deepEqual(await service({ store: fake.store, getConsentLeadById: async () => "not json" }).process(event()), { outcome: "left_disabled", reason: "resolver_denied" });
  assertFinalizedAuditOnly(fake.calls, "resolver_denied");
});

test("hostile claim result with a safely snapshotable lease becomes redacted dependency failure and releases", async () => {
  const hostile = new Proxy({ claimed: true, key: EVENT_KEY, leaseToken: "lease-1" }, { getPrototypeOf() { throw new Error(CREDENTIAL); } });
  const fake = fakeStore({ async claim() { return hostile; } });
  const result = await service({ store: fake.store }).process(event());
  assert.deepEqual(result, { outcome: "left_disabled", reason: "dependency_failure" });
  assert.deepEqual(fake.calls.release, [{ claimed: true, key: EVENT_KEY, leaseToken: "lease-1" }]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(CREDENTIAL));
});

test("hostile claim result without safe lease fields does not reject, leak, or attempt unsafe release", async () => {
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error(CREDENTIAL); }, getOwnPropertyDescriptor() { throw new Error(CREDENTIAL); } });
  const fake = fakeStore({ async claim() { return hostile; } });
  assert.deepEqual(await service({ store: fake.store }).process(event()), { outcome: "left_disabled", reason: "dependency_failure" });
  assert.equal(fake.calls.release.length, 0);
});

test("construction snapshots descriptors and masks hostile Proxy errors as stable TypeError", async () => {
  assert.throws(() => createConsentDecisionService({}), { name: "TypeError", message: "A valid injected decision-service store is required" });
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error(CREDENTIAL); } });
  assert.throws(() => createConsentDecisionService(hostile), { name: "TypeError", message: "A valid injected decision-service store is required" });
  const fake = fakeStore(); const svc = service({ store: fake.store });
  fake.store.finalize = () => { throw new Error("mutable post-construction method read"); };
  assert.deepEqual(await svc.process(event()), { outcome: "left_disabled", reason: "audit_only_eligible_one_party_state" });
  assert.equal(fake.calls.finalize.length, 1);
});

test("finalize receives only bounded outcome/reason and correlation hash, never event/phone/raw secrets", async () => {
  const fake = fakeStore(); const raw = json({ phoneDigits: PHONE, credential: CREDENTIAL, eventKey: EVENT_KEY });
  assert.deepEqual(await service({ store: fake.store, getConsentLeadById: async () => raw }).process(event()), { outcome: "left_disabled", reason: "resolver_denied" });
  const [{ claim, outcome, correlation }] = fake.calls.finalize;
  assert.deepEqual(claim, { claimed: true, key: EVENT_KEY, leaseToken: "lease-1" });
  assert.deepEqual(outcome, { outcome: "left_disabled", reason: "resolver_denied" });
  assert.deepEqual(Object.keys(correlation), ["correlation"]); assert.match(correlation.correlation, /^[a-f0-9]{24}$/);
  const observable = JSON.stringify({ outcome, correlation });
  for (const forbidden of [PHONE, EVENT_KEY, CALL_ID, CREDENTIAL, raw]) assert.doesNotMatch(observable, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("finalize cannot alias or alter the returned audit-only decision", async () => {
  let passedOutcome;
  const fake = fakeStore({
    async finalize(_claim, outcome, metadata) {
      passedOutcome = outcome;
      // Reflect.set does not throw on a frozen record, allowing us to verify
      // the normal-success path as well as isolation from this adapter.
      assert.equal(Reflect.set(outcome, "outcome", "recording_enabled"), false);
      assert.equal(Reflect.set(outcome, "reason", CREDENTIAL), false);
      assert.equal(Reflect.set(metadata, "correlation", CREDENTIAL), false);
    },
  });
  const result = await service({ store: fake.store }).process(event());
  assert.deepEqual(result, { outcome: "left_disabled", reason: "audit_only_eligible_one_party_state" });
  assert.notStrictEqual(result, passedOutcome);
  assert.equal(Object.isFrozen(result), true);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(CREDENTIAL));
});

test("finalize cannot alter retained lease before an ambiguous failure release", async () => {
  const fake = fakeStore({
    async finalize(claim) {
      assert.equal(Reflect.set(claim, "leaseToken", CREDENTIAL), false);
      throw new Error(CREDENTIAL);
    },
  });
  const result = await service({ store: fake.store }).process(event());
  assert.deepEqual(result, { outcome: "left_disabled", reason: "dependency_failure" });
  assert.deepEqual(fake.calls.release, [{ claimed: true, key: EVENT_KEY, leaseToken: "lease-1" }]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(CREDENTIAL));
});

test("finalize committed-then-threw remains duplicate: fenced release cannot reopen finalized lease", async () => {
  let state = "new"; let finalizations = 0; let releases = 0;
  const store = {
    async claim(key) { if (state === "finalized") return { claimed: false, key }; state = "processing"; return { claimed: true, key, leaseToken: "lease-1" }; },
    async finalize() { finalizations++; state = "finalized"; throw new Error(CREDENTIAL); },
    async release() { releases++; if (state === "processing") state = "new"; },
  };
  const svc = service({ store });
  assert.deepEqual(await svc.process(event()), { outcome: "left_disabled", reason: "dependency_failure" });
  assert.equal(releases, 1);
  assert.deepEqual(await svc.process(event()), { outcome: "duplicate", reason: "already_claimed_or_completed" });
  assert.equal(finalizations, 1);
});

test("finalize failure while processing is released and permits a safe reattempt", async () => {
  let state = "new"; let attempts = 0;
  const store = {
    async claim(key) { if (state === "finalized") return { claimed: false, key }; if (state === "processing") return { claimed: false, key }; state = "processing"; return { claimed: true, key, leaseToken: "lease-1" }; },
    async finalize() { attempts++; if (attempts === 1) throw new Error(CREDENTIAL); state = "finalized"; },
    async release() { if (state === "processing") state = "new"; },
  };
  const svc = service({ store });
  assert.deepEqual(await svc.process(event()), { outcome: "left_disabled", reason: "dependency_failure" });
  assert.deepEqual(await svc.process(event()), { outcome: "left_disabled", reason: "audit_only_eligible_one_party_state" });
  assert.equal(attempts, 2);
});
