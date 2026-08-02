import { normalizeState } from "./consent.mjs";

const OPAQUE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NORMALIZED_PHONE = /^\d{10,15}$/;
const MISSING = Symbol("missing");

/**
 * Resolve a State-bearing item from an explicitly configured canonical board.
 * Adapter boundaries accept only raw JSON strings: parsing happens here, so no
 * adapter-supplied object (including a Proxy) can become canonical data.
 * Native lookup returns null when absent or a JSON object string; phone lookup
 * returns a JSON array string. Maps/candidate evidence and free text are denied.
 */
export async function resolveCanonicalConsent(input = {}) {
  if (!isObjectRecord(input)) return noRecord("none", "invalid_input");

  let config;
  try {
    config = {
      canonicalBoardId: input.canonicalBoardId,
      stateSource: input.stateSource,
      nativeItemId: input.nativeItemId,
      phoneDigits: input.phoneDigits,
      getConsentLeadById: input.getConsentLeadById,
      findConsentLeadsByPhone: input.findConsentLeadsByPhone,
    };
  } catch {
    return noRecord("none", "invalid_input");
  }

  const canonicalBoard = opaqueIdentifier(config.canonicalBoardId);
  if (!canonicalBoard) return noRecord("none", "invalid_canonical_board");
  const stateSource = opaqueIdentifier(config.stateSource);
  if (!stateSource) return noRecord("none", "invalid_state_source");

  const suppliedPhone = normalizedPhone(config.phoneDigits);
  if (!suppliedPhone) return noRecord("unique_phone", isMissingPhone(config.phoneDigits) ? "missing_phone" : "invalid_phone");

  let nativeResult = null;
  const nativeInput = nativeIdentifier(config.nativeItemId);
  if (nativeInput === MISSING) return noRecord("native_item_id", "invalid_native_item_id");
  if (nativeInput) {
    if (typeof config.getConsentLeadById !== "function") return noRecord("native_item_id", "native_lookup_unavailable");
    let payload;
    try {
      payload = await config.getConsentLeadById(nativeInput);
    } catch {
      return noRecord("native_item_id", "native_lookup_failed");
    }
    const native = parseNativePayload(payload);
    if (!native) return noRecord("native_item_id", "invalid_native_lookup_result");
    if (native.item) {
      nativeResult = validateItem(native.item, canonicalBoard, stateSource, "native_item_id", { expectedId: nativeInput, expectedPhone: suppliedPhone });
      if (!nativeResult.item) return nativeResult;
    }
  }

  if (typeof config.findConsentLeadsByPhone !== "function") return noRecord("unique_phone", "phone_lookup_unavailable");

  let payload;
  try {
    payload = await config.findConsentLeadsByPhone(suppliedPhone);
  } catch {
    return noRecord("unique_phone", "phone_lookup_failed");
  }
  const phoneItems = parsePhonePayload(payload);
  if (!phoneItems) return noRecord("unique_phone", "invalid_phone_lookup_result");
  if (phoneItems.length === 0) return noRecord("unique_phone", "phone_not_found");
  if (phoneItems.length !== 1) return noRecord("unique_phone", "phone_not_unique");

  const phoneResult = validateItem(phoneItems[0], canonicalBoard, stateSource, "unique_phone", { expectedPhone: suppliedPhone });
  if (!phoneResult.item) return phoneResult;
  if (nativeResult && phoneResult.item.id !== nativeResult.item.id) return noRecord("native_item_id", "native_phone_association_mismatch");
  return nativeResult || phoneResult;
}

function parseNativePayload(payload) {
  if (payload === null) return { item: null };
  if (typeof payload !== "string") return null;
  const parsed = parseJson(payload);
  return isJsonRecord(parsed) ? { item: parsed } : null;
}

function parsePhonePayload(payload) {
  if (typeof payload !== "string") return null;
  const parsed = parseJson(payload);
  return isPlainArray(parsed) ? parsed : null;
}

function parseJson(payload) {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function validateItem(item, canonicalBoardId, stateSource, method, { expectedId, expectedPhone } = {}) {
  const snapshot = snapshotItem(item);
  if (!snapshot) return noRecord(method, "invalid_item");
  const boardId = opaqueIdentifier(snapshot.boardId);
  const id = opaqueIdentifier(snapshot.id);
  if (!boardId || !id) return noRecord(method, "invalid_item");
  if (boardId !== canonicalBoardId) return noRecord(method, "canonical_board_mismatch");
  if (expectedId && id !== expectedId) return noRecord(method, "native_id_mismatch");

  const state = validatedProvenanceState(snapshot.state, stateSource);
  if (!state) return noRecord(method, "invalid_state_provenance");
  if (expectedPhone && !hasMatchingTrustedPhone(snapshot, expectedPhone)) return noRecord(method, "phone_mismatch");

  return { item: { id, boardId: canonicalBoardId, state }, method, reason: null };
}

function snapshotItem(item) {
  if (!isJsonRecord(item)) return null;
  const snapshot = ownDataSnapshot(item, ["id", "boardId", "state"]);
  if (!snapshot) return null;
  snapshot.phoneDigits = Object.hasOwn(item, "phoneDigits") ? item.phoneDigits : undefined;
  snapshot.phones = Object.hasOwn(item, "phones") ? item.phones : undefined;
  return snapshot;
}

function validatedProvenanceState(value, expectedSource) {
  const state = ownDataSnapshot(value, ["value", "source", "verified"]);
  if (!state || state.source !== expectedSource || state.verified !== true) return null;
  return normalizeState(state.value);
}

function hasMatchingTrustedPhone(item, expectedPhone) {
  if (normalizedPhone(item.phoneDigits) === expectedPhone) return true;
  if (!isPlainArray(item.phones)) return false;
  return item.phones.some((phone) => normalizedPhone(phone) === expectedPhone);
}

function ownDataSnapshot(value, keys) {
  if (!isJsonRecord(value)) return null;
  const snapshot = Object.create(null);
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) return null;
    snapshot[key] = value[key];
  }
  return snapshot;
}

function isJsonRecord(value) {
  try {
    return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function isPlainArray(value) {
  try {
    return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype;
  } catch {
    return false;
  }
}

function opaqueIdentifier(value) {
  return typeof value === "string" && OPAQUE_IDENTIFIER.test(value) ? value : null;
}

function nativeIdentifier(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string" && !value.trim()) return null;
  return opaqueIdentifier(value) || MISSING;
}

function normalizedPhone(value) {
  return typeof value === "string" && NORMALIZED_PHONE.test(value) ? value : null;
}

function isMissingPhone(value) {
  return value === undefined || value === null || value === "";
}

function isObjectRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function noRecord(method, reason) {
  return { item: null, method, reason };
}
