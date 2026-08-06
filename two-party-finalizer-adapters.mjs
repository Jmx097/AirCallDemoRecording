import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";

const CALL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PHONE = /^\d{10,15}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/**
 * An append-only encrypted local journal. It is deliberately separate from the
 * redacted controller JSONL: only this root-only file contains call references.
 * Each line is AES-256-GCM authenticated and additionally binds a monotonically
 * independent HMAC key, so an accidental key-role swap fails closed.
 */
export function createProtectedTwoPartyStore({ file, capabilityKey, hmacKey, random = randomBytes } = {}) {
  if (typeof file !== "string" || !file.startsWith("/") || typeof random !== "function") throw new TypeError("invalid_two_party_store_config");
  const encryptionKey = key32(capabilityKey, "capabilityKey");
  const integrityKey = key32(hmacKey, "hmacKey");
  async function append(type, value) {
    const payload = JSON.stringify({ v: 1, type, value });
    const iv = Buffer.from(random(12)); if (iv.length !== 12) throw new Error("invalid_entropy");
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
    cipher.setAAD(Buffer.from(type));
    const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const mac = hmac(integrityKey, `${type}.${iv.toString("base64")}.${ciphertext.toString("base64")}.${tag.toString("base64")}`);
    await mkdir(new URL(".", `file://${file}`).pathname, { recursive: true, mode: 0o700 });
    await appendFile(file, `${JSON.stringify({ v: 1, type, iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: tag.toString("base64"), mac })}\n`, { mode: 0o600 });
    await chmod(file, 0o600);
  }
  async function records() {
    let text; try { text = await readFile(file, "utf8"); } catch (error) { if (error?.code === "ENOENT") return []; throw error; }
    const values = [];
    for (const line of text.split("\n")) { if (!line) continue; values.push(decryptLine(line, encryptionKey, integrityKey)); }
    return values;
  }
  async function captureEvent(event) {
    const value = eventCorrelation(event); if (!value) return Object.freeze({ stored: false, reason: "invalid_event" });
    const prior = await records(); const current = prior.filter(x => x.type === "correlation" && x.value.callId === value.callId).at(-1)?.value;
    const merged = mergeCorrelation(current, value); if (!merged) return Object.freeze({ stored: false, reason: "correlation_conflict" });
    if (JSON.stringify(current) === JSON.stringify(merged)) return Object.freeze({ stored: true, duplicate: true });
    await append("correlation", merged); return Object.freeze({ stored: true, duplicate: false });
  }
  async function persistDecision(input) {
    const decision = signedTrustedDecision(input, hmacKey); if (!decision) throw new TypeError("invalid_trusted_two_party_decision");
    const prior = await records(); const existing = prior.filter(x => x.type === "decision" && x.value.decisionId === decision.decisionId).at(-1)?.value;
    if (existing) { if (!same(existing, decision)) throw new Error("decision_id_conflict"); return Object.freeze({ stored: true, duplicate: true }); }
    const correlation = prior.filter(x => x.type === "correlation" && x.value.callId === decision.correlation.callId).at(-1)?.value;
    if (!correlation || !same(correlation, decision.correlation)) throw new Error("trusted_correlation_missing");
    await append("decision", decision); return Object.freeze({ stored: true, duplicate: false });
  }
  async function readAuditedDecision(decisionId) { if (!ID.test(decisionId ?? "")) return null; return (await records()).filter(x => x.type === "decision" && x.value.decisionId === decisionId).at(-1)?.value ?? null; }
  async function pendingDecisionIds() {
    const all = await records(); const decisions = new Map(); const terminal = new Set();
    for (const x of all) { if (x.type === "decision") decisions.set(x.value.decisionId, x.value); if (x.type === "monday_finalized") terminal.add(x.value.decisionId); }
    return [...decisions.keys()].filter(id => !terminal.has(id));
  }
  async function state(decisionId) { return (await records()).filter(x => x.value?.decisionId === decisionId); }
  async function recordDeletionRequest(decisionId) { await append("deletion_requested", { decisionId, at: new Date().toISOString() }); }
  async function recordDeletionReconciled(decisionId) { await append("deletion_reconciled", { decisionId, at: new Date().toISOString() }); }
  async function recordMondayFinalized(decisionId, itemId) { await append("monday_finalized", { decisionId, itemId, at: new Date().toISOString() }); }
  return Object.freeze({ captureEvent, persistDecision, readAuditedDecision, pendingDecisionIds, state, recordDeletionRequest, recordDeletionReconciled, recordMondayFinalized });
}

