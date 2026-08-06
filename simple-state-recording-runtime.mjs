import http from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { createTimberlineAnswerTimeRetentionWriterFromEnv } from "./timberline-answer-time-retention-writer.mjs";

const BOARD_ID = "7727339040";
const PHONE_COLUMNS = ["phone__1", "dup__of_phone7__1", "phone_mkrgdn4"];
const RULESET = Object.freeze(JSON.parse(readFileSync(new URL("./policy/one-party-consent-states.v1.json", import.meta.url), "utf8")));
const ACTIVE_POLICY = Object.freeze(JSON.parse(readFileSync(new URL("./policy/active-state-pause.policy.json", import.meta.url), "utf8")));
if (typeof RULESET.version !== "string" || Object.keys(RULESET.states).length !== 50) throw new Error("invalid_one_party_ruleset");
if (!validActivePolicy(ACTIVE_POLICY)) throw new Error("invalid_active_state_pause_policy");

export function parseControlScope(value) {
  try {
    const pairs = JSON.parse(value ?? "");
    if (!Array.isArray(pairs) || pairs.length === 0) return null;
    const normalized = pairs.map((pair) => {
      const userId = String(pair?.userId ?? ""); const numberId = String(pair?.numberId ?? "");
      return /^\d+$/.test(userId) && /^\d+$/.test(numberId) ? `${userId}:${numberId}` : null;
    });
    return normalized.every(Boolean) && new Set(normalized).size === normalized.length ? new Set(normalized) : null;
  } catch { return null; }
}

export function normalizePhone(value) {
  if (typeof value !== "string" || value.length > 32 || !/^[0-9+(). -]+$/.test(value)) return null;
  const digits = value.replace(/\D/g, "");
  return /^\d{10,15}$/.test(digits) ? digits : null;
}

export function decideStateAction(state) {
  return typeof state === "string" && RULESET.states[state] === false ? "pause" : "no_action";
}

/** Fail closed before any Monday or Aircall dependency is invoked. */
export function classifyControlEvent(payload, token, expectedToken, scope, enabled) {
  const call = payload?.data;
  const id = typeof call?.id === "string" ? call.id : Number.isSafeInteger(call?.id) ? String(call.id) : null;
  if (payload?.event !== "call.answered" || !equalToken(token, expectedToken) || !call
    || call.direction !== "outbound" || !normalizePhone(call.raw_digits)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id ?? "")) return "left_disabled";
  if (enabled !== true || !(scope instanceof Set) || !scope.has(`${String(call.user?.id)}:${String(call.number?.id)}`)) return "left_disabled";
  return "eligible_for_state_lookup";
}

