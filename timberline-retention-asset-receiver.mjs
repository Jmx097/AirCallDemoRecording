import http from "node:http";
import { createHash } from "node:crypto";
import { constantTimeEqualToken, createTwoPartyRetentionFinalizer } from "./two-party-retention-finalizer.mjs";
import { createPostgresTwoPartyRetentionStore } from "./postgres-two-party-retention-store.mjs";

const CALL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ASSET = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_BODY_BYTES = 64 * 1024;
const PATH = "/aircall/retention/assets";

/**
 * Parse only Aircall's call.comm_assets_generated webhook shape. data.id is the
 * immutable Aircall call id. An asset id must be supplied by Aircall, or a
 * stable identity is derived solely from an explicit asset URL/value.
 */
export function normalizeRetentionAssetEvent(text, token) {
  try {
    const payload = JSON.parse(text);
    if (!plain(payload) || payload.event !== "call.comm_assets_generated" || !constantTimeEqualToken(payload.token, token) || !plain(payload.data)) return null;
    const providerCallId = identifier(payload.data.id);
    if (!providerCallId) return null;
    const asset = extractAsset(payload.data);
    return asset ? Object.freeze({ providerCallId, assetId: asset }) : null;
  } catch { return null; }
}

export function createTimberlineRetentionAssetReceiver({ token, finalizer } = {}) {
  if (!secret(token) || !finalizer || typeof finalizer.receiveAssetEvent !== "function") throw new TypeError("invalid_retention_asset_receiver");
  const server = http.createServer({ maxHeaderSize: 8192 }, (request, response) => { void handle(request, response); });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000; server.maxRequestsPerSocket = 16;
  async function handle(request, response) {
    if (request.method === "GET" && request.url === "/health") return send(response, 200, { ok: true, service: "timberline-retention-asset-receiver" });
    if (request.method !== "POST" || request.url !== PATH || !/^application\/json(?:\s*;.*)?$/i.test(request.headers["content-type"] ?? "")) return send(response, 404, { accepted: false });
    const raw = await readBody(request, MAX_BODY_BYTES);
    if (raw === null) return send(response, 400, { accepted: false });
    const event = normalizeRetentionAssetEvent(raw, token);
    if (!event) return send(response, 401, { accepted: false });
    try {
      // This receiver deliberately owns no delete or Monday capability.
      const result = await finalizer.receiveAssetEvent(event);
      return send(response, 202, result);
    } catch { return send(response, 503, { accepted: false, outcome: "dependency_failure" }); }
  }
  return Object.freeze({
    start: ({ host = "127.0.0.1", port = 3340 } = {}) => listen(server, host, port),
    close: () => new Promise(resolve => server.close(() => resolve())),
  });
}

/** Deploy factory: receiver can enqueue only; worker holds destructive credentials. */
export function createTimberlineRetentionAssetReceiverFromEnv(env = process.env, { store, finalizer } = {}) {
  const required = key => { const value = env[key]; if (!secret(value)) throw new TypeError(`missing_${key}`); return value; };
  const queueStore = store ?? createPostgresTwoPartyRetentionStore({ databaseUrl: required("TIMBERLINE_RETENTION_DATABASE_URL"), capabilityKey: required("TIMBERLINE_RETENTION_CAPABILITY_KEY") });
  const disabled = async () => { throw new Error("asset_receiver_has_no_destructive_capability"); };
  const receiverFinalizer = finalizer ?? createTwoPartyRetentionFinalizer({ store: queueStore, correlationKey: required("TIMBERLINE_RETENTION_CORRELATION_KEY"), aircall: { deleteRecording: disabled, recordingUnavailable: disabled }, monday: { clearExactRecordingLink: disabled, readExactRecordingLink: disabled } });
  return createTimberlineRetentionAssetReceiver({ token: required("AIRCALL_RETENTION_WEBHOOK_TOKEN"), finalizer: receiverFinalizer });
}
function extractAsset(data) {
  const candidates = [data.asset_id, data.assetId, data.asset?.id, data.recording_id, data.recordingId, data.comm_asset_id, data.commAssetId];
  for (const candidate of candidates) { const id = identifier(candidate); if (id) return id; }
  // Aircall may emit a collection. Each HTTP event must name one asset to be safe.
  if (Array.isArray(data.assets) && data.assets.length === 1) { const id = identifier(data.assets[0]?.id); if (id) return id; const fallback = explicitAssetValue(data.assets[0]); if (fallback) return deterministicAssetId(fallback); }
  const fallback = explicitAssetValue(data.asset) ?? explicitAssetValue(data);
  return fallback ? deterministicAssetId(fallback) : null;
}
function explicitAssetValue(value) { if (!plain(value)) return null; for (const key of ["url", "recording_short_url", "recording_url", "recording", "download_url"]) if (typeof value[key] === "string" && value[key].length > 0 && value[key].length <= 4096) return value[key]; return null; }
function deterministicAssetId(value) { return `asset-${createHash("sha256").update(`aircall-asset-value-v1\0${value}`).digest("hex")}`; }
function identifier(value) { const id = typeof value === "string" ? value : Number.isSafeInteger(value) ? String(value) : null; return id && ASSET.test(id) ? id : null; }
function secret(value) { return typeof value === "string" && value.length >= 16 && !/[\0-\x1f\x7f]/.test(value); }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function readBody(request, limit) { return new Promise(resolve => { let size = 0; const parts = []; request.on("data", part => { size += part.length; if (size <= limit) parts.push(part); }); request.on("end", () => resolve(size <= limit ? Buffer.concat(parts).toString("utf8") : null)); request.on("error", () => resolve(null)); }); }
function send(response, status, body) { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(body)); }
function listen(server, host, port) { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => { const address = server.address(); resolve(Object.freeze({ host, port: typeof address === "object" && address ? address.port : port })); }); }); }
if (process.argv[1] === new URL(import.meta.url).pathname) { const receiver = createTimberlineRetentionAssetReceiverFromEnv(); receiver.start({ port: Number(process.env.AIRCALL_RETENTION_RECEIVER_PORT ?? "3340") }).catch(() => { process.exitCode = 1; }); }
