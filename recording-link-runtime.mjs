import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";

const BOARD_ID = "7727339040";
const PHONE_COLUMNS = ["phone__1", "dup__of_phone7__1", "phone_mkrgdn4"];
const RECORDING_COLUMN = "link_mm5wtm6z";
const EVENTS = new Set(["call.ended", "call.comm_assets_generated"]);
const PHONE = /^\d{10,15}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HTTPS = /^https:\/\/[^\s]{1,2040}$/;

export function readConfig(env = process.env) {
  const required = ["AIRCALL_RECORDING_LINK_WEBHOOK_TOKEN", "AIRCALL_API_ID", "AIRCALL_API_KEY", "MONDAY_API_TOKEN"];
  for (const key of required) if (typeof env[key] !== "string" || env[key].length < 16 || /[\0-\x1f\x7f]/.test(env[key])) throw new TypeError("invalid_runtime_config");
  const port = Number(env.AIRCALL_RECORDING_LINK_PORT ?? "3339");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError("invalid_runtime_config");
  return Object.freeze({ webhookToken: env.AIRCALL_RECORDING_LINK_WEBHOOK_TOKEN, aircallId: env.AIRCALL_API_ID, aircallKey: env.AIRCALL_API_KEY, mondayToken: env.MONDAY_API_TOKEN, host: "127.0.0.1", port });
}

export function normalizeEvent(text, token) {
  try {
    const p = JSON.parse(text);
    if (!plain(p) || !equal(p.token, token) || !EVENTS.has(p.event) || !plain(p.data)) return null;
    const d = p.data, id = d.id, digits = d.raw_digits;
    if (typeof id !== "string" || !ID.test(id) || typeof digits !== "string" || !PHONE.test(digits)) return null;
    const url = recordingUrl(d);
    return Object.freeze({ callId: id, phoneDigits: digits, url, event: p.event, key: createHash("sha256").update(`${p.event}\0${id}\0${url ?? "pending"}`).digest("hex") });
  } catch { return null; }
}

export function createRuntime({ config = readConfig(), fetchImpl = globalThis.fetch } = {}) {
  if (!config || typeof fetchImpl !== "function") throw new TypeError("invalid_runtime_config");
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, service: "aircall-recording-link" });
    if (req.method !== "POST" || req.url !== "/aircall/recording/link-events" || !/^application\/json(?:\s*;.*)?$/i.test(req.headers["content-type"] ?? "")) return send(res, 404, { accepted: false });
    const raw = await body(req, 128 * 1024); if (!raw) return send(res, 400, { accepted: false });
    const event = normalizeEvent(raw, config.webhookToken); if (!event) return send(res, 401, { accepted: false });
    try {
      const url = event.url ?? await fetchRecordingUrl(event.callId);
      if (!url) return send(res, 202, { accepted: true, outcome: "recording_not_ready" });
      const ids = await findUniqueMondayItem(event.phoneDigits);
      if (ids.length !== 1) return send(res, 202, { accepted: true, outcome: ids.length ? "ambiguous_match" : "no_match" });
      await writeLink(ids[0], url);
      return send(res, 202, { accepted: true, outcome: "linked" });
    } catch { return send(res, 503, { accepted: false, outcome: "dependency_failure" }); }
  });
  async function fetchRecordingUrl(callId) {
    const r = await fetchImpl(`https://api.aircall.io/v1/calls/${encodeURIComponent(callId)}`, { headers: { Authorization: `Basic ${Buffer.from(`${config.aircallId}:${config.aircallKey}`).toString("base64")}` }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error("aircall_read_failed"); const c = await r.json(); return recordingUrl(c);
  }
  async function findUniqueMondayItem(digits) {
    const found = new Set();
    for (const column of PHONE_COLUMNS) {
      const q = `query($b:ID!,$c:String!,$p:String!){items_page_by_column_values(board_id:$b,columns:[{column_id:$c,column_values:[$p]}],limit:2){items{id board{id} column_values(ids:[$c]){id text type}}}}`;
      const data = await monday(q, { b: BOARD_ID, c: column, p: digits });
      const items = data?.items_page_by_column_values?.items; if (!Array.isArray(items) || items.length > 2) throw new Error("monday_read_failed");
      for (const item of items) { const col = item?.column_values?.[0]; const actual = typeof col?.text === "string" ? col.text.replace(/\D/g, "") : ""; if (item?.board?.id === BOARD_ID && typeof item.id === "string" && col?.id === column && col?.type === "phone" && actual === digits) found.add(item.id); }
    }
    return [...found];
  }
  async function writeLink(itemId, url) {
    const q = `mutation($item:ID!,$board:ID!,$values:JSON!){change_multiple_column_values(item_id:$item,board_id:$board,column_values:$values){id}}`;
    const values = JSON.stringify({ [RECORDING_COLUMN]: { url, text: "Aircall recording (expires per Aircall policy)" } });
    const d = await monday(q, { item: itemId, board: BOARD_ID, values }); if (!d?.change_multiple_column_values?.id) throw new Error("monday_write_failed");
  }
  async function monday(query, variables) {
    const r = await fetchImpl("https://api.monday.com/v2", { method: "POST", headers: { Authorization: config.mondayToken, "content-type": "application/json" }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error("monday_http_failed"); const j = await r.json(); if (j.errors) throw new Error("monday_graphql_failed"); return j.data;
  }
  return Object.freeze({ start: () => new Promise((resolve, reject) => { server.once("error", reject); server.listen(config.port, config.host, () => { const address = server.address(); resolve(Object.freeze({ host: config.host, port: typeof address === "object" && address ? address.port : config.port })); }); }), close: () => new Promise((resolve) => server.close(() => resolve())) });
}
function recordingUrl(call) { for (const k of ["recording_short_url", "recording"]) if (typeof call[k] === "string" && HTTPS.test(call[k])) return call[k]; return null; }
function equal(a, b) { if (typeof a !== "string" || typeof b !== "string") return false; return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest()); }
function plain(v) { return v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype; }
function body(req, max) { return new Promise((resolve) => { let n=0, a=[]; req.on("data", c => { n+=c.length; if(n<=max)a.push(c); }); req.on("end", () => resolve(n<=max ? Buffer.concat(a).toString("utf8") : null)); req.on("error", () => resolve(null)); }); }
function send(res, status, value) { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); }
if (process.argv[1] === new URL(import.meta.url).pathname) { const r = createRuntime(); r.start().catch(() => { process.exitCode = 1; }); }
