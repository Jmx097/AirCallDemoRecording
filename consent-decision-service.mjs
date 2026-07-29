import { createHash } from "node:crypto";
import { resolveCanonicalConsent } from "./consent-resolver.mjs";
import { decideRecordingForState } from "./consent.mjs";

const OPAQUE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NORMALIZED_PHONE = /^\d{10,15}$/;
const EVENT_KEYS = new Set(["eventKey", "callId", "nativeItemId", "phoneDigits"]);
const CLASSIFIER_REASONS = new Set([
  "audit_only_eligible_one_party_state", "not_one_party_state", "invalid_state", "invalid_ruleset",
]);
const RESOLVER_REASON_MAP = new Map([
  ["phone_not_found", "resolver_not_found"], ["missing_phone", "resolver_not_found"], ["phone_not_unique", "resolver_not_unique"],
]);
const RESOLVER_DEPENDENCY_REASONS = new Set([
  "native_lookup_failed", "phone_lookup_failed", "native_lookup_unavailable", "phone_lookup_unavailable",
]);

/**
 * Creates an audit-only, idempotent decision lifecycle. Its injected durable
 * store atomically/fenced finalizes final status plus redacted audit/outbox;
 * this non-routable, non-live module has no provider/runtime integration and
 * never enables recording.
 */
export function createConsentDecisionService(config = {}) {
  const dependencies = snapshotConstruction(config);
  if (!dependencies) throw new TypeError("A valid injected decision-service store is required");

  return Object.freeze({
    async process(event) {
      const envelope = snapshotEvent(event);
      if (!envelope) return disabled("invalid_event");

      let rawClaim;
      try {
        rawClaim = await dependencies.claim(envelope.eventKey);
      } catch {
        return disabled("dependency_failure");
      }
      const claimResult = snapshotClaimResult(rawClaim, envelope.eventKey);
      if (claimResult.kind === "duplicate") return { outcome: "duplicate", reason: "already_claimed_or_completed" };
      if (claimResult.kind !== "claimed") {
        await releaseQuietly(dependencies.release, claimResult.lease);
        return disabled("dependency_failure");
      }
      // This is the only lease retained by the service. In particular, never
      // use an object handed to finalize for a later release: a durable-store
      // adapter is untrusted at this boundary and may retain or mutate it.
      const claim = immutableLease(claimResult.lease);

      let result;
      try {
        const resolved = await resolveCanonicalConsent({
          canonicalBoardId: dependencies.canonicalBoardId,
          stateSource: dependencies.stateSource,
          nativeItemId: envelope.nativeItemId,
          phoneDigits: envelope.phoneDigits,
          getConsentLeadById: dependencies.getConsentLeadById,
          findConsentLeadsByPhone: dependencies.findConsentLeadsByPhone,
        });
        if (isResolverDependencyFailure(resolved)) {
          await releaseQuietly(dependencies.release, claim);
          return disabled("dependency_failure");
        }
        result = classifyResolution(resolved, dependencies.ruleset, dependencies.approvedRulesetVersions);
      } catch {
        await releaseQuietly(dependencies.release, claim);
        return disabled("dependency_failure");
      }

      // finalize is one atomic, token-fenced transaction: final status and the
      // redacted audit/outbox are committed together. A thrown response is
      // ambiguous, so release is safe only because durable adapters must no-op
      // unless this exact token still owns a processing lease.
      try {
        // Give finalization a distinct, immutable capability and decision
        // payload. All fields are primitive, but each record is frozen so a
        // malicious or buggy adapter cannot change either the decision we
        // return or the retained lease used for ambiguous-failure release.
        await dependencies.finalize(
          immutableLease(claim),
          immutableResult(result),
          immutableCorrelation(correlationPrefix(envelope.eventKey, envelope.callId)),
        );
      } catch {
        await releaseQuietly(dependencies.release, claim);
        return disabled("dependency_failure");
      }
      // Never return the instance passed across the durable-store boundary.
      return immutableResult(result);
    },
  });
}

function isResolverDependencyFailure(resolved) {
  const resolution = snapshotResolution(resolved);
  return resolution?.item === null && RESOLVER_DEPENDENCY_REASONS.has(resolution.reason);
}

function classifyResolution(resolved, ruleset, approvedRulesetVersions) {
  const resolution = snapshotResolution(resolved);
  if (!resolution) return disabled("resolver_denied");
  if (!resolution.item) return disabled(RESOLVER_REASON_MAP.get(resolution.reason) || "resolver_denied");
  return disabled(safeClassifierReason(decideRecordingForState({ state: resolution.item.state, ruleset, approvedRulesetVersions })));
}

