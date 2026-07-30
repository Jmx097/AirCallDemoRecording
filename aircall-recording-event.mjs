import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const MAX_PAYLOAD_BYTES = 128 * 1024;
const MAX_ROOT_KEYS = 16;
const MAX_RECORD_KEYS = 64;
const MAX_STRING_LENGTH = 2048;
const MAX_CALL_ID_LENGTH = 128;
const MAX_ALLOWED_EVENTS = 16;
const DEFAULT_ALLOWED_EVENTS = Object.freeze(["call.answered"]);
const EVENT_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const CALL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PHONE_DIGITS = /^[0-9]{10,15}$/;
const OPAQUE_TOKEN = /^[\x21-\x7e]{1,2048}$/;
const HEX_64 = /^[a-f0-9]{64}$/;

/**
 * Pure, fail-closed normalization boundary for an Aircall call.answered webhook body.
 * It accepts only raw JSON and caller-supplied configuration; it performs no I/O.
 */
export function normalizeAuthenticatedAircallRecordingEvent(input) {
  try {
    const config = readConfig(input);
    if (!config) return rejected("invalid_configuration");

    const parsed = parsePayload(config.payloadJson);
    if (!parsed) return rejected("invalid_payload");

    const receivedToken = ownDataValue(parsed, "token");
    if (!safeToken(receivedToken) || !constantTimeEqual(receivedToken, config.expectedWebhookToken)) return rejected("unauthenticated");

    const eventName = ownDataValue(parsed, "event");
    if (!validEventName(eventName)) return rejected("invalid_event");
    if (!config.allowedEvents.includes(eventName)) return rejected("unsupported_event");

    const call = extractSingleCall(parsed);
    if (!call) return rejected("invalid_call");
    const callId = ownDataValue(call, "id");
    const phoneDigits = ownDataValue(call, "raw_digits");
    if (!validCallId(callId) || !validPhoneDigits(phoneDigits)) return rejected("invalid_call");

    // Token-keyed opaque audit correlation for this configured webhook scope only.
    // Deliberately exclude phone, timestamps, and the raw payload.
    const eventKey = createHmac("sha256", config.expectedWebhookToken)
      .update(`aircall-recording-v1\0${eventName}\0${callId}`, "utf8")
      .digest("hex");
    return Object.freeze({ accepted: true, eventName, callId, phoneDigits, eventKey, correlation: eventKey.slice(0, 24) });
  } catch {
    // Never surface parser, Proxy, getter, or configuration errors to an ingress caller.
    return rejected("invalid_configuration");
  }
}

/** Returns the minimal audit/decision-service event, or null for anything non-normalized. */
export function toDecisionServiceEvent(normalized) {
  try {
    if (!plainRecord(normalized) || ownDataValue(normalized, "accepted") !== true) return null;
    const eventKey = ownDataValue(normalized, "eventKey");
    const callId = ownDataValue(normalized, "callId");
    const phoneDigits = ownDataValue(normalized, "phoneDigits");
    const correlation = ownDataValue(normalized, "correlation");
    if (!HEX_64.test(eventKey) || !validCallId(callId) || !validPhoneDigits(phoneDigits) || correlation !== eventKey.slice(0, 24)) return null;
    return Object.freeze({ eventKey, callId, phoneDigits, correlation });
  } catch {
    return null;
  }
}

function readConfig(input) {
  if (!plainRecord(input)) return null;
  const payloadJson = ownDataValue(input, "payloadJson");
  const expectedWebhookToken = ownDataValue(input, "expectedWebhookToken");
  if (typeof payloadJson !== "string" || !safeToken(expectedWebhookToken)) return null;

  const allowedDescriptor = ownDataDescriptor(input, "allowedEvents");
  const configuredEvents = allowedDescriptor === undefined ? DEFAULT_ALLOWED_EVENTS : allowedDescriptor.value;
  const allowedEvents = validAllowedEvents(configuredEvents);
  return allowedEvents ? { payloadJson, expectedWebhookToken, allowedEvents } : null;
}

function parsePayload(payloadJson) {
  if (Buffer.byteLength(payloadJson, "utf8") > MAX_PAYLOAD_BYTES) return null;
  let payload;
  try { payload = JSON.parse(payloadJson); } catch { return null; }
  return boundedRecord(payload, MAX_ROOT_KEYS) ? payload : null;
}

function extractSingleCall(payload) {
  const data = ownDataValue(payload, "data");
  // The locally observed, redacted contract has the complete call directly at data.
  // Reject unverified wrappers rather than selecting a call from data.call or root call.
  if (Object.hasOwn(payload, "call") || !boundedRecord(data, MAX_RECORD_KEYS) || Object.hasOwn(data, "call")) return null;
  return data;
}

function validAllowedEvents(value) {
  if (!plainArray(value) || value.length < 1 || value.length > MAX_ALLOWED_EVENTS) return null;
  if (!value.every(validEventName) || new Set(value).size !== value.length) return null;
  return Object.freeze([...value]);
}

function constantTimeEqual(actual, expected) {
  const actualDigest = createHash("sha256").update(actual, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function rejected(reason) { return Object.freeze({ accepted: false, reason }); }
function safeToken(value) { return typeof value === "string" && OPAQUE_TOKEN.test(value); }
function validEventName(value) { return typeof value === "string" && value.length <= 64 && EVENT_NAME.test(value); }
function validCallId(value) { return typeof value === "string" && value.length <= MAX_CALL_ID_LENGTH && CALL_ID.test(value); }
function validPhoneDigits(value) { return typeof value === "string" && value.length <= MAX_STRING_LENGTH && PHONE_DIGITS.test(value); }
function boundedRecord(value, limit) { return plainRecord(value) && Object.keys(value).length <= limit; }
function plainRecord(value) { return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype; }
function plainArray(value) { return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype; }
function ownDataDescriptor(value, key) {
  if (!plainRecord(value) || !Object.hasOwn(value, key)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor : null;
}
function ownDataValue(value, key) {
  const descriptor = ownDataDescriptor(value, key);
  return descriptor && descriptor !== undefined ? descriptor.value : undefined;
}
