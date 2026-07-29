import assert from "node:assert/strict";
import test from "node:test";
import { decideRecordingForState, normalizeState } from "./consent.mjs";

const APPROVED_VERSIONS = new Set(["2026-07-29"]);
const ruleset = { version: "2026-07-29", states: { TX: true, CA: false } };
const activeLookingPolicy = {
  schemaVersion: 1, controllerStatus: "ENABLED", operatingMode: "ACTIVE", recordingActionsPermitted: true,
  approvalGate: { required: true, approver: "Approved Reviewer", status: "APPROVED" },
};
const disabled = (reason) => ({ action: "leave_disabled", reason });
const decide = (input = {}) => decideRecordingForState({ ...input, approvedRulesetVersions: APPROVED_VERSIONS });

test("normalizes exactly one U.S. State abbreviation", () => {
  assert.equal(normalizeState("  tx \n"), "TX");
  for (const value of ["Texas", "T-X", "T", "TX, CA", "ZZ", ["TX"], 78701, null, undefined]) {
    assert.equal(normalizeState(value), null, `expected ${String(value)} to be invalid`);
  }
});

test("eligible one-party data is audit classified, never authorized", () => {
  assert.deepEqual(decide({ state: " tx ", ruleset }), disabled("audit_only_eligible_one_party_state"));
  assert.deepEqual(decide({ state: "ca", ruleset }), disabled("not_one_party_state"));
  assert.deepEqual(decide({ state: "CA", ruleset: { version: "2026-07-29", states: { TX: true } } }), disabled("invalid_state"));
});

test("active-looking controller policies have no authority in this audit-only baseline", () => {
  const result = decideRecordingForState({ state: "TX", ruleset, approvedRulesetVersions: APPROVED_VERSIONS, controllerPolicy: activeLookingPolicy });
  assert.deepEqual(result, disabled("audit_only_eligible_one_party_state"));
  assert.notEqual(result.action, "resume_recording");
});

test("malformed rulesets, versions, and State maps leave recording disabled", () => {
  for (const candidate of [
    null, [], {}, { version: "2026-07-29" }, { version: "2026-07-29", states: null },
    { version: "2026-07-30", states: { TX: true } }, { version: 20260729, states: { TX: true } },
    { version: "2026-07-29", states: { TX: "true" } }, { version: "2026-07-29", states: { TX: true, ZZ: false } },
  ]) assert.deepEqual(decide({ state: "TX", ruleset: candidate }), disabled("invalid_ruleset"));
});

test("stateful and throwing Proxies cannot produce a recording action", () => {
  let descriptorReads = 0;
  const statefulStates = new Proxy({ TX: false }, {
    getOwnPropertyDescriptor(target, key) {
      if (key === "TX") {
        descriptorReads += 1;
        return { value: descriptorReads === 1 ? false : true, enumerable: true, configurable: true, writable: true };
      }
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  const throwingStates = new Proxy({ TX: true }, { ownKeys() { throw new Error("trap"); } });
  for (const states of [statefulStates, throwingStates]) {
    const result = decide({ state: "TX", ruleset: { version: "2026-07-29", states }, controllerPolicy: activeLookingPolicy });
    assert.equal(result.action, "leave_disabled");
    assert.notEqual(result.action, "resume_recording");
  }
  assert.equal(descriptorReads, 1, "the audit classifier snapshots a state entry once");
});

test("all invalid direct inputs and invalid State values are disabled", () => {
  for (const input of [undefined, null, [], "TX", 42]) assert.deepEqual(decideRecordingForState(input), disabled("invalid_state"));
  for (const state of [" ", "NY", "Texas", "TX, CA", "ZZ"]) assert.deepEqual(decide({ state, ruleset }), disabled("invalid_state"));
});
