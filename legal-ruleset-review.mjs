import { types } from "node:util";

// Engineering-only structural validator for future legal-review records.
// It is deliberately not a runtime authorization mechanism and has no recording side effects.

const TOP_LEVEL_KEYS = [
  "schemaVersion", "documentType", "status", "recordingActionsPermitted", "runtimeEligible",
  "rulesetVersion", "jurisdictions", "requiredReview", "requiredJurisdictionEvidence",
];
const REVIEW_ROLES = Object.freeze({
  legalCounsel: "memorandumReference",
  privacySecurity: "assessmentReference",
  operationalOwner: "trainingReference",
  executiveApprover: "approvalReference",
});
const EVIDENCE_KEYS = ["businessStateSource", "humanRecordingConsent", "legalAuthority", "reviewedAt", "expiresAt"];
const JURISDICTION_KEYS = ["state", "eligible", "legalAuthorityReference", "reviewedAt", "expiresAt"];
const CANONICAL_STATE_SOURCE = "Callbacks.State: rep-verified controlled dropdown";
const CANONICAL_HUMAN_CONSENT = "Callbacks.Recording Consent: exact value Verified — Permit Recording";
const US_STATES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
]);
const SAFE_TEXT = /^[^\p{Cc}\p{Cf}\u202A-\u202E\u2066-\u2069]+$/u;
const ISO_UTC = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/;

/**
 * Validates the structure of a completed legal-review record into inert copied
 * data only. It does not verify legal correctness and cannot authorize,
 * control, or enable recording.
 */
export function validateLegalReviewRecordStructure(record) {
  try {
    const nowMs = Date.now();
    if (!Number.isFinite(nowMs) || !exactDataRecord(record, TOP_LEVEL_KEYS)) return null;

    const values = dataValues(record, TOP_LEVEL_KEYS);
    if (!values
      || values.schemaVersion !== 1
      || values.documentType !== "LEGAL_REVIEW_RECORD"
      || values.status !== "APPROVED"
      || values.recordingActionsPermitted !== false
      || values.runtimeEligible !== false
      || !safeText(values.rulesetVersion)) return null;

    if (!validRequiredReview(values.requiredReview, nowMs)
      || !validEvidence(values.requiredJurisdictionEvidence, nowMs)) return null;
    const jurisdictions = snapshotJurisdictions(values.jurisdictions, nowMs);
    if (!jurisdictions) return null;

    return Object.freeze({ rulesetVersion: values.rulesetVersion, jurisdictions: Object.freeze(jurisdictions) });
  } catch {
    // Accessors, revoked proxies, and other hostile values are fail-closed.
    return null;
  }
}


function validRequiredReview(review, nowMs) {
  if (!exactDataRecord(review, Object.keys(REVIEW_ROLES))) return false;
  for (const [role, referenceKey] of Object.entries(REVIEW_ROLES)) {
    const roleValue = ownDataValue(review, role);
    if (!exactDataRecord(roleValue, ["name", "completedAt", referenceKey])) return false;
    if (!safeText(ownDataValue(roleValue, "name"))
      || !safeText(ownDataValue(roleValue, referenceKey))
      || !pastOrPresentIso(ownDataValue(roleValue, "completedAt"), nowMs)) return false;
  }
  return true;
}

function validEvidence(evidence, nowMs) {
  if (!exactDataRecord(evidence, EVIDENCE_KEYS)) return false;
  return ownDataValue(evidence, "businessStateSource") === CANONICAL_STATE_SOURCE
    && ownDataValue(evidence, "humanRecordingConsent") === CANONICAL_HUMAN_CONSENT
    && safeText(ownDataValue(evidence, "legalAuthority"))
    && pastOrPresentIso(ownDataValue(evidence, "reviewedAt"), nowMs)
    && futureIso(ownDataValue(evidence, "expiresAt"), nowMs);
}

function snapshotJurisdictions(value, nowMs) {
  if (!plainArray(value) || value.length < 1 || !exactArrayData(value)) return null;
  const seen = new Set();
  const snapshot = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = ownDataValue(value, String(index));
    if (!exactDataRecord(entry, JURISDICTION_KEYS)) return null;
    const state = ownDataValue(entry, "state");
    if (!US_STATES.has(state) || seen.has(state) || ownDataValue(entry, "eligible") !== true
      || !safeText(ownDataValue(entry, "legalAuthorityReference"))
      || !pastOrPresentIso(ownDataValue(entry, "reviewedAt"), nowMs)
      || !futureIso(ownDataValue(entry, "expiresAt"), nowMs)) return null;
    seen.add(state);
    snapshot.push(Object.freeze({ state, eligible: true, legalAuthorityReference: ownDataValue(entry, "legalAuthorityReference"), reviewedAt: ownDataValue(entry, "reviewedAt"), expiresAt: ownDataValue(entry, "expiresAt") }));
  }
  return snapshot;
}

function exactDataRecord(value, expectedKeys, optionalKeys = false) {
  if (!plainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) return false;
  const names = Object.getOwnPropertyNames(value);
  if (names.some((name) => !expectedKeys.includes(name)) || (!optionalKeys && names.length !== expectedKeys.length)) return false;
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return false;
  }
  return true;
}

function exactArrayData(value) {
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== value.length + 1 || !names.includes("length")) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) return false;
  }
  return true;
}

function plainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function plainArray(value) { return Array.isArray(value) && !types.isProxy(value) && Object.getPrototypeOf(value) === Array.prototype; }
function dataValues(object, keys) {
  const values = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !("value" in descriptor)) return null;
    values[key] = descriptor.value;
  }
  return values;
}
function ownDataValue(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function safeText(value) { return typeof value === "string" && value.length > 0 && value.length <= 4096 && value.trim().length > 0 && SAFE_TEXT.test(value); }
function isoTime(value) {
  if (typeof value !== "string" || value.length > 30) return null;
  const match = ISO_UTC.exec(value);
  if (!match) return null;
  const normalized = `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
  const time = Date.parse(normalized);
  return Number.isFinite(time) && new Date(time).toISOString() === normalized ? time : null;
}
function pastOrPresentIso(value, nowMs) { const time = isoTime(value); return time !== null && time <= nowMs; }
function futureIso(value, nowMs) { const time = isoTime(value); return time !== null && time > nowMs; }
