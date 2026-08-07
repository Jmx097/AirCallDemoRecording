import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Retention/remediation lane for Timberline two-party calls.
 * It never resolves policy at asset time and never discovers a Monday row by
 * phone/name/recency. The answer-time authority must persist one exact row.
 */
export const TIMBERLINE_CALLS_BOARD = "18419412577";
export const TIMBERLINE_RECORDING_LINK = "link_mm4n5qp";
const CALL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ITEM = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PHONE = /^\d{10,15}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/;
const HASH = /^[a-f0-9]{64}$/;

export function createTwoPartyRetentionFinalizer({ store, aircall, monday, correlationKey } = {}) {
  requireMethod(store, "recordDecision"); requireMethod(store, "claimNext");
  requireMethod(store, "markDeleteRequested"); requireMethod(store, "markDeleteConfirmed");
  requireMethod(store, "markMondayCleared"); requireMethod(store, "releaseForReconcile"); requireMethod(store, "markException");
  requireMethod(aircall, "deleteRecording"); requireMethod(aircall, "recordingUnavailable");
  requireMethod(monday, "clearExactRecordingLink"); requireMethod(monday, "readExactRecordingLink");
  if (typeof correlationKey !== "string" || correlationKey.length < 32) throw new TypeError("correlation_key_required");

  async function recordAnswerTimeDecision(input) {
    const d = validateDecision(input);
    // The store encrypts raw identities; only the opaque correlation is returned.
    const correlation = correlate(correlationKey, d);
    const result = await store.recordDecision({ ...d, correlation, providerCallKeyHash: callKey(correlationKey, d.providerCallId) });
    return Object.freeze({ recorded: result?.recorded === true, correlation });
  }

  async function receiveAssetEvent(input) {
    const event = validateAssetEvent(input);
    // A missing call-time decision is deliberately a no-op: no deletion and no CRM write.
    const queued = await store.enqueueAsset({ ...event, providerCallKeyHash: callKey(correlationKey, event.providerCallId), assetKey: assetKey(correlationKey, event) });
    if (queued?.status === "missing_decision" || queued?.status === "not_two_party") return Object.freeze({ accepted: true, outcome: queued.status });
    if (queued?.status !== "queued" && queued?.status !== "duplicate") throw new Error("retention_enqueue_failed");
    return Object.freeze({ accepted: true, outcome: queued.status });
  }

  async function runOnce() {
    const action = await store.claimNext();
    if (!action) return Object.freeze({ outcome: "idle" });
    const a = validateClaim(action);
    try {
      if (a.status === "delete_pending") {
        // Every durable two-party action follows the same delayed deletion path.
        // No call-tag exception can suppress provider deletion or exact Monday clearing.
        // A successful request is only delete_requested. Replays never re-dispatch.
        await aircall.deleteRecording(a.providerCallId);
        await store.markDeleteRequested(a);
        return Object.freeze({ outcome: "delete_requested" });
      }
      if (a.status === "delete_requested") {
        const unavailable = await aircall.recordingUnavailable(a.providerCallId);
        if (unavailable !== true) { await store.releaseForReconcile(a); return Object.freeze({ outcome: "awaiting_provider_reconciliation" }); }
        await store.markDeleteConfirmed(a);
        // Confirmation releases this lease. A later fresh claim alone may own
        // the Monday clear/read-back stage; do not reuse a stale lease here.
        return Object.freeze({ outcome: "delete_confirmed" });
      }
      if (a.status === "delete_confirmed") return finalizeMonday(a);
      return fail(a, "invalid_action_state");
    } catch (error) {
      return fail(a, classify(error));
    }
  }

  async function finalizeMonday(a) {
    // Bounded capability: exact board + item ID + one configured column only.
    await monday.clearExactRecordingLink({ boardId: TIMBERLINE_CALLS_BOARD, itemId: a.callsItemId, columnId: TIMBERLINE_RECORDING_LINK });
    const value = await monday.readExactRecordingLink({ boardId: TIMBERLINE_CALLS_BOARD, itemId: a.callsItemId, columnId: TIMBERLINE_RECORDING_LINK });
    if (value !== null) return fail(a, "monday_writer_race");
    await store.markMondayCleared(a);
    return Object.freeze({ outcome: "monday_link_cleared" });
  }
  async function fail(action, code) { await store.markException(action, code); return Object.freeze({ outcome: "exception", reason: code }); }
  return Object.freeze({ recordAnswerTimeDecision, receiveAssetEvent, runOnce });
}

function validateDecision(v) {
  if (!plain(v) || v.policyOutcome !== "two_party_delete" || !CALL.test(v.providerCallId ?? "") || !ITEM.test(String(v.callsItemId ?? ""))
    || !PHONE.test(v.externalPhoneDigits ?? "") || !PHONE.test(v.scopedPhoneDigits ?? "") || !timestamp(v.answeredAt) || !timestamp(v.callStartedAt)) throw new TypeError("invalid_two_party_decision");
  // Independent provider observations protect mappings where Calls-board Call ID differs.
  if (Date.parse(v.answeredAt) < Date.parse(v.callStartedAt) || Date.parse(v.answeredAt) - Date.parse(v.callStartedAt) > 86_400_000) throw new TypeError("invalid_two_party_decision");
  return Object.freeze({ providerCallId: v.providerCallId, callsItemId: String(v.callsItemId), externalPhoneDigits: v.externalPhoneDigits, scopedPhoneDigits: v.scopedPhoneDigits, answeredAt: v.answeredAt, callStartedAt: v.callStartedAt, policyOutcome: v.policyOutcome });
}
function validateAssetEvent(v) { if (!plain(v) || !CALL.test(v.providerCallId ?? "") || !CALL.test(v.assetId ?? "")) throw new TypeError("invalid_asset_event"); return Object.freeze({ providerCallId: v.providerCallId, assetId: v.assetId }); }
function validateClaim(v) { if (!plain(v) || !ITEM.test(String(v.id ?? "")) || !CALL.test(v.providerCallId ?? "") || !ITEM.test(String(v.callsItemId ?? "")) || !["delete_pending", "delete_requested", "delete_confirmed"].includes(v.status)) throw new Error("invalid_retention_claim"); return v; }
function assetKey(key, event) { return createHash("sha256").update(`${key}\0asset-v1\0${event.providerCallId}\0${event.assetId}`).digest("hex"); }
function callKey(key, providerCallId) { return createHash("sha256").update(`${key}\0call-v1\0${providerCallId}`).digest("hex"); }
function correlate(key, d) { return createHash("sha256").update(`${key}\0decision-v1\0${d.providerCallId}\0${d.callsItemId}\0${d.externalPhoneDigits}\0${d.scopedPhoneDigits}\0${d.answeredAt}\0${d.callStartedAt}`).digest("hex"); }
function timestamp(v) { return typeof v === "string" && ISO.test(v) && Number.isFinite(Date.parse(v)); }
function classify(error) { return error?.code === "monday_writer_race" ? "monday_writer_race" : "dependency_failure"; }
function requireMethod(o, n) { if (!o || typeof o[n] !== "function") throw new TypeError(`missing_${n}`); }
function plain(v) { return v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype; }
export function constantTimeEqualToken(a, b) { if (typeof a !== "string" || typeof b !== "string") return false; return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest()); }
