import assert from "node:assert/strict";
import test from "node:test";
import {
  decideRecordingControl,
  evaluateRecordingControlPolicy,
  RECORDING_CONTROL_REASONS,
} from "./recording-control-policy.mjs";

const CONSENT = "Verified — Permit Recording";
const COLUMN = "recording_consent_status";

function approved(overrides = {}) {
  return {
    mode: "CONTROL_ENABLED",
    killSwitch: false,
    policyVersion: "control-2026-08-02.1",
    approvedPolicyVersions: ["control-2026-08-02.1"],
    resolvedState: "TX",
    eligibleStates: ["TX", "CO"],
    canonicalMondayConsentColumn: COLUMN,
    consent: { value: CONSENT, source: COLUMN, verified: true },
    pilotUserIds: [101, "user-202"],
    pilotNumberIds: [301, "number-402"],
    event: { type: "call.answered", userId: 101, numberId: 301 },
    ...overrides,
  };
}

const disabled = (reason) => ({ action: "leave_disabled", reason });

function evaluate(value) {
  const result = evaluateRecordingControlPolicy(value);
  assert.ok(RECORDING_CONTROL_REASONS.includes(result.reason));
  assert.equal(Object.isFrozen(result), true);
  return result;
}

test("authorizes only a complete, exact approval and returns no input evidence", () => {
  const input = approved();
  const expected = { action: "request_resume_recording", reason: "control_approved" };
  assert.deepEqual(evaluate(input), expected);
  assert.deepEqual(decideRecordingControl(input), expected);
  assert.deepEqual(Object.keys(evaluate(input)), ["action", "reason"]);
});

test("mode must equal CONTROL_ENABLED exactly", () => {
  for (const mode of [null, "", "AUDIT_ONLY", "control_enabled", " CONTROL_ENABLED ", true]) {
    assert.deepEqual(evaluate(approved({ mode })), disabled("mode_not_control_enabled"));
  }
});

test("global kill switch must be the boolean false", () => {
  for (const killSwitch of [null, true, 0, "false"]) {
    assert.deepEqual(evaluate(approved({ killSwitch })), disabled("kill_switch_not_clear"));
  }
});

test("policy version requires a non-empty plain allowlist and exact membership", () => {
  const cases = [
    { policyVersion: null },
    { policyVersion: "control-2026-08-02.2" },
    { policyVersion: " control-2026-08-02.1" },
    { approvedPolicyVersions: [] },
    { approvedPolicyVersions: ["other"] },
    { approvedPolicyVersions: ["control-2026-08-02.1", "control-2026-08-02.1"] },
    { approvedPolicyVersions: new Set(["control-2026-08-02.1"]) },
  ];
  for (const change of cases) {
    assert.deepEqual(evaluate(approved(change)), disabled(change.approvedPolicyVersions instanceof Set ? "invalid_input" : "policy_version_not_approved"));
  }
});

test("resolved state must exactly match a configured eligible state", () => {
  for (const change of [
    { resolvedState: null },
    { resolvedState: "tx" },
    { resolvedState: "TX " },
    { resolvedState: "CA" },
    { eligibleStates: [] },
    { eligibleStates: ["TX", "TX"] },
    { eligibleStates: ["CO"] },
  ]) {
    assert.deepEqual(evaluate(approved(change)), disabled("state_not_eligible"));
  }
});

test("consent text must equal the explicit permit label byte-for-byte", () => {
  for (const value of [null, "Permit Recording", "Verified - Permit Recording", "verified — Permit Recording", `${CONSENT} `]) {
    assert.deepEqual(evaluate(approved({ consent: { value, source: COLUMN, verified: true } })), disabled("consent_not_permitted"));
  }
  assert.deepEqual(evaluate(approved({ consent: null })), disabled("consent_not_permitted"));
});

test("consent must come from the configured canonical Monday column", () => {
  for (const change of [
    { canonicalMondayConsentColumn: null },
    { canonicalMondayConsentColumn: "" },
    { canonicalMondayConsentColumn: "other_column" },
  ]) {
    assert.deepEqual(evaluate(approved(change)), disabled("consent_source_mismatch"));
  }
  for (const source of [null, "", "other_column", `${COLUMN} `]) {
    assert.deepEqual(evaluate(approved({ consent: { value: CONSENT, source, verified: true } })), disabled("consent_source_mismatch"));
  }
});

test("consent verification must be exactly true", () => {
  for (const verified of [null, false, 1, "true"]) {
    assert.deepEqual(evaluate(approved({ consent: { value: CONSENT, source: COLUMN, verified } })), disabled("consent_not_verified"));
  }
});

test("pilot user allowlist must be non-empty, valid, and contain exact call user ID", () => {
  for (const pilotUserIds of [null, [], [""], [-1], [1.5], [101, 101]]) {
    assert.deepEqual(evaluate(approved({ pilotUserIds })), disabled("pilot_users_not_configured"));
  }
  for (const userId of [null, 102, "101", "user-101", ""]) {
    assert.deepEqual(evaluate(approved({ event: { type: "call.answered", userId, numberId: 301 } })), disabled("call_user_not_in_pilot"));
  }
});

