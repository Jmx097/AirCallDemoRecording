import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateLegalReviewRecordStructure } from "./legal-ruleset-review.mjs";

const now = Date.now();
const toIso = (offsetMs) => new Date(now + offsetMs).toISOString();
const completedAt = toIso(-3 * 86_400_000);
const reviewedAt = toIso(-2 * 86_400_000);
const expiresAt = toIso(365 * 86_400_000);

function approvedRecord() {
  return {
    schemaVersion: 1,
    documentType: "LEGAL_REVIEW_RECORD",
    status: "APPROVED",
    recordingActionsPermitted: false,
    runtimeEligible: false,
    rulesetVersion: "legal-review-2029-12",
    jurisdictions: [{ state: "TX", eligible: true, legalAuthorityReference: "counsel-memo-TX-2029", reviewedAt, expiresAt }],
    requiredReview: {
      legalCounsel: { name: "Counsel", completedAt, memorandumReference: "memo-2029-01" },
      privacySecurity: { name: "Privacy", completedAt, assessmentReference: "assessment-2029-02" },
      operationalOwner: { name: "Operations", completedAt, trainingReference: "training-2029-03" },
      executiveApprover: { name: "Executive", completedAt, approvalReference: "approval-2029-04" },
    },
    requiredJurisdictionEvidence: {
      businessStateSource: "Sales Board 7727339040.State text_2: business-address State",
      humanRecordingConsent: "Separate approved human-consent control: not configured in audit runtime",
      legalAuthority: "Per-jurisdiction counsel-reviewed authority and effective-date evidence",
      reviewedAt,
      expiresAt,
    },
  };
}
function validate(record) { return validateLegalReviewRecordStructure(record); }

for (const mutate of [
  (record) => { record.schemaVersion = 2; },
  (record) => { record.documentType = "LEGAL_REVIEW_TEMPLATE_ONLY"; },
  (record) => { record.status = "NOT_APPROVED"; },
  (record) => { record.recordingActionsPermitted = true; },
  (record) => { record.runtimeEligible = true; },
  (record) => { record.rulesetVersion = "  "; },
]) {
  test("rejects incomplete, denied, template, or runtime-authorizing top-level records", () => {
    const record = approvedRecord(); mutate(record);
    assert.equal(validate(record), null);
  });
}

test("returns only an inert deeply frozen data snapshot for a completed structural record", () => {
  const record = approvedRecord();
  const result = validate(record);
  assert.deepEqual(result, { rulesetVersion: "legal-review-2029-12", jurisdictions: [{ state: "TX", eligible: true, legalAuthorityReference: "counsel-memo-TX-2029", reviewedAt, expiresAt }] });
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.jurisdictions)); assert.ok(Object.isFrozen(result.jurisdictions[0]));
  assert.equal("status" in result, false); assert.equal("recordingActionsPermitted" in result, false);
  record.jurisdictions[0].state = "CA";
  assert.equal(result.jurisdictions[0].state, "TX");
  assert.throws(() => { result.jurisdictions[0].state = "CA"; }, TypeError);
});

test("requires every named review role with its exact reference field and completed nonfuture ISO timestamp", () => {
  for (const [role, field] of Object.entries({ legalCounsel: "memorandumReference", privacySecurity: "assessmentReference", operationalOwner: "trainingReference", executiveApprover: "approvalReference" })) {
    const missing = approvedRecord(); delete missing.requiredReview[role][field]; assert.equal(validate(missing), null, `${role} missing reference`);
    const wrong = approvedRecord(); wrong.requiredReview[role].unexpectedReference = "x"; assert.equal(validate(wrong), null, `${role} unknown key`);
    const future = approvedRecord(); future.requiredReview[role].completedAt = toIso(86_400_000); assert.equal(validate(future), null, `${role} future review`);
    const malformed = approvedRecord(); malformed.requiredReview[role].completedAt = "2029-02-29T00:00:00Z"; assert.equal(validate(malformed), null, `${role} malformed date`);
  }
});

test("requires exact canonical evidence, current review, and unexpired evidence", () => {
  for (const [key, value] of [
    ["businessStateSource", "wrong_state_source"],
    ["humanRecordingConsent", "unapproved_consent_control"],
    ["legalAuthority", ""],
    ["reviewedAt", toIso(86_400_000)],
    ["expiresAt", toIso(0)],
    ["expiresAt", toIso(-1)],
  ]) {
    const record = approvedRecord(); record.requiredJurisdictionEvidence[key] = value;
    assert.equal(validate(record), null, key);
  }
});

test("requires nonempty unique valid state entries that are all structurally eligible and unexpired", () => {
  const empty = approvedRecord(); empty.jurisdictions = []; assert.equal(validate(empty), null);
  const duplicate = approvedRecord(); duplicate.jurisdictions.push({ ...duplicate.jurisdictions[0] }); assert.equal(validate(duplicate), null);
  for (const [key, value] of [["state", "XX"], ["state", "tx"], ["eligible", false], ["legalAuthorityReference", "\n"], ["legalAuthorityReference", "memo\u202Epdf"], ["legalAuthorityReference", "memo\u0085pdf"], ["reviewedAt", toIso(86_400_000)], ["expiresAt", toIso(0)]]) {
    const record = approvedRecord(); record.jurisdictions[0][key] = value;
    assert.equal(validate(record), null, `${key} must be safe`);
  }
  const unknown = approvedRecord(); unknown.jurisdictions[0].note = "not permitted"; assert.equal(validate(unknown), null);
});

test("rejects unknown keys, symbols, accessors, malformed arrays, and hostile proxies", () => {
  const extra = approvedRecord(); extra.notes = "unknown"; assert.equal(validate(extra), null);
  const symbol = approvedRecord(); symbol[Symbol("extra")] = true; assert.equal(validate(symbol), null);
  const accessor = approvedRecord(); Object.defineProperty(accessor, "status", { get() { throw new Error("must not execute"); }, enumerable: true }); assert.equal(validate(accessor), null);
  const arrayExtra = approvedRecord(); arrayExtra.jurisdictions.extra = true; assert.equal(validate(arrayExtra), null);
  const sparse = approvedRecord(); sparse.jurisdictions = new Array(1); assert.equal(validate(sparse), null);
  assert.equal(validate(new Proxy(approvedRecord(), {})), null);
  const { proxy, revoke } = Proxy.revocable(approvedRecord(), {}); revoke(); assert.equal(validate(proxy), null);
});

test("both review templates and the live runtime remain outside this engineering-only validator", async () => {
  const templates = await Promise.all([
    readFile(new URL("./policy/legal-ruleset.review-template.json", import.meta.url), "utf8"),
    readFile(new URL("./policy/legal-review-record.template.json", import.meta.url), "utf8"),
  ]);
  for (const template of templates) assert.equal(validate(JSON.parse(template)), null);
  const [validatorSource, runtimeSource, receiverSource] = await Promise.all([
    readFile(new URL("./legal-ruleset-review.mjs", import.meta.url), "utf8"),
    readFile(new URL("./audit-only-runtime.mjs", import.meta.url), "utf8"),
    readFile(new URL("./audit-only-receiver.mjs", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(validatorSource, /(?:recording-client|createAuditOnlyReceiver|createAuditOnlyRuntime)/);
  assert.doesNotMatch(runtimeSource, /legal-ruleset-review/);
  assert.doesNotMatch(receiverSource, /legal-ruleset-review/);
});