function safeClassifierReason(decision) {
  try {
    if (isPlainRecord(decision)) {
      const action = ownValue(decision, "action");
      const reason = ownValue(decision, "reason");
      if (action === "leave_disabled" && typeof reason === "string" && CLASSIFIER_REASONS.has(reason)) return reason;
    }
  } catch { /* fail closed */ }
  return "invalid_ruleset";
}

function snapshotConstruction(value) {
  try {
    if (!isPlainRecord(value)) return null;
    const store = ownValue(value, "store");
    if (!isPlainRecord(store)) return null;
    const methods = {};
    for (const name of ["claim", "finalize", "release"]) {
      const fn = ownValue(store, name);
      if (typeof fn !== "function") return null;
      // Snapshot and bind own data descriptors so later mutations/getters do not run.
      methods[name] = Function.prototype.call.bind(fn, store);
    }
    return {
      ...methods,
      canonicalBoardId: ownValue(value, "canonicalBoardId"), stateSource: ownValue(value, "stateSource"),
      ruleset: ownValue(value, "ruleset"), approvedRulesetVersions: ownValue(value, "approvedRulesetVersions"),
      getConsentLeadById: ownValue(value, "getConsentLeadById"), findConsentLeadsByPhone: ownValue(value, "findConsentLeadsByPhone"),
    };
  } catch { return null; }
}

function snapshotEvent(value) {
  try {
    if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) return null;
    const names = Object.getOwnPropertyNames(value);
    if (names.some((name) => !EVENT_KEYS.has(name))) return null;
    const eventKey = ownValue(value, "eventKey");
    const callId = ownValue(value, "callId");
    const nativeItemId = ownOptionalValue(value, "nativeItemId");
    const phoneDigits = ownOptionalValue(value, "phoneDigits");
    if (!opaque(eventKey) || !opaque(callId) || (nativeItemId === undefined && phoneDigits === undefined)) return null;
    if (nativeItemId !== undefined && !opaque(nativeItemId)) return null;
    if (phoneDigits !== undefined && (typeof phoneDigits !== "string" || !NORMALIZED_PHONE.test(phoneDigits))) return null;
    return { eventKey, callId, nativeItemId, phoneDigits };
  } catch { return null; }
}

function snapshotClaimResult(value, expectedKey) {
  // Capture a release-safe lease before the strict plain-record check. This lets
  // us clean up a Proxy with a hostile prototype trap when its own data fields
  // were safely readable. If no such snapshot is possible, release is unsafe.
  const lease = snapshotLease(value, expectedKey);
  try {
    if (!isPlainRecord(value)) return { kind: "malformed", lease };
    const claimed = ownValue(value, "claimed");
    if (claimed === false) return { kind: "duplicate", lease: null };
    return claimed === true && lease ? { kind: "claimed", lease } : { kind: "malformed", lease };
  } catch { return { kind: "malformed", lease }; }
}

function snapshotLease(value, expectedKey) {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const claimed = ownValue(value, "claimed");
    const key = ownValue(value, "key");
    const leaseToken = ownValue(value, "leaseToken");
    return claimed === true && key === expectedKey && opaque(key) && opaque(leaseToken)
      ? immutableLease({ key, leaseToken })
      : null;
  } catch { return null; }
}

function snapshotResolution(value) {
  try {
    if (!isPlainRecord(value)) return null;
    const item = ownValue(value, "item");
    const reason = ownValue(value, "reason");
    if (item === null) return typeof reason === "string" ? { item: null, reason } : null;
    if (!isPlainRecord(item) || (typeof reason !== "object" && reason !== null)) return null;
    const state = ownValue(item, "state");
    return typeof state === "string" ? { item: { state }, reason: null } : null;
  } catch { return null; }
}

function ownValue(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function ownOptionalValue(object, key) { return Object.hasOwn(object, key) ? ownValue(object, key) : undefined; }
function isPlainRecord(value) {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch { return false; }
}
function opaque(value) { return typeof value === "string" && OPAQUE_IDENTIFIER.test(value); }
function disabled(reason) { return immutableResult({ outcome: "left_disabled", reason }); }
function correlationPrefix(eventKey, callId) { return createHash("sha256").update(`consent-decision-v1\u0000${eventKey}\u0000${callId}`).digest("hex").slice(0, 24); }
async function releaseQuietly(release, claim) { if (claim) try { await release(claim); } catch { /* redacted fail-closed result */ } }

// These constructors deliberately rebuild allowlisted primitive records rather
// than freezing caller-owned objects. That eliminates aliases in both
// directions at the durable-store finalization boundary.
function immutableLease(claim) {
  return Object.freeze({ claimed: true, key: claim.key, leaseToken: claim.leaseToken });
}
function immutableResult(result) {
  return Object.freeze({ outcome: "left_disabled", reason: result.reason });
}
function immutableCorrelation(correlation) { return Object.freeze({ correlation }); }
