const OPAQUE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TYPE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const PHONE_INPUT = /^\d{10,15}$/;
const MAX_PHONE_COLUMNS = 16;
const PAGE_SIZE = 500;
const PHONE_LOOKUP_LIMIT = 2;
const PERMIT_RECORDING = "Verified — Permit Recording";
const NATIVE_QUERY = `query ReadCanonicalItem($itemId: ID!, $columnIds: [String!]) {
  items(ids: [$itemId]) {
    id
    board { id }
    column_values(ids: $columnIds) { id text type }
  }
}`;
const PHONE_LOOKUP_QUERY = `query ReadCanonicalPhoneMatches($boardId: ID!, $phoneColumnId: String!, $phoneDigits: String!, $columnIds: [String!]) {
  items_page_by_column_values(board_id: $boardId, columns: [{ column_id: $phoneColumnId, column_values: [$phoneDigits] }], limit: 2) {
    items {
      id
      board { id }
      column_values(ids: $columnIds) { id text type }
    }
  }
}`;

/** Strict injected, read-only Monday response boundary. No connection or write path exists. */
export function createMondayCallbackAdapter(config) {
  const safeConfig = validateConfig(config);
  if (!safeConfig) throw new Error("invalid_monday_adapter_config");
  const { canonicalBoardId, stateColumnId, consentColumnId, phoneColumnIds, allowedPhoneColumnTypes, stateSource, query } = safeConfig;
  const columnIds = [stateColumnId, consentColumnId, ...phoneColumnIds];

  return Object.freeze({
    async getConsentLeadById(nativeItemId) {
      if (!opaque(nativeItemId)) return null;
      let response;
      try {
        const received = queryResult(query, { query: NATIVE_QUERY, variables: { itemId: nativeItemId, columnIds: [...columnIds] } });
        response = received.promise ? await received.value : received.value;
      } catch {
        throw new Error("monday_read_failed");
      }
      try {
        const items = arrayAt(response, ["data", "items"]);
        if (!boundedItems(items, columnIds.length) || items.length !== 1) return null;
        // The remote response must not substitute another item for the requested ID.
        if (ownValue(items[0], "id") !== nativeItemId) return null;
        return canonicalJson(items[0], canonicalBoardId, stateColumnId, consentColumnId, phoneColumnIds, allowedPhoneColumnTypes, stateSource);
      } catch {
        return null;
      }
    },

    async findConsentLeadsByPhone(phoneDigits) {
      if (typeof phoneDigits !== "string" || !PHONE_INPUT.test(phoneDigits)) return "[]";
      const matches = [];
      const matchedIds = new Set();

      // Monday filters each configured phone column directly. Each request is capped at
      // two items, and there is deliberately no cursor/full-board fallback.
      for (const phoneColumnId of phoneColumnIds) {
        let response;
        try {
          const received = queryResult(query, { query: PHONE_LOOKUP_QUERY, variables: { boardId: canonicalBoardId, phoneColumnId, phoneDigits, columnIds: [...columnIds] } });
          response = received.promise ? await received.value : received.value;
        } catch {
          throw new Error("monday_read_failed");
        }
        try {
          const itemPage = ownObject(ownObject(response, "data"), "items_page_by_column_values");
          const items = itemPage && ownArray(itemPage, "items");
          if (!itemPage || !boundedItems(items, columnIds.length, PHONE_LOOKUP_LIMIT)) return "[]";
          for (const rawItem of items) {
            const canonical = canonicalObject(rawItem, canonicalBoardId, stateColumnId, consentColumnId, phoneColumnIds, allowedPhoneColumnTypes, stateSource);
            // Bind response evidence to both the exact requested digits and the column
            // that Monday was asked to search; never trust filtering alone.
            const matchedPhone = canonical && matchingPhone(rawItem, [phoneColumnId], allowedPhoneColumnTypes, phoneDigits);
            if (canonical && matchedPhone && !matchedIds.has(canonical.id)) {
              matchedIds.add(canonical.id);
              // Preserve the phone evidence returned by Monday; never substitute request input.
              matches.push({ ...canonical, phoneDigits: matchedPhone });
              // Resolver only distinguishes zero, one, and many; do not fetch/serialize beyond two.
              if (matches.length === 2) return JSON.stringify(matches);
            }
          }
        } catch {
          return "[]";
        }
      }
      return JSON.stringify(matches);
    },
  });
}

function validateConfig(config) {
  try {
    if (!plainObject(config)) return null;
    const canonicalBoardId = opaque(config.canonicalBoardId);
    const stateColumnId = opaque(config.stateColumnId);
    const consentColumnId = opaque(config.consentColumnId);
    const stateSource = opaque(config.stateSource);
    if (!canonicalBoardId || !stateColumnId || !consentColumnId || !stateSource || typeof config.query !== "function") return null;
    if (!plainArray(config.phoneColumnIds) || config.phoneColumnIds.length < 1 || config.phoneColumnIds.length > MAX_PHONE_COLUMNS) return null;
    const phoneColumnIds = config.phoneColumnIds.map(opaque);
    if (phoneColumnIds.some((id) => !id) || new Set(phoneColumnIds).size !== phoneColumnIds.length || stateColumnId === consentColumnId || phoneColumnIds.includes(stateColumnId) || phoneColumnIds.includes(consentColumnId)) return null;
    const configuredTypes = config.allowedPhoneColumnTypes === undefined ? ["phone"] : config.allowedPhoneColumnTypes;
    if (!plainArray(configuredTypes) || configuredTypes.length < 1 || configuredTypes.length > MAX_PHONE_COLUMNS) return null;
    const allowedPhoneColumnTypes = configuredTypes.map(typeName);
    if (allowedPhoneColumnTypes.some((type) => !type) || new Set(allowedPhoneColumnTypes).size !== allowedPhoneColumnTypes.length) return null;
    return { canonicalBoardId, stateColumnId, consentColumnId, phoneColumnIds, allowedPhoneColumnTypes, stateSource, query: config.query };
  } catch {
    return null;
  }
}

