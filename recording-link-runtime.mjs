import http from "node:http";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";

const RULESET = Object.freeze(JSON.parse(readFileSync(new URL("./policy/one-party-consent-states.v1.json", import.meta.url), "utf8")));
const RETENTION_AUDIT = "/var/lib/aircall-recording-control/retention-decisions.jsonl";
const SALES_BOARD_ID = "7727339040";
const SALES_PHONE_COLUMNS = ["phone__1", "dup__of_phone7__1", "phone_mkrgdn4"];
const CALLS_BOARD_ID = "18419412577";
const CALL_ID_COLUMN = "text_mm4nwyyx";
const RECORDING_COLUMN = "link_mm4n5qp";
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
    const d = p.data, id = typeof d.id === "string" ? d.id : Number.isSafeInteger(d.id) ? String(d.id) : null, rawDigits = d.raw_digits;
    const digits = typeof rawDigits === "string" && rawDigits.length <= 32 && /^[0-9+(). -]+$/.test(rawDigits) ? rawDigits.replace(/\D/g, "") : "";
    if (typeof id !== "string" || !ID.test(id) || !PHONE.test(digits)) return null;
    const url = recordingUrl(d);
    return Object.freeze({ callId: id, phoneDigits: digits, url, event: p.event, key: createHash("sha256").update(`${p.event}\0${id}\0${url ?? "pending"}`).digest("hex") });
  } catch { return null; }
}

function diagnoseRejectedEvent(raw, headers, expectedToken) {
  const safeKeys = value => plain(value) ? Object.keys(value).filter(key => /^[A-Za-z0-9_.-]{1,64}$/.test(key)).sort().slice(0, 32) : [];
  let details = { kind: "aircall_link_event_rejected", headerNames: Object.keys(headers).sort().slice(0, 32), json: false };
  try {
    const payload = JSON.parse(raw);
    details = {
      ...details,
      json: plain(payload),
      topLevelKeys: safeKeys(payload),
      dataKeys: safeKeys(payload?.data),
      event: typeof payload?.event === "string" && /^[a-z._]{1,64}$/.test(payload.event) ? payload.event : null,
      bodyTokenPresent: typeof payload?.token === "string",
      bodyTokenMatchesConfigured: typeof payload?.token === "string" && equal(payload.token, expectedToken),
      authorizationHeaderPresent: typeof headers.authorization === "string",
      idType: typeof payload?.data?.id,
      idStringLength: String(payload?.data?.id ?? "").length,
      idIsSafeInteger: Number.isSafeInteger(payload?.data?.id),
      rawDigitsType: typeof payload?.data?.raw_digits,
      rawDigitsLength: typeof payload?.data?.raw_digits === "string" ? payload.data.raw_digits.length : null,
      rawDigitsAsciiOnly: typeof payload?.data?.raw_digits === "string" ? /^[0-9]+$/.test(payload.data.raw_digits) : false,
    };
  } catch { /* intentionally no body content is retained */ }
  console.warn(JSON.stringify(details));
}

