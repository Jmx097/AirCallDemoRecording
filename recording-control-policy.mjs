import { types as utilTypes } from "node:util";

const PERMITTED_CONSENT = "Verified — Permit Recording";
const ANSWERED_EVENT = "call.answered";

/**
 * Stable, non-sensitive reasons emitted by the evaluator. Consumers must treat
 * every reason except control_approved as a denial.
 */
export const RECORDING_CONTROL_REASONS = Object.freeze([
  "invalid_input",
  "mode_not_control_enabled",
  "kill_switch_not_clear",
  "policy_version_not_approved",
  "state_not_eligible",
  "consent_not_permitted",
  "consent_source_mismatch",
  "consent_not_verified",
  "pilot_users_not_configured",
  "call_user_not_in_pilot",
  "pilot_numbers_not_configured",
  "call_number_not_in_pilot",
  "unsupported_event",
  "control_approved",
]);

/**
 * Pure recording-control authorization boundary.
 *
 * Expected input (all values must be recursively plain, JSON-like data):
 * {
 *   mode, killSwitch, policyVersion, approvedPolicyVersions,
 *   resolvedState, eligibleStates,
 *   canonicalMondayConsentColumn,
 *   consent: { value, source, verified },
 *   pilotUserIds, pilotNumberIds,
 *   event: { type, userId, numberId }
 * }
 *
 * Matching is deliberately exact: this function performs no trimming, case
 * folding, state normalization, identifier coercion, or inferred approval.
 */
export function evaluateRecordingControlPolicy(input) {
  try {
    const data = snapshotPlainData(input);
    if (!isRecord(data)) return denied("invalid_input");

    if (data.mode !== "CONTROL_ENABLED") return denied("mode_not_control_enabled");
    if (data.killSwitch !== false) return denied("kill_switch_not_clear");

    if (!nonEmptyString(data.policyVersion)
      || !validStringList(data.approvedPolicyVersions)
      || !data.approvedPolicyVersions.includes(data.policyVersion)) {
      return denied("policy_version_not_approved");
    }

    if (!nonEmptyString(data.resolvedState)
      || !validStringList(data.eligibleStates)
      || !data.eligibleStates.includes(data.resolvedState)) {
      return denied("state_not_eligible");
    }

    if (!isRecord(data.consent) || data.consent.value !== PERMITTED_CONSENT) {
      return denied("consent_not_permitted");
    }
    if (!nonEmptyString(data.canonicalMondayConsentColumn)
      || data.consent.source !== data.canonicalMondayConsentColumn) {
      return denied("consent_source_mismatch");
    }
    if (data.consent.verified !== true) return denied("consent_not_verified");

    if (!validIdList(data.pilotUserIds)) return denied("pilot_users_not_configured");
    if (!isRecord(data.event) || !validId(data.event.userId)
      || !data.pilotUserIds.includes(data.event.userId)) {
      return denied("call_user_not_in_pilot");
    }

    if (!validIdList(data.pilotNumberIds)) return denied("pilot_numbers_not_configured");
    if (!isRecord(data.event) || !validId(data.event.numberId)
      || !data.pilotNumberIds.includes(data.event.numberId)) {
      return denied("call_number_not_in_pilot");
    }

    if (data.event.type !== ANSWERED_EVENT) return denied("unsupported_event");
    return decision("request_resume_recording", "control_approved");
  } catch {
    // No attacker-controlled exception or text crosses the policy boundary.
    return denied("invalid_input");
  }
}

// Descriptive alias for callers that use the repository's existing "decide" naming.
export const decideRecordingControl = evaluateRecordingControlPolicy;

function validStringList(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every(nonEmptyString)
    && new Set(value).size === value.length;
}

function validIdList(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every(validId)
    && new Set(value).size === value.length;
}

function validId(value) {
  return nonEmptyString(value) || (Number.isSafeInteger(value) && value >= 0);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function denied(reason) {
  return decision("leave_disabled", reason);
}

function decision(action, reason) {
  return Object.freeze({ action, reason });
}

/**
 * Copies recursively plain data without evaluating accessors. Proxies are
 * rejected explicitly; this also prevents even transparent Proxy wrappers from
 * acquiring authority. Cycles, sparse arrays, symbols, functions, exotic
 * prototypes, non-finite numbers, and non-enumerable application fields fail.
 */
function snapshotPlainData(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : INVALID;
  if (typeof value !== "object" || utilTypes.isProxy(value) || seen.has(value)) return INVALID;

  seen.add(value);
  try {
    if (Array.isArray(value)) return snapshotArray(value, seen);
    if (Object.getPrototypeOf(value) !== Object.prototype) return INVALID;
    return snapshotRecord(value, seen);
  } finally {
    seen.delete(value);
  }
}

function snapshotArray(value, seen) {
  if (Object.getPrototypeOf(value) !== Array.prototype) return INVALID;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) return INVALID;
  if (keys.length !== value.length + 1 || !keys.includes("length")) return INVALID;

  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!plainDataDescriptor(descriptor)) return INVALID;
    const item = snapshotPlainData(descriptor.value, seen);
    if (item === INVALID) return INVALID;
    result.push(item);
  }
  return result;
}

function snapshotRecord(value, seen) {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) return INVALID;
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!plainDataDescriptor(descriptor)) return INVALID;
    const item = snapshotPlainData(descriptor.value, seen);
    if (item === INVALID) return INVALID;
    result[key] = item;
  }
  return result;
}

function plainDataDescriptor(descriptor) {
  return descriptor !== undefined
    && descriptor.enumerable === true
    && Object.hasOwn(descriptor, "value");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const INVALID = Symbol("invalid plain data");
