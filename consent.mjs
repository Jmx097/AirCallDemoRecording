const US_STATE_ABBREVIATIONS = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
]);

export function normalizeState(value) {
  if (typeof value !== "string") return null;
  const state = value.trim().toUpperCase();
  return US_STATE_ABBREVIATIONS.has(state) ? state : null;
}

/**
 * Classifies supplied data for audit only. This baseline never authorizes or
 * controls recording: every return value deliberately leaves recording disabled.
 */
export function decideRecordingForState(input = {}) {
  try {
    const inputSnapshot = snapshotInput(input);
    if (!inputSnapshot) return disabled("invalid_state");

    const state = normalizeState(inputSnapshot.state);
    if (!state) return disabled("invalid_state");

    const ruleset = validateRuleset(inputSnapshot.ruleset, inputSnapshot.approvedRulesetVersions);
    if (!ruleset) return disabled("invalid_ruleset");
    if (!Object.hasOwn(ruleset.states, state)) return disabled("invalid_state");

    return ruleset.states[state]
      ? disabled("audit_only_eligible_one_party_state")
      : disabled("not_one_party_state");
  } catch {
    // Hostile inputs can only produce a disabled audit classification.
    return disabled("invalid_ruleset");
  }
}

function snapshotInput(value) {
  if (!isPlainRecord(value)) return null;
  const snapshot = Object.create(null);
  for (const key of ["state", "ruleset", "approvedRulesetVersions"]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (key === "state" && (!descriptor || !("value" in descriptor))) return null;
    if (descriptor && !("value" in descriptor)) return null;
    snapshot[key] = descriptor ? descriptor.value : undefined;
  }
  return snapshot;
}

function validateRuleset(ruleset, approvedRulesetVersions) {
  const root = snapshotOwnData(ruleset, ["version", "states"]);
  if (!root || typeof root.version !== "string" || !root.version.trim() || !isApprovedVersion(approvedRulesetVersions, root.version)) return null;

  const states = snapshotStateMap(root.states);
  return states ? { version: root.version, states } : null;
}

function snapshotStateMap(value) {
  if (!isPlainRecord(value)) return null;
  const names = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length !== 0 || names.length === 0) return null;

  const snapshot = Object.create(null);
  for (const name of names) {
    if (!US_STATE_ABBREVIATIONS.has(name)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || typeof descriptor.value !== "boolean") return null;
    snapshot[name] = descriptor.value;
  }
  return snapshot;
}

function isApprovedVersion(versions, version) {
  if (Array.isArray(versions) && Object.getPrototypeOf(versions) === Array.prototype) {
    const names = Object.getOwnPropertyNames(versions);
    for (let index = 0; index < versions.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(versions, String(index));
      if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") return false;
      if (descriptor.value === version) return true;
    }
    return names.length >= 1 && names.every((name) => name === "length" || /^(0|[1-9]\d*)$/.test(name));
  }
  if (versions instanceof Set && Object.getPrototypeOf(versions) === Set.prototype) return Set.prototype.has.call(versions, version);
  return false;
}

/** Returns a fresh null-prototype snapshot without invoking application getters. */
function snapshotOwnData(value, requiredKeys) {
  if (!isPlainRecord(value)) return null;
  const snapshot = Object.create(null);
  for (const key of requiredKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return null;
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function disabled(reason) {
  return { action: "leave_disabled", reason };
}
