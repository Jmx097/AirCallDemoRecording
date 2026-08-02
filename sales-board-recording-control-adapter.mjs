export const SALES_BOARD_ID = "7727339040";
export const SALES_STATE_COLUMN_ID = "text_2";
export const SALES_PHONE_COLUMN_IDS = Object.freeze(["phone__1", "dup__of_phone7__1", "phone_mkrgdn4"]);
export const REQUIRED_CONSENT_LABELS = Object.freeze(["Verified — Permit Recording", "Verified — Do Not Record"]);
const PHONE = /^\d{10,15}$/;
const COLUMN = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const STATE = /^[A-Z]{2}$/;

export const SALES_CONTROL_LOOKUP_QUERY = `query RecordingControlPhone($boardId: ID!, $phoneColumnId: String!, $phoneDigits: String!, $columnIds: [String!]) {
  items_page_by_column_values(board_id: $boardId, columns: [{column_id: $phoneColumnId, column_values: [$phoneDigits]}], limit: 2) {
    items { id board { id } column_values(ids: $columnIds) { id text type } }
  }
}`;
export const SALES_CONTROL_SCHEMA_QUERY = `query RecordingControlSchema($boardId: [ID!]) { boards(ids: $boardId) { id columns { id type settings_str } } }`;

/** Read-only lookup against the one approved Sales Board. */
export function createSalesBoardControlAdapter({ consentColumnId, query } = {}) {
  if (typeof consentColumnId !== "string" || !COLUMN.test(consentColumnId)
    || [SALES_STATE_COLUMN_ID, ...SALES_PHONE_COLUMN_IDS].includes(consentColumnId)
    || typeof query !== "function") throw new TypeError("invalid_sales_control_adapter_config");
  const columnIds = Object.freeze([SALES_STATE_COLUMN_ID, ...SALES_PHONE_COLUMN_IDS, consentColumnId]);
  return Object.freeze({
    async resolveByPhone(phoneDigits) {
      if (typeof phoneDigits !== "string" || !PHONE.test(phoneDigits)) return Object.freeze({ status: "not_found" });
      const matches = new Map();
      for (const phoneColumnId of SALES_PHONE_COLUMN_IDS) {
        let response;
        try {
          response = await query({ query: SALES_CONTROL_LOOKUP_QUERY, variables: { boardId: SALES_BOARD_ID, phoneColumnId, phoneDigits, columnIds: [...columnIds] } });
        } catch { throw new Error("monday_read_failed"); }
        const items = response?.data?.items_page_by_column_values?.items;
        if (!Array.isArray(items) || items.length > 2) throw new Error("monday_read_failed");
        for (const item of items) {
          const evidence = parseItem(item, consentColumnId, phoneColumnId, phoneDigits);
          if (!evidence) throw new Error("monday_evidence_invalid");
          const prior = matches.get(evidence.itemKey);
          if (prior && (prior.state !== evidence.state || prior.consent.value !== evidence.consent.value)) throw new Error("monday_evidence_invalid");
          matches.set(evidence.itemKey, evidence);
        }
      }
      if (matches.size === 0) return Object.freeze({ status: "not_found" });
      if (matches.size !== 1) return Object.freeze({ status: "not_unique" });
      return Object.freeze({ status: "found", record: Object.freeze(matches.values().next().value) });
    },
    async checkSchema() {
      let response;
      try { response = await query({ query: SALES_CONTROL_SCHEMA_QUERY, variables: { boardId: [SALES_BOARD_ID] } }); }
      catch { return false; }
      const boards = response?.data?.boards;
      if (!Array.isArray(boards) || boards.length !== 1 || String(boards[0]?.id) !== SALES_BOARD_ID || !Array.isArray(boards[0].columns)) return false;
      const columns = boards[0].columns;
      const exact = (id, type) => columns.filter((x) => plain(x) && x.id === id && x.type === type).length === 1;
      if (!exact(SALES_STATE_COLUMN_ID, "text") || !SALES_PHONE_COLUMN_IDS.every((id) => exact(id, "phone")) || !exact(consentColumnId, "dropdown")) return false;
      const consent = columns.find((x) => plain(x) && x.id === consentColumnId && x.type === "dropdown");
      return validDropdownSettings(consent.settings_str);
    },
  });
}

function parseItem(item, consentColumnId, evidenceColumn, expectedPhone) {
  if (!plain(item) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(item.id ?? ""))
    || String(item.board?.id) !== SALES_BOARD_ID || !Array.isArray(item.column_values)) return null;
  const columns = item.column_values;
  const states = exactColumns(columns, SALES_STATE_COLUMN_ID, "text");
  const consents = exactColumns(columns, consentColumnId, "dropdown");
  const phones = new Map();
  for (const id of SALES_PHONE_COLUMN_IDS) {
    const found = exactColumns(columns, id, "phone");
    if (found.length !== 1) return null;
    phones.set(id, normalizedPhone(found[0].text));
  }
  if (states.length !== 1 || !STATE.test(states[0].text) || consents.length !== 1
    || !REQUIRED_CONSENT_LABELS.includes(consents[0].text) || phones.get(evidenceColumn) !== expectedPhone) return null;
  return Object.freeze({ itemKey: String(item.id), state: states[0].text,
    consent: Object.freeze({ value: consents[0].text, source: consentColumnId, verified: true }) });
}
function exactColumns(columns, id, type) { return columns.filter((x) => plain(x) && x.id === id && x.type === type); }
function validDropdownSettings(raw) {
  if (typeof raw !== "string" || raw.length > 16_384) return false;
  try {
    const settings = JSON.parse(raw);
    if (!plain(settings) || !Array.isArray(settings.labels)) return false;
    const labels = settings.labels.map((x) => typeof x === "string" ? x : (plain(x) && typeof x.name === "string" ? x.name : null));
    if (labels.length !== REQUIRED_CONSENT_LABELS.length || labels.some((x) => x === null) || new Set(labels).size !== labels.length
      || !REQUIRED_CONSENT_LABELS.every((label) => labels.filter((x) => x === label).length === 1)) return false;
    const multiple = settings.allow_multiple_selection ?? settings.allowMultipleSelection ?? settings.allow_multiple;
    return multiple === false;
  } catch { return false; }
}
function normalizedPhone(value) {
  if (typeof value !== "string" || value.length > 64) return null;
  const digits = value.replace(/\D/g, "");
  return PHONE.test(digits) ? digits : null;
}
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