test("pilot number allowlist must be non-empty, valid, and contain exact call number ID", () => {
  for (const pilotNumberIds of [null, [], [""], [-1], [1.5], [301, 301]]) {
    assert.deepEqual(evaluate(approved({ pilotNumberIds })), disabled("pilot_numbers_not_configured"));
  }
  for (const numberId of [null, 302, "301", "number-301", ""]) {
    assert.deepEqual(evaluate(approved({ event: { type: "call.answered", userId: 101, numberId } })), disabled("call_number_not_in_pilot"));
  }
});

test("event must equal call.answered exactly after all pilot checks", () => {
  for (const type of [null, "call.created", "call.answered ", "CALL.ANSWERED"]) {
    assert.deepEqual(evaluate(approved({ event: { type, userId: 101, numberId: 301 } })), disabled("unsupported_event"));
  }
});

test("missing and non-record roots fail closed with a stable allowlisted reason", () => {
  for (const input of [undefined, null, true, "data", 1, [], () => {}]) {
    assert.deepEqual(evaluate(input), disabled("invalid_input"));
  }
  assert.deepEqual(evaluate({}), disabled("mode_not_control_enabled"));
});

test("missing evidence at every gate always leaves recording disabled", () => {
  for (const key of [
    "mode", "killSwitch", "policyVersion", "approvedPolicyVersions",
    "resolvedState", "eligibleStates", "canonicalMondayConsentColumn", "consent",
    "pilotUserIds", "pilotNumberIds", "event",
  ]) {
    const input = approved();
    delete input[key];
    assert.equal(evaluate(input).action, "leave_disabled", `missing ${key}`);
  }
  for (const key of ["value", "source", "verified"]) {
    const input = approved();
    delete input.consent[key];
    assert.equal(evaluate(input).action, "leave_disabled", `missing consent.${key}`);
  }
  for (const key of ["type", "userId", "numberId"]) {
    const input = approved();
    delete input.event[key];
    assert.equal(evaluate(input).action, "leave_disabled", `missing event.${key}`);
  }
});

test("accessors at any depth are rejected without invocation", () => {
  let reads = 0;
  const rootGetter = approved();
  Object.defineProperty(rootGetter, "mode", { enumerable: true, get() { reads += 1; throw new Error("secret"); } });
  const nestedGetter = approved();
  Object.defineProperty(nestedGetter.consent, "verified", { enumerable: true, get() { reads += 1; throw new Error("secret"); } });
  const arrayGetter = approved();
  Object.defineProperty(arrayGetter.pilotUserIds, "0", { enumerable: true, get() { reads += 1; throw new Error("secret"); } });

  for (const input of [rootGetter, nestedGetter, arrayGetter]) {
    assert.deepEqual(evaluate(input), disabled("invalid_input"));
  }
  assert.equal(reads, 0);
});

test("hostile and transparent Proxies are rejected without invoking traps or leaking errors", () => {
  let traps = 0;
  const hostile = new Proxy(approved(), {
    getPrototypeOf() { traps += 1; throw new Error("credential-must-not-leak"); },
    ownKeys() { traps += 1; throw new Error("credential-must-not-leak"); },
    getOwnPropertyDescriptor() { traps += 1; throw new Error("credential-must-not-leak"); },
    get() { traps += 1; throw new Error("credential-must-not-leak"); },
  });
  const nested = approved({ consent: new Proxy({ value: CONSENT, source: COLUMN, verified: true }, {}) });
  const transparent = new Proxy(approved(), {});

  for (const input of [hostile, nested, transparent]) {
    const result = evaluate(input);
    assert.deepEqual(result, disabled("invalid_input"));
    assert.doesNotMatch(JSON.stringify(result), /credential-must-not-leak/);
  }
  assert.equal(traps, 0);
});

test("exotic, cyclic, symbolic, sparse, and non-enumerable data all fail closed", () => {
  const cyclic = approved();
  cyclic.loop = cyclic;
  const symbolic = approved();
  symbolic[Symbol("hidden")] = true;
  const sparse = approved({ eligibleStates: new Array(1) });
  const nonEnumerable = approved();
  Object.defineProperty(nonEnumerable, "hidden", { value: "evidence", enumerable: false });

  for (const input of [approved({ consent: new Date() }), approved({ event: new Map() }), cyclic, symbolic, sparse, nonEnumerable]) {
    assert.deepEqual(evaluate(input), disabled("invalid_input"));
  }
});

test("evaluation is synchronous, deterministic, and does not mutate plain input", () => {
  const input = approved();
  const before = structuredClone(input);
  const first = evaluateRecordingControlPolicy(input);
  assert.equal(typeof first?.then, "undefined");
  assert.deepEqual(evaluateRecordingControlPolicy(input), first);
  assert.deepEqual(input, before);
});
