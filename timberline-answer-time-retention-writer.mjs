import { TIMBERLINE_CALLS_BOARD, createTwoPartyRetentionFinalizer } from "./two-party-retention-finalizer.mjs";
import { createPostgresTwoPartyRetentionStore } from "./postgres-two-party-retention-store.mjs";

export const TIMBERLINE_CALL_ID_COLUMN = "text_mm4nwyyx";
const CALL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PHONE = /^\d{10,15}$/;

/**
 * Answer-time-only writer.  It has no deletion or Monday mutation capability:
 * it reads one Aircall call and one exact Calls-board row, then persists the
 * already-resolved two-party decision through the finalizer.
 */
export function createTimberlineAnswerTimeRetentionWriter({ aircallId, aircallKey, mondayToken, finalizer, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function" || !validSecret(aircallId) || !validSecret(aircallKey) || !validSecret(mondayToken) || !finalizer || typeof finalizer.recordAnswerTimeDecision !== "function") throw new TypeError("invalid_answer_time_retention_writer");
  const authorization = `Basic ${Buffer.from(`${aircallId}:${aircallKey}`).toString("base64")}`;

  async function recordAfterSuccessfulPause({ providerCallId, externalPhoneDigits } = {}) {
    if (!CALL_ID.test(providerCallId ?? "") || !PHONE.test(externalPhoneDigits ?? "")) throw new TypeError("invalid_answer_time_context");
    // This is deliberately a GET of the authoritative call detail, not webhook data.
    const detail = await aircallCall(providerCallId);
    const scopedPhoneDigits = extractPhone(detail, ["number.raw_digits", "number.digits", "number.phone_number", "number.phone"]);
    const trustedExternal = extractPhone(detail, ["raw_digits", "customer.raw_digits", "contact.raw_digits"]);
    const callStartedAt = extractTimestamp(detail, ["started_at", "startedAt"]);
    const answeredAt = extractTimestamp(detail, ["answered_at", "answeredAt"]);
    if (!scopedPhoneDigits || !trustedExternal || trustedExternal !== externalPhoneDigits || !callStartedAt || !answeredAt) throw new Error("untrusted_or_incomplete_aircall_call_detail");
    const callsItemId = await findExactCallsItem(providerCallId);
    if (!callsItemId) throw new Error("missing_or_ambiguous_calls_item");
    return finalizer.recordAnswerTimeDecision({ policyOutcome: "two_party_delete", providerCallId, callsItemId, externalPhoneDigits, scopedPhoneDigits, callStartedAt, answeredAt });
  }

  async function aircallCall(providerCallId) {
    const r = await fetchImpl(`https://api.aircall.io/v1/calls/${encodeURIComponent(providerCallId)}`, { method: "GET", headers: { Authorization: authorization }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error("aircall_call_detail_read_failed");
    const body = await r.json(); const call = body?.call ?? body;
    if (!plain(call) || (call.id !== undefined && String(call.id) !== providerCallId)) throw new Error("untrusted_aircall_call_detail");
    return call;
  }
  async function findExactCallsItem(providerCallId) {
    let exact = await lookupExactCallsItems(providerCallId);
    if (exact.size === 1) return exact.values().next().value;
    if (exact.size !== 0) return null;
    // The Calls ledger is a prerequisite capability at answer time. Create only
    // its immutable provider Call ID, then re-read it; never infer a row by phone
    // or reuse an existing mutable/recency-based association.
    const mutation = "mutation($board:ID!,$name:String!,$values:JSON!){create_item(board_id:$board,item_name:$name,column_values:$values){id}}";
    // This is the canonical visible ledger row for a governed two-party call.
    // Its immutable Aircall Call ID—not its label—remains the only authority.
    const data = await monday(mutation, { board: TIMBERLINE_CALLS_BOARD, name: "Two party state", values: JSON.stringify({ [TIMBERLINE_CALL_ID_COLUMN]: providerCallId }) });
    if (!CALL_ID.test(String(data?.create_item?.id ?? ""))) throw new Error("monday_calls_create_failed");
    exact = await lookupExactCallsItems(providerCallId);
    return exact.size === 1 ? exact.values().next().value : null;
  }
  async function lookupExactCallsItems(providerCallId) {
    const query = "query($board:ID!,$column:String!,$value:String!){items_page_by_column_values(board_id:$board,columns:[{column_id:$column,column_values:[$value]}],limit:2){items{id board{id} column_values(ids:[$column]){id text type}}}}";
    const data = await monday(query, { board: TIMBERLINE_CALLS_BOARD, column: TIMBERLINE_CALL_ID_COLUMN, value: providerCallId });
    const items = data?.items_page_by_column_values?.items;
    if (!Array.isArray(items) || items.length > 2) throw new Error("monday_calls_lookup_failed");
    return new Set(items.filter(item => String(item?.board?.id) === TIMBERLINE_CALLS_BOARD && CALL_ID.test(String(item?.id ?? "")) && item?.column_values?.[0]?.id === TIMBERLINE_CALL_ID_COLUMN && item?.column_values?.[0]?.type === "text" && item?.column_values?.[0]?.text === providerCallId).map(item => String(item.id)));
  }
  async function monday(query, variables) {
    const r = await fetchImpl("https://api.monday.com/v2", { method: "POST", headers: { Authorization: mondayToken, "content-type": "application/json" }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error("monday_calls_lookup_failed");
    const body = await r.json(); if (body?.errors || !plain(body?.data)) throw new Error("monday_calls_lookup_failed"); return body.data;
  }
  return Object.freeze({ recordAfterSuccessfulPause });
}

/** Deploy-time factory; it intentionally exposes only the answer-time writer. */
export function createTimberlineAnswerTimeRetentionWriterFromEnv(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  const required = key => { const value = env[key]; if (!validSecret(value)) throw new TypeError(`missing_${key}`); return value; };
  const store = createPostgresTwoPartyRetentionStore({ databaseUrl: required("TIMBERLINE_RETENTION_DATABASE_URL"), capabilityKey: required("TIMBERLINE_RETENTION_CAPABILITY_KEY") });
  // runOnce is never called by this writer. These methods are required solely by
  // the finalizer constructor and throw if incorrectly invoked in this lane.
  const disabled = async () => { throw new Error("answer_time_writer_has_no_destructive_capability"); };
  const finalizer = createTwoPartyRetentionFinalizer({ store, correlationKey: required("TIMBERLINE_RETENTION_CORRELATION_KEY"), aircall: { deleteRecording: disabled, recordingUnavailable: disabled }, monday: { clearExactRecordingLink: disabled, readExactRecordingLink: disabled } });
  return createTimberlineAnswerTimeRetentionWriter({ aircallId: required("AIRCALL_API_ID"), aircallKey: required("AIRCALL_API_KEY"), mondayToken: required("MONDAY_API_TOKEN"), finalizer, fetchImpl });
}
function extractPhone(value, paths) { for (const path of paths) { const v = get(value, path); if (typeof v === "string") { const digits = v.replace(/\D/g, ""); if (PHONE.test(digits)) return digits; } } return null; }
function extractTimestamp(value, paths) { for (const path of paths) { const v = get(value, path); const date = typeof v === "number" ? new Date(v < 100_000_000_000 ? v * 1000 : v) : typeof v === "string" ? new Date(v) : null; if (date && Number.isFinite(date.getTime())) return date.toISOString(); } return null; }
function get(value, path) { return path.split(".").reduce((x, key) => plain(x) ? x[key] : undefined, value); }
function plain(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
function validSecret(v) { return typeof v === "string" && v.length >= 16 && !/[\0-\x1f\x7f]/.test(v); }
