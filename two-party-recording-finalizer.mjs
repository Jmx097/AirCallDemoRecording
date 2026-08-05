import { timingSafeEqual } from "node:crypto";

/**
 * Staged, explicit two-party retention finalizer. It is intentionally not a
 * receiver and has no timer/start side effect: a reviewed scheduler must call
 * finalize() only with a durable, already-audited controller decision.
 */
export const CALLS_BOARD_ID = "18419412577";
export const COLUMNS = Object.freeze({
  callId: "text_mm4nwyyx",
  externalPhone: "phone_mm4n3c52",
  aircallNumber: "phone_mm4nps2a",
  recording: "link_mm4n5qp",
});
const PHONE = /^\d{10,15}$/;
const ITEM = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DATE_TITLES = Object.freeze(["Started", "Answered", "Ended"]);

/**
 * Finds a target only when both independently stored phone values and at least
 * two audited call times agree. Call ID is deliberately corroborating only:
 * controller audit hashes and Monday Call ID values are not assumed equivalent.
 */
export function resolveUniqueCallRow(decision, rows) {
  const expected = auditedCorrelation(decision);
  if (!expected || !Array.isArray(rows)) return Object.freeze({ status: "decision_or_rows_invalid" });
  const matches = [];
  for (const row of rows) {
    const normalized = normalizeRow(row);
    if (!normalized || normalized.externalPhone !== expected.externalPhone || normalized.aircallNumber !== expected.aircallNumber) continue;
    let timeMatches = 0;
    for (const name of DATE_TITLES) if (expected.times[name] !== null && normalized.times[name] === expected.times[name]) timeMatches += 1;
    // Exact time equality prevents a phone-number reuse from becoming a match.
    if (timeMatches < 2) continue;
    matches.push(Object.freeze({ itemId: normalized.itemId, callIdMatches: expected.callId !== null && normalized.callId === expected.callId, timeMatches }));
  }
  if (matches.length === 0) return Object.freeze({ status: "no_unique_target" });
  if (matches.length !== 1) return Object.freeze({ status: "ambiguous_target" });
  return Object.freeze({ status: "resolved", ...matches[0] });
}

/**
 * Deletes must already be reconciled before Monday is touched. The injected
 * decision reader is the trust boundary for a durable controller audit store.
 */
export function createDelayedMondayLinkFinalizer({ readAuditedDecision, reconcileDeletion, monday } = {}) {
  if (typeof readAuditedDecision !== "function" || typeof reconcileDeletion !== "function" || !monday
    || typeof monday.findCandidates !== "function" || typeof monday.clearRecordingLink !== "function" || typeof monday.readRecordingLink !== "function") throw new TypeError("invalid_finalizer_dependencies");
  return Object.freeze({
    async finalize(decisionId) {
      if (typeof decisionId !== "string" || !ITEM.test(decisionId)) return Object.freeze({ status: "invalid_decision_id" });
      const decision = await readAuditedDecision(decisionId);
      if (!isAuditedTwoPartyDecision(decision, decisionId)) return Object.freeze({ status: "decision_not_eligible" });
      // This is deliberately before any Monday read/mutation: a successful DELETE
      // response alone is not sufficient evidence of deletion.
      const deletion = await reconcileDeletion(decision);
      if (deletion?.deleted !== true) return Object.freeze({ status: "deletion_not_reconciled" });
      const candidates = await monday.findCandidates(decision.correlation);
      const target = resolveUniqueCallRow(decision, candidates);
      if (target.status !== "resolved") return target;
      await monday.clearRecordingLink(target.itemId);
      const value = await monday.readRecordingLink(target.itemId);
      if (!isBlankLink(value)) throw new Error("monday_recording_link_not_blank");
      return Object.freeze({ status: "link_cleared_and_verified", itemId: target.itemId, callIdMatches: target.callIdMatches });
    },
  });
}