/** Aircall adapter never exposes credentials and treats any network write as ambiguous until GET proves recording is absent. */
export function createAircallDeletionReconciler({ apiId, apiKey, idempotencyKey, fetchImpl = globalThis.fetch, store } = {}) {
  if (!text(apiId) || !text(apiKey) || !text(idempotencyKey) || typeof fetchImpl !== "function" || !store || typeof store.state !== "function") throw new TypeError("invalid_aircall_deletion_configuration");
  const authorization = `Basic ${Buffer.from(`${apiId}:${apiKey}`, "utf8").toString("base64")}`;
  async function reconcileDeletion(decision) {
    if (!trustedDecision(decision)) return Object.freeze({ deleted: false });
    const history = await store.state(decision.decisionId);
    const reconciled = history.some(x => x.type === "deletion_reconciled"); if (reconciled) return Object.freeze({ deleted: true, source: "durable_reconciliation" });
    // A request can have reached Aircall even if our client timed out. Never repeat it;
    // poll GET only, leaving an unreconciled decision for a human/retry policy.
    if (!history.some(x => x.type === "deletion_requested")) {
      await store.recordDeletionRequest(decision.decisionId);
      let response; try { response = await fetchImpl(recordingEndpoint(decision.correlation.callId), { method: "DELETE", headers: { authorization, "x-idempotency-key": hmac(Buffer.from(idempotencyKey), `aircall-delete-v1\0${decision.decisionId}`) }, redirect: "error", signal: AbortSignal.timeout(8000) }); } catch { return Object.freeze({ deleted: false, reason: "delete_outcome_unknown" }); }
      if (response?.ok !== true && response?.status !== 404) return Object.freeze({ deleted: false, reason: "delete_not_accepted" });
    }
    let read; try { read = await fetchImpl(callEndpoint(decision.correlation.callId), { headers: { authorization }, redirect: "error", signal: AbortSignal.timeout(8000) }); } catch { return Object.freeze({ deleted: false, reason: "reconciliation_unavailable" }); }
    if (read?.ok !== true) return Object.freeze({ deleted: false, reason: "reconciliation_unavailable" });
    let body; try { body = await read.json(); } catch { return Object.freeze({ deleted: false, reason: "reconciliation_unavailable" }); }
    if (!recordingAbsent(body?.call ?? body)) return Object.freeze({ deleted: false, reason: "recording_still_present" });
    await store.recordDeletionReconciled(decision.decisionId); return Object.freeze({ deleted: true, source: "aircall_readback" });
  }
  return Object.freeze({ reconcileDeletion });
}