export function createServer({ env = process.env, fetchImpl = globalThis.fetch, policy = ACTIVE_POLICY, answerTimeRetentionWriter } = {}) {
  if (!validActivePolicy(policy)) throw new Error("invalid_active_state_pause_policy");
  if (answerTimeRetentionWriter === undefined) answerTimeRetentionWriter = configuredAnswerTimeRetentionWriter(env, fetchImpl);
  if (answerTimeRetentionWriter !== null && typeof answerTimeRetentionWriter?.recordAfterSuccessfulPause !== "function") throw new Error("invalid_answer_time_retention_writer");
  const required = (key) => { const value = env[key]; if (typeof value !== "string" || value.length < 16) throw new Error(`missing_${key}`); return value; };
  const token = required("AIRCALL_CONTROL_WEBHOOK_TOKEN");
  const aircallId = required("AIRCALL_API_ID"); const aircallKey = required("AIRCALL_API_KEY"); const mondayToken = required("MONDAY_API_TOKEN");
  const rawScope = env.RECORDING_CONTROL_SCOPE_PAIRS ?? ""; const scope = parseControlScope(rawScope); if (!scope || scope.size !== policy.scope.pairCount || digest(rawScope) !== policy.scope.sha256) throw new Error("invalid_RECORDING_CONTROL_SCOPE_PAIRS");
  const enabled = env.CONTROL_ENABLED === "true" && env.RECORDING_CONTROL_MODE === "CONTROL_ENABLED" && env.RECORDING_CONTROL_POLICY_VERSION === policy.policyVersion;
  const auditFile = env.RECORDING_CONTROL_AUDIT_FILE ?? "/var/lib/aircall-recording-control/decisions.jsonl";
  const seen = loadSeen(auditFile);

  const audit = (entry) => {
    mkdirSync(new URL(".", `file://${auditFile}`).pathname, { recursive: true, mode: 0o700 });
    appendFileSync(auditFile, `${JSON.stringify({ at: new Date().toISOString(), policyVersion: policy.policyVersion, ...entry })}\n`, { mode: 0o600 });
  };
  async function monday(query, variables) {
    const response = await fetchImpl("https://api.monday.com/v2", { method: "POST", headers: { authorization: mondayToken, "content-type": "application/json" }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(5000) });
    const body = await response.json(); if (!response.ok || body.errors) throw new Error("monday_failure"); return body.data;
  }
  async function resolveItem(phone) {
    const matches = new Map(); const candidates = new Set([phone]); if (phone.length === 11 && phone.startsWith("1")) candidates.add(phone.slice(1));
    for (const candidate of candidates) for (const column of PHONE_COLUMNS) {
      const query = "query($board:ID!,$column:String!,$phone:String!){items_page_by_column_values(board_id:$board,columns:[{column_id:$column,column_values:[$phone]}],limit:2){items{id board{id} column_values(ids:[$column,\"text_2\"]){id text type}}}}";
      const data = await monday(query, { board: BOARD_ID, column, phone: candidate });
      for (const item of data.items_page_by_column_values.items ?? []) {
        const matchedPhone = item.column_values.find((value) => value.id === column); const state = item.column_values.find((value) => value.id === "text_2");
        if (item.board?.id === BOARD_ID && matchedPhone?.type === "phone" && matchedPhone.text.replace(/\D/g, "") === candidate && typeof state?.text === "string") matches.set(String(item.id), { id: String(item.id), state: state.text.trim().toUpperCase() });
      }
    }
    return matches.size === 1 ? matches.values().next().value : null;
  }
  async function applyPause(callId) {
    let response;
    try {
      response = await fetchImpl(`https://api.aircall.io/v1/calls/${encodeURIComponent(callId)}/pause_recording`, { method: "POST", headers: { authorization: `Basic ${Buffer.from(`${aircallId}:${aircallKey}`).toString("base64")}` }, signal: AbortSignal.timeout(8000) });
    } catch { return { status: "outcome_unknown" }; }
    if (response.ok) return { status: "succeeded" };
    const httpStatus = Number.isInteger(response.status) && response.status >= 400 && response.status <= 599 ? response.status : "invalid";
    return { status: `failed_http_${httpStatus}` };
  }

  return http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") return send(response, 200, { ok: true, service: "state-recording-control", enabled, scopePairs: scope.size, rulesetVersion: policy.policyVersion, enforcement: "two_party_pause_only", audit: "redacted_durable_local" });
    if (request.method !== "POST" || request.url !== "/aircall/recording/control-events") return send(response, 404, { accepted: false });
    try {
      const payload = JSON.parse(await readBody(request)); const outcome = classifyControlEvent(payload, payload?.token, token, scope, enabled);
      if (outcome !== "eligible_for_state_lookup") return send(response, 202, { accepted: true, outcome: "left_disabled" });
      const callId = String(payload.data.id); const eventHash = digest(callId);
      if (seen.has(eventHash)) return send(response, 202, { accepted: true, duplicate: true });
      const item = await resolveItem(normalizePhone(payload.data.raw_digits));
      if (!item || !(item.state in RULESET.states)) return send(response, 202, { accepted: true, outcome: "no_policy_action" });
      if (decideStateAction(item.state) !== "pause") { audit({ eventHash, state: item.state, outcome: "one_party_no_action" }); return send(response, 202, { accepted: true, outcome: "one_party_no_action" }); }
      seen.add(eventHash); audit({ eventHash, state: item.state, outcome: "pause_dispatching" });
      const providerResult = await applyPause(callId);
      audit({ eventHash, state: item.state, outcome: `pause_${providerResult.status}` });
      if (providerResult.status !== "succeeded") return send(response, 202, { accepted: true, outcome: `pause_${providerResult.status}` });
      if (answerTimeRetentionWriter !== null) {
        try {
          await answerTimeRetentionWriter.recordAfterSuccessfulPause({ providerCallId: callId, externalPhoneDigits: normalizePhone(payload.data.raw_digits) });
          audit({ eventHash, state: item.state, outcome: "answer_time_retention_recorded" });
        } catch {
          // The pause has already succeeded.  Do not retry it or take any deletion/CRM action.
          audit({ eventHash, state: item.state, outcome: "answer_time_retention_unrecorded" });
          return send(response, 202, { accepted: true, outcome: "pause_recording_retention_unrecorded" });
        }
      }
      return send(response, 202, { accepted: true, outcome: "pause_recording" });
    } catch { return send(response, 503, { accepted: false, outcome: "dependency_failure" }); }
  });
}
function configuredAnswerTimeRetentionWriter(env, fetchImpl) {
  const keys = ["TIMBERLINE_RETENTION_DATABASE_URL", "TIMBERLINE_RETENTION_CAPABILITY_KEY", "TIMBERLINE_RETENTION_CORRELATION_KEY"];
  const supplied = keys.filter(key => typeof env[key] === "string" && env[key].length > 0);
  if (supplied.length === 0) return null;
  if (supplied.length !== keys.length) throw new Error("incomplete_timberline_retention_configuration");
  return createTimberlineAnswerTimeRetentionWriterFromEnv(env, { fetchImpl });
}
function loadSeen(file) { const seen = new Set(); if (!existsSync(file)) return seen; for (const line of readFileSync(file, "utf8").split("\n")) try { const x = JSON.parse(line); if (typeof x?.eventHash === "string" && /^pause_(dispatching|succeeded|outcome_unknown)$/.test(x.outcome)) seen.add(x.eventHash); } catch {} return seen; }
function validActivePolicy(policy) { return policy?.controllerStatus === "ENABLED" && policy.operatingMode === "ACTIVE_PAUSE_ONLY" && policy.recordingActionsPermitted === true && policy.legalRuleset?.version === RULESET.version && typeof policy.policyVersion === "string" && policy.policyVersion.length > 0 && Number.isSafeInteger(policy.scope?.pairCount) && policy.scope.pairCount > 0 && /^[a-f0-9]{64}$/.test(policy.scope?.sha256 ?? ""); }
function digest(value) { return createHash("sha256").update(String(value)).digest("hex"); }
function equalToken(actual, expected) { return typeof actual === "string" && timingSafeEqual(createHash("sha256").update(actual).digest(), createHash("sha256").update(expected).digest()); }
function send(response, status, body) { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(body)); }
async function readBody(request) { let size = 0; const chunks = []; for await (const chunk of request) { size += chunk.length; if (size > 131072) throw new Error("body_too_large"); chunks.push(chunk); } return Buffer.concat(chunks).toString(); }
if (process.argv[1] === new URL(import.meta.url).pathname) createServer().listen(3338, "127.0.0.1");