function queryResult(query, request) {
  const value = query(request);
  // Do not assimilate arbitrary thenables supplied as hostile response data.
  return { value, promise: value instanceof Promise };
}

function canonicalJson(rawItem, boardId, stateColumnId, consentColumnId, phoneColumnIds, allowedPhoneColumnTypes, source) {
  const record = canonicalObject(rawItem, boardId, stateColumnId, consentColumnId, phoneColumnIds, allowedPhoneColumnTypes, source);
  return record ? JSON.stringify(record) : null;
}

function canonicalObject(rawItem, expectedBoardId, stateColumnId, consentColumnId, phoneColumnIds, allowedPhoneColumnTypes, source) {
  const id = ownValue(rawItem, "id");
  const board = ownObject(rawItem, "board");
  const boardId = board && ownValue(board, "id");
  const columns = ownArray(rawItem, "column_values");
  if (!opaque(id) || boardId !== expectedBoardId || !boundedColumns(columns, 2 + phoneColumnIds.length)) return null;
  const states = columns.filter((column) => ownValue(column, "id") === stateColumnId);
  if (states.length !== 1) return null;
  const text = ownValue(states[0], "text");
  const type = ownValue(states[0], "type");
  if (!text.trim() || !["status", "dropdown"].includes(type.toLowerCase())) return null;
  const consents = columns.filter((column) => ownValue(column, "id") === consentColumnId);
  if (consents.length !== 1 || ownValue(consents[0], "type").toLowerCase() !== "dropdown" || ownValue(consents[0], "text") !== PERMIT_RECORDING) return null;
  const phones = unique(phoneColumnIds.flatMap((phoneColumnId) => columns
    .filter((column) => ownValue(column, "id") === phoneColumnId && allowedPhoneColumnTypes.includes(ownValue(column, "type").toLowerCase()))
    .map((column) => displayDigits(ownValue(column, "text")))
    .filter(Boolean)));
  return { id, boardId: expectedBoardId, state: { value: text.trim(), source, verified: true }, ...(phones.length ? { phones } : {}) };
}

function matchingPhone(rawItem, phoneColumnIds, allowedPhoneColumnTypes, expectedPhone) {
  const columns = ownArray(rawItem, "column_values");
  if (!columns) return null;
  for (const column of columns) {
    const id = ownValue(column, "id");
    const type = ownValue(column, "type");
    const digits = displayDigits(ownValue(column, "text"));
    if (phoneColumnIds.includes(id) && allowedPhoneColumnTypes.includes(type.toLowerCase()) && digits === expectedPhone) return digits;
  }
  return null;
}

function boundedItems(items, columnLimit, itemLimit = PAGE_SIZE) {
  return plainArray(items) && items.length <= itemLimit && items.every((item) => boundedItem(item, columnLimit));
}
function boundedItem(item, columnLimit) {
  const board = ownObject(item, "board");
  return opaque(ownValue(item, "id")) && board && opaque(ownValue(board, "id")) && boundedColumns(ownArray(item, "column_values"), columnLimit);
}
function boundedColumns(columns, limit) {
  return plainArray(columns) && columns.length <= limit && columns.every((column) => plainObject(column)
    && opaque(ownValue(column, "id"))
    && safeText(ownValue(column, "text"))
    && typeName(ownValue(column, "type")));
}
function safeText(value) { return typeof value === "string" && value.length <= 256; }
function displayDigits(value) {
  if (!safeText(value)) return null;
  const digits = value.replace(/\D/g, "");
  return PHONE_INPUT.test(digits) ? digits : null;
}
function unique(values) { return [...new Set(values)]; }

function arrayAt(value, keys) { let current = value; for (const key of keys) current = ownValue(current, key); return plainArray(current) ? current : null; }
function ownObject(value, key) { const child = ownValue(value, key); return plainObject(child) ? child : null; }
function ownArray(value, key) { const child = ownValue(value, key); return plainArray(child) ? child : null; }
function ownValue(value, key) { if (!plainObject(value) || !Object.hasOwn(value, key)) return undefined; return value[key]; }
function plainObject(value) { return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype; }
function plainArray(value) { return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype; }
function opaque(value) { return typeof value === "string" && OPAQUE_IDENTIFIER.test(value) ? value : null; }
function typeName(value) { return typeof value === "string" && TYPE_NAME.test(value) ? value.toLowerCase() : null; }

export const MONDAY_CALLBACK_READ_ONLY_QUERIES = Object.freeze({ native: NATIVE_QUERY, phoneLookup: PHONE_LOOKUP_QUERY, pageSize: PAGE_SIZE, phoneLookupLimit: PHONE_LOOKUP_LIMIT });