export function createRuntime({ config = readConfig(), fetchImpl = globalThis.fetch, decisionStateForCall = auditedState } = {}) {
  if (!config || typeof fetchImpl !== "function") throw new TypeError("invalid_runtime_config");
  const inFlight = new Map();
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, service: "aircall-recording-link", triggerBoardId: SALES_BOARD_ID, targetBoardId: CALLS_BOARD_ID, targetColumnId: RECORDING_COLUMN });
    if (req.method !== "POST" || req.url !== "/aircall/recording/link-events" || !/^application\/json(?:\s*;.*)?$/i.test(req.headers["content-type"] ?? "")) return send(res, 404, { accepted: false });
    const raw = await body(req, 128 * 1024); if (!raw) return send(res, 400, { accepted: false });
    const event = normalizeEvent(raw, config.webhookToken); if (!event) { diagnoseRejectedEvent(raw, req.headers, config.webhookToken); return send(res, 401, { accepted: false }); }
    let pending = inFlight.get(event.callId);
    if (!pending) {
      pending = associate(event).finally(() => inFlight.delete(event.callId));
      inFlight.set(event.callId, pending);
    }
    try { return send(res, 202, { accepted: true, outcome: await pending }); }
    catch { return send(res, 503, { accepted: false, outcome: "dependency_failure" }); }
  });
  async function associate(event) {
    const url = event.url ?? await fetchRecordingUrl(event.callId);
    if (!url) return "recording_not_ready";
    const salesMatches = await findUniqueSalesTrigger(event.phoneDigits);
    if (salesMatches.length !== 1) return salesMatches.length ? "ambiguous_sales_trigger" : "no_sales_trigger";
    const state = decisionStateForCall(event.callId);
    if (!(state in RULESET.states)) return "state_decision_unavailable";
    if (RULESET.states[state] === false) {
      const callRows = await findUniqueCallRow(event.callId);
      if (callRows.length === 1) await wipeLink(callRows[0]);
      const deleted = await deleteRecording(event.callId);
      retentionAudit(event.callId, state, deleted ? "provider_delete_requested" : "provider_delete_failed");
      return deleted ? "two_party_link_wiped_delete_requested" : "two_party_link_wiped_delete_failed";
    }
    let callRows = await findUniqueCallRow(event.callId);
    if (callRows.length > 1) return "ambiguous_call_row";
    if (callRows.length === 0) {
      await createCallRow(event.callId);
      callRows = await findUniqueCallRow(event.callId);
    }
    if (callRows.length !== 1) return callRows.length ? "ambiguous_call_row" : "no_call_row";
    await writeLink(callRows[0], url);
    return "linked";
  }
  async function fetchRecordingUrl(callId) {
    const r = await fetchImpl(`https://api.aircall.io/v1/calls/${encodeURIComponent(callId)}`, { headers: { Authorization: `Basic ${Buffer.from(`${config.aircallId}:${config.aircallKey}`).toString("base64")}` }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error("aircall_read_failed"); const c = await r.json(); return recordingUrl(c.call ?? c);
  }
  async function findUniqueSalesTrigger(digits) {
    const found = new Map();
    const candidates = new Set([digits]);
    if (digits.length === 11 && digits.startsWith("1")) candidates.add(digits.slice(1));
    for (const candidate of candidates) for (const column of SALES_PHONE_COLUMNS) {
      const q = `query($b:ID!,$c:String!,$p:String!){items_page_by_column_values(board_id:$b,columns:[{column_id:$c,column_values:[$p]}],limit:2){items{id board{id} column_values(ids:[$c,"text_2"]){id text type}}}}`;
      const data = await monday(q, { b: SALES_BOARD_ID, c: column, p: candidate });
      const items = data?.items_page_by_column_values?.items; if (!Array.isArray(items) || items.length > 2) throw new Error("monday_read_failed");
      for (const item of items) { const col = item?.column_values?.[0], stateCol=item?.column_values?.find(x=>x.id==="text_2"); const actual = typeof col?.text === "string" ? col.text.replace(/\D/g, "") : ""; const state=typeof stateCol?.text==="string"?stateCol.text.trim().toUpperCase():""; if (String(item?.board?.id) === SALES_BOARD_ID && ID.test(String(item?.id ?? "")) && col?.id === column && col?.type === "phone" && actual === candidate && state) found.set(String(item.id),{id:String(item.id),state}); }
    }
    return [...found.values()];
  }
  async function findUniqueCallRow(callId) {
    const q = `query($b:ID!,$c:String!,$v:String!){items_page_by_column_values(board_id:$b,columns:[{column_id:$c,column_values:[$v]}],limit:2){items{id board{id} column_values(ids:[$c]){id text type}}}}`;
    const data = await monday(q, { b: CALLS_BOARD_ID, c: CALL_ID_COLUMN, v: callId });
    const items = data?.items_page_by_column_values?.items; if (!Array.isArray(items) || items.length > 2) throw new Error("monday_read_failed");
    const found = new Set();
    for (const item of items) { const col = item?.column_values?.[0]; if (String(item?.board?.id) === CALLS_BOARD_ID && ID.test(String(item?.id ?? "")) && col?.id === CALL_ID_COLUMN && col?.type === "text" && col?.text === callId) found.add(String(item.id)); }
    return [...found];
  }
  async function createCallRow(callId) {
    const q = `mutation($board:ID!,$name:String!,$values:JSON!){create_item(board_id:$board,item_name:$name,column_values:$values){id}}`;
    const values = JSON.stringify({ [CALL_ID_COLUMN]: callId });
    const d = await monday(q, { board: CALLS_BOARD_ID, name: "Aircall call", values });
    if (!ID.test(String(d?.create_item?.id ?? ""))) throw new Error("monday_create_failed");
  }
  async function writeLink(itemId, url) {
    const q = `mutation($item:ID!,$board:ID!,$values:JSON!){change_multiple_column_values(item_id:$item,board_id:$board,column_values:$values){id}}`;
    const values = JSON.stringify({ [RECORDING_COLUMN]: { url, text: "Aircall recording (expires per Aircall policy)" } });
    const d = await monday(q, { item: itemId, board: CALLS_BOARD_ID, values }); if (String(d?.change_multiple_column_values?.id) !== itemId) throw new Error("monday_write_failed");
  }
  async function wipeLink(itemId) { const q = `mutation($item:ID!,$board:ID!,$values:JSON!){change_multiple_column_values(item_id:$item,board_id:$board,column_values:$values){id}}`; const d=await monday(q,{item:itemId,board:CALLS_BOARD_ID,values:JSON.stringify({[RECORDING_COLUMN]:null})}); if(String(d?.change_multiple_column_values?.id)!==itemId)throw new Error("monday_write_failed"); }
  async function deleteRecording(callId) { try { const r=await fetchImpl(`https://api.aircall.io/v1/calls/${encodeURIComponent(callId)}/recording`,{method:"DELETE",headers:{Authorization:`Basic ${Buffer.from(`${config.aircallId}:${config.aircallKey}`).toString("base64")}`},signal:AbortSignal.timeout(8000)}); return r.ok; } catch { return false; } }
  function retentionAudit(callId,state,outcome) { try { mkdirSync("/var/lib/aircall-recording-control",{recursive:true,mode:0o700}); appendFileSync(RETENTION_AUDIT,`${JSON.stringify({at:new Date().toISOString(),eventHash:createHash("sha256").update(callId).digest("hex"),state,outcome})}\n`,{mode:0o600}); } catch {} }
  async function monday(query, variables) {
    const r = await fetchImpl("https://api.monday.com/v2", { method: "POST", headers: { Authorization: config.mondayToken, "content-type": "application/json" }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error("monday_http_failed"); const j = await r.json(); if (j.errors) throw new Error("monday_graphql_failed"); return j.data;
  }
  return Object.freeze({ start: () => new Promise((resolve, reject) => { server.once("error", reject); server.listen(config.port, config.host, () => { const address = server.address(); resolve(Object.freeze({ host: config.host, port: typeof address === "object" && address ? address.port : config.port })); }); }), close: () => new Promise((resolve) => server.close(() => resolve())) });
}
function auditedState(callId) { try { const hash=createHash("sha256").update(callId).digest("hex"); let state=null; for(const line of readFileSync("/var/lib/aircall-recording-control/decisions.jsonl","utf8").split("\n")){try{const x=JSON.parse(line); if(x.eventHash===hash&&typeof x.state==="string")state=x.state.trim().toUpperCase();}catch{}} return state; } catch { return null; } }
function recordingUrl(call) { for (const k of ["recording_short_url", "recording"]) if (typeof call?.[k] === "string" && HTTPS.test(call[k])) return call[k]; return null; }
function equal(a, b) { if (typeof a !== "string" || typeof b !== "string") return false; return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest()); }
function plain(v) { return v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype; }
function body(req, max) { return new Promise((resolve) => { let n=0, a=[]; req.on("data", c => { n+=c.length; if(n<=max)a.push(c); }); req.on("end", () => resolve(n<=max ? Buffer.concat(a).toString("utf8") : null)); req.on("error", () => resolve(null)); }); }
function send(res, status, value) { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); }
if (process.argv[1] === new URL(import.meta.url).pathname) { const r = createRuntime(); r.start().catch(() => { process.exitCode = 1; }); }