/** A narrowly scoped Monday adapter: it never creates, deletes, or updates rows. */
export function createMondayCallsFinalizerAdapter({ mondayToken, fetchImpl = globalThis.fetch } = {}) {
  if (typeof mondayToken !== "string" || mondayToken.length < 16 || /[\0-\x1f\x7f]/.test(mondayToken) || typeof fetchImpl !== "function") throw new TypeError("invalid_monday_configuration");
  async function request(query, variables) {
    const response = await fetchImpl("https://api.monday.com/v2", { method: "POST", headers: { Authorization: mondayToken, "content-type": "application/json" }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error("monday_http_failed");
    const body = await response.json();
    if (body?.errors || !body?.data) throw new Error("monday_graphql_failed");
    return body.data;
  }
  async function schema() {
    const q = "query($b:[ID!]!){boards(ids:$b){id columns{id title type}}}";
    const board = (await request(q, { b: [CALLS_BOARD_ID] }))?.boards?.[0];
    if (String(board?.id) !== CALLS_BOARD_ID || !Array.isArray(board.columns)) throw new Error("monday_schema_unavailable");
    const ids = Object.create(null);
    for (const title of DATE_TITLES) {
      const found = board.columns.filter((column) => column?.title === title && typeof column.id === "string" && (column.type === "date" || column.type === "datetime"));
      if (found.length !== 1) throw new Error("monday_schema_ambiguous");
      ids[title] = found[0].id;
    }
    return ids;
  }
  async function findByPhone(column, digits) {
    const q = "query($b:ID!,$c:String!,$v:String!){items_page_by_column_values(board_id:$b,columns:[{column_id:$c,column_values:[$v]}],limit:100){items{id}}}";
    const items = (await request(q, { b: CALLS_BOARD_ID, c: column, v: digits }))?.items_page_by_column_values?.items;
    if (!Array.isArray(items)) throw new Error("monday_read_failed");
    return new Set(items.map((item) => String(item?.id ?? "")).filter((id) => ITEM.test(id)));
  }
  return Object.freeze({
    async findCandidates(correlation) {
      const normalized = correlationShape(correlation); if (!normalized) throw new Error("invalid_correlation");
      const [dateIds, external, aircall] = await Promise.all([schema(), findByPhone(COLUMNS.externalPhone, normalized.externalPhone), findByPhone(COLUMNS.aircallNumber, normalized.aircallNumber)]);
      const ids = [...external].filter((id) => aircall.has(id));
      if (ids.length === 0) return [];
      const q = "query($ids:[ID!]!,$columns:[String!]!){items(ids:$ids){id board{id} column_values(ids:$columns){id text type value}}}";
      const columns = [COLUMNS.callId, COLUMNS.externalPhone, COLUMNS.aircallNumber, dateIds.Started, dateIds.Answered, dateIds.Ended];
      const items = (await request(q, { ids, columns }))?.items;
      if (!Array.isArray(items) || items.length !== ids.length) throw new Error("monday_read_failed");
      return items.map((item) => ({ itemId: String(item.id), boardId: String(item?.board?.id), columns: item.column_values, dateColumnIds: dateIds }));
    },
    async clearRecordingLink(itemId) {
      if (!ITEM.test(String(itemId))) throw new Error("invalid_item_id");
      const q = "mutation($item:ID!,$board:ID!,$values:JSON!){change_multiple_column_values(item_id:$item,board_id:$board,column_values:$values){id}}";
      const data = await request(q, { item: itemId, board: CALLS_BOARD_ID, values: JSON.stringify({ [COLUMNS.recording]: null }) });
      if (String(data?.change_multiple_column_values?.id) !== String(itemId)) throw new Error("monday_write_failed");
    },
    async readRecordingLink(itemId) {
      if (!ITEM.test(String(itemId))) throw new Error("invalid_item_id");
      const q = "query($ids:[ID!]!,$columns:[String!]!){items(ids:$ids){id board{id} column_values(ids:$columns){id text value}}}";
      const item = (await request(q, { ids: [itemId], columns: [COLUMNS.recording] }))?.items?.[0];
      if (String(item?.id) !== String(itemId) || String(item?.board?.id) !== CALLS_BOARD_ID || item?.column_values?.length !== 1 || item.column_values[0]?.id !== COLUMNS.recording) throw new Error("monday_read_failed");
      return item.column_values[0];
    },
  });
}

function isAuditedTwoPartyDecision(value, decisionId) {
  return plain(value) && value.decisionId === decisionId && value.audited === true && value.controller === "two_party" && value.action === "delete_recording" && auditedCorrelation(value) !== null;
}
function auditedCorrelation(value) { return correlationShape(value?.correlation); }
function correlationShape(value) {
  if (!plain(value)) return null;
  const externalPhone = digits(value.externalPhone), aircallNumber = digits(value.aircallNumber);
  const times = Object.create(null);
  for (const title of DATE_TITLES) times[title] = instant(value[title.toLowerCase()]);
  const populated = Object.values(times).filter((time) => time !== null).length;
  const callId = typeof value.callId === "string" && ITEM.test(value.callId) ? value.callId : null;
  return externalPhone && aircallNumber && populated >= 2 ? Object.freeze({ externalPhone, aircallNumber, times: Object.freeze(times), callId }) : null;
}
function normalizeRow(value) {
  if (!plain(value) || !ITEM.test(String(value.itemId)) || String(value.boardId) !== CALLS_BOARD_ID || !Array.isArray(value.columns) || !plain(value.dateColumnIds)) return null;
  const byId = new Map(value.columns.map((column) => [column?.id, column]));
  const externalPhone = digits(byId.get(COLUMNS.externalPhone)?.text), aircallNumber = digits(byId.get(COLUMNS.aircallNumber)?.text);
  if (!externalPhone || !aircallNumber) return null;
  const times = Object.create(null);
  for (const title of DATE_TITLES) times[title] = instant(byId.get(value.dateColumnIds[title] ?? "")?.value ?? byId.get(value.dateColumnIds[title] ?? "")?.text);
  return { itemId: String(value.itemId), callId: typeof byId.get(COLUMNS.callId)?.text === "string" ? byId.get(COLUMNS.callId).text : null, externalPhone, aircallNumber, times };
}
function digits(value) { const result = typeof value === "string" ? value.replace(/\D/g, "") : ""; return PHONE.test(result) ? result : null; }
function instant(value) {
  if (typeof value !== "string" || value.length > 128) return null;
  let raw = value;
  try { const parsed = JSON.parse(value); if (plain(parsed)) raw = typeof parsed.date === "string" && typeof parsed.time === "string" ? `${parsed.date}T${parsed.time}Z` : parsed.date; } catch { /* text can itself be an ISO timestamp */ }
  const milliseconds = typeof raw === "string" ? Date.parse(raw) : NaN;
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}
function isBlankLink(value) { return plain(value) && value.id === COLUMNS.recording && (value.text === "" || value.text === null || value.text === undefined) && (value.value === "" || value.value === null || value.value === undefined); }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
// Keep a constant-time primitive available for future signed decision adapters without
// accidentally comparing raw identifiers with ordinary equality at that boundary.
export function constantTimeEqual(a, b) { return typeof a === "string" && typeof b === "string" && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
