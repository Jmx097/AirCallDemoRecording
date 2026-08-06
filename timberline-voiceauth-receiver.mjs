import http from "node:http";
import { createHash } from "node:crypto";
import { constantTimeEqualToken } from "./two-party-retention-finalizer.mjs";
import { createPostgresTwoPartyRetentionStore } from "./postgres-two-party-retention-store.mjs";

const PATH = "/aircall/recording/voiceauth-events";
const CALL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TAG = /^\d{1,20}$/;
const MAX_BODY_BYTES = 64 * 1024;

// A non-destructive, authenticated ingress for Aircall call.tagged only. It never
// pauses/resumes/deletes recordings and it never writes Monday.
export function normalizeVoiceAuthEvent(text, token, voiceAuthTagId) {
  try {
    const payload = JSON.parse(text);
    if (!plain(payload) || payload.event !== "call.tagged" || !constantTimeEqualToken(payload.token, token) || !plain(payload.data)) return null;
    const providerCallId = id(payload.data.id);
    if (!providerCallId || !TAG.test(String(voiceAuthTagId ?? "")) || !containsTag(payload.data.tags, String(voiceAuthTagId))) return null;
    return Object.freeze({ providerCallId, eventKeyHash: createHash("sha256").update(`voiceauth-event-v1\0${providerCallId}\0${voiceAuthTagId}`).digest("hex") });
  } catch { return null; }
}

export function createVoiceAuthReceiver({ token, voiceAuthTagId, correlationKey, store } = {}) {
  if (!secret(token) || !TAG.test(String(voiceAuthTagId ?? "")) || !secret(correlationKey) || !store || typeof store.recordVoiceAuthOverride !== "function") throw new TypeError("invalid_voiceauth_receiver");
  const server = http.createServer({ maxHeaderSize: 8192 }, (request, response) => { void handle(request, response); });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000; server.maxRequestsPerSocket = 16;
  async function handle(request, response) {
    if (request.method === "GET" && request.url === "/health") return send(response, 200, { ok: true, service: "timberline-voiceauth-receiver", tagConfigured: true });
    if (request.method !== "POST" || request.url !== PATH || !/^application\/json(?:\s*;.*)?$/i.test(request.headers["content-type"] ?? "")) return send(response, 404, { accepted: false });
    const raw = await body(request);
    const event = raw === null ? null : normalizeVoiceAuthEvent(raw, token, voiceAuthTagId);
    if (!event) return send(response, 401, { accepted: false });
    try {
      const providerCallKeyHash = createHash("sha256").update(`${correlationKey}\0call-v1\0${event.providerCallId}`).digest("hex");
      await store.recordVoiceAuthOverride({ providerCallKeyHash, eventKeyHash: event.eventKeyHash });
      return send(response, 202, { accepted: true, outcome: "voiceauth_retained" });
    } catch { return send(response, 503, { accepted: false, outcome: "dependency_failure" }); }
  }
  return Object.freeze({ start: ({ host = "127.0.0.1", port = 3341 } = {}) => listen(server, host, port), close: () => new Promise(resolve => server.close(() => resolve())) });
}

export function createVoiceAuthReceiverFromEnv(env = process.env, { store } = {}) {
  const required = key => { const value = env[key]; if (!secret(value)) throw new TypeError(`missing_${key}`); return value; };
  const tag = env.AIRCALL_VOICEAUTH_TAG_ID;
  if (!TAG.test(String(tag ?? ""))) throw new TypeError("missing_AIRCALL_VOICEAUTH_TAG_ID");
  const queueStore = store ?? createPostgresTwoPartyRetentionStore({ databaseUrl: required("TIMBERLINE_RETENTION_DATABASE_URL"), capabilityKey: required("TIMBERLINE_RETENTION_CAPABILITY_KEY") });
  return createVoiceAuthReceiver({ token: required("AIRCALL_VOICEAUTH_WEBHOOK_TOKEN"), voiceAuthTagId: tag, correlationKey: required("TIMBERLINE_RETENTION_CORRELATION_KEY"), store: queueStore });
}
function containsTag(tags, wanted) { return Array.isArray(tags) && tags.length <= 64 && tags.some(tag => plain(tag) && String(tag.id ?? "") === wanted); }
function id(value) { const text = typeof value === "string" ? value : Number.isSafeInteger(value) ? String(value) : null; return text && CALL.test(text) ? text : null; }
function secret(value) { return typeof value === "string" && value.length >= 16 && !/[\0-\x1f\x7f]/.test(value); }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function body(request) { return new Promise(resolve => { let size = 0; const chunks = []; request.on("data", chunk => { size += chunk.length; if (size <= MAX_BODY_BYTES) chunks.push(chunk); }); request.on("end", () => resolve(size <= MAX_BODY_BYTES ? Buffer.concat(chunks).toString("utf8") : null)); request.on("error", () => resolve(null)); }); }
function send(response, status, body) { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(body)); }
function listen(server, host, port) { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => { const address = server.address(); resolve(Object.freeze({ host, port: typeof address === "object" && address ? address.port : port })); }); }); }
if (process.argv[1] === new URL(import.meta.url).pathname) { const receiver = createVoiceAuthReceiverFromEnv(); receiver.start({ port: Number(process.env.AIRCALL_VOICEAUTH_RECEIVER_PORT ?? "3341") }).catch(() => { process.exitCode = 1; }); }