export function signTrustedDecision({ decisionId, correlation }, hmacKey) {
  const decision = trustedDecision({ decisionId, audited: true, controller: "two_party", action: "delete_recording", correlation });
  if (!decision) throw new TypeError("invalid_trusted_two_party_decision");
  return Object.freeze({ ...decision, signature: hmac(key32(hmacKey, "hmacKey"), `two-party-decision-v1\0${JSON.stringify(decision)}`) });
}
export function signedTrustedDecision({ decisionId, correlation, signature }, hmacKey) {
  const decision = trustedDecision({ decisionId, audited: true, controller: "two_party", action: "delete_recording", correlation });
  if (!decision || typeof signature !== "string") return null;
  const expected = hmac(key32(hmacKey, "hmacKey"), `two-party-decision-v1\0${JSON.stringify(decision)}`);
  return constantTime(signature, expected) ? Object.freeze(decision) : null;
}
function eventCorrelation(event) { const c = normalizeCorrelation(event?.correlation ?? event); return c ? Object.freeze(c) : null; }
function mergeCorrelation(before, next) { if (!before) return next; if (before.callId !== next.callId || before.externalPhone !== next.externalPhone || before.aircallNumber !== next.aircallNumber) return null; const out = { ...before }; for (const key of ["started", "answered", "ended"]) { if (before[key] && next[key] && before[key] !== next[key]) return null; out[key] ??= next[key]; } return normalizeCorrelation(out); }
function trustedDecision(v) { const c = normalizeCorrelation(v?.correlation); return plain(v) && ID.test(v.decisionId ?? "") && v.audited === true && v.controller === "two_party" && v.action === "delete_recording" && c && [c.started, c.answered, c.ended].filter(Boolean).length >= 2 ? Object.freeze({ decisionId: v.decisionId, audited: true, controller: "two_party", action: "delete_recording", correlation: c }) : null; }
function normalizeCorrelation(v) { if (!plain(v) || !CALL.test(v.callId ?? "")) return null; const externalPhone = digits(v.externalPhone), aircallNumber = digits(v.aircallNumber); const out = { callId: v.callId, externalPhone, aircallNumber }; if (!externalPhone || !aircallNumber) return null; for (const key of ["started", "answered", "ended"]) { if (v[key] != null && (!ISO.test(v[key]) || Number.isNaN(Date.parse(v[key])))) return null; out[key] = v[key] ?? null; } return Object.freeze(out); }
function decryptLine(line, encryptionKey, integrityKey) { let x; try { x = JSON.parse(line); } catch { throw new Error("protected_store_corrupt"); } if (!plain(x) || x.v !== 1 || !["correlation", "decision", "deletion_requested", "deletion_reconciled", "monday_finalized"].includes(x.type) || ![x.iv, x.ciphertext, x.tag, x.mac].every(text)) throw new Error("protected_store_corrupt"); const expected = hmac(integrityKey, `${x.type}.${x.iv}.${x.ciphertext}.${x.tag}`); if (!constantTime(x.mac, expected)) throw new Error("protected_store_corrupt"); try { const d = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(x.iv, "base64")); d.setAAD(Buffer.from(x.type)); d.setAuthTag(Buffer.from(x.tag, "base64")); const payload = JSON.parse(Buffer.concat([d.update(Buffer.from(x.ciphertext, "base64")), d.final()]).toString("utf8")); if (payload?.v !== 1 || payload?.type !== x.type || !plain(payload.value)) throw new Error(); return payload; } catch { throw new Error("protected_store_corrupt"); } }
function recordingAbsent(call) { return plain(call) && !["recording", "recording_url", "recording_short_url"].some(k => typeof call[k] === "string" && call[k].trim() !== ""); }
function callEndpoint(callId) { return `https://api.aircall.io/v1/calls/${encodeURIComponent(callId)}`; }
function recordingEndpoint(callId) { return `${callEndpoint(callId)}/recording`; }
function key32(value, name) { const key = Buffer.from(value ?? "", "base64"); if (key.length !== 32 || key.toString("base64") !== value) throw new TypeError(`invalid_${name}`); return key; }
function hmac(key, input) { return createHmac("sha256", key).update(input).digest("hex"); }
function constantTime(a, b) { return typeof a === "string" && typeof b === "string" && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
function digits(v) { const x = typeof v === "string" ? v.replace(/\D/g, "") : ""; return PHONE.test(x) ? x : null; }
function plain(v) { return v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype; }
function text(v) { return typeof v === "string" && v.length > 0 && v.length < 10000; }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
