import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const CALL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PHONE = /^\d{10,15}$/;
const TOKEN = /^[\x21-\x7e]{16,2048}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_BYTES = 128 * 1024;

/** Strict control-plane boundary for the documented direct payload.data call. */
export function normalizeAircallAnsweredControlEvent({ payloadJson, expectedWebhookToken, idempotencyKey = expectedWebhookToken } = {}) {
  try {
    if (typeof payloadJson !== "string" || Buffer.byteLength(payloadJson) > MAX_BYTES || !TOKEN.test(expectedWebhookToken ?? "") || !TOKEN.test(idempotencyKey ?? "")) return reject("invalid_configuration");
    const root = JSON.parse(payloadJson);
    if (!record(root) || !exactKeys(root, ["event", "token", "data"]) || root.event !== "call.answered") return reject("invalid_event");
    if (typeof root.token !== "string" || !TOKEN.test(root.token) || !equal(root.token, expectedWebhookToken)) return reject("unauthenticated");
    // Aircall's documented shape is root.data === call. Wrapper forms such as
    // data.call or root.call are deliberately not accepted.
    if (!record(root.data) || Object.hasOwn(root.data, "call") || Object.keys(root.data).length > 64) return reject("invalid_event");
    const call = root.data;
    if (typeof call.id !== "string" || !CALL_ID.test(call.id) || typeof call.raw_digits !== "string" || !PHONE.test(call.raw_digits)) return reject("invalid_event");
    const userId = directId(call.user);
    const numberId = directId(call.number);
    if (userId === null || numberId === null) return reject("invalid_event");
    const eventKey = keyed(idempotencyKey, `recording-control-event-v1\0call.answered\0${call.id}`);
    const actionKey = keyed(idempotencyKey, `recording-control-action-v1\0${eventKey}\0resume_recording`);
    return Object.freeze({ accepted: true, eventKey, actionKey, callId: call.id, phoneDigits: call.raw_digits, userId, numberId });
  } catch { return reject("invalid_event"); }
}

function directId(value) {
  if (!record(value) || Object.keys(value).length > 16) return null;
  const id = value.id;
  if (typeof id === "string" && OPAQUE_ID.test(id)) return id;
  if (Number.isSafeInteger(id) && id >= 0) return id;
  return null;
}
function keyed(token, value) { return createHmac("sha256", token).update(value, "utf8").digest("hex"); }
function equal(a, b) { return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest()); }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exactKeys(value, expected) { const keys = Object.keys(value); return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key)); }
function reject(reason) { return Object.freeze({ accepted: false, reason }); }
