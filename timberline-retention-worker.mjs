import { createPostgresTwoPartyRetentionStore } from "./postgres-two-party-retention-store.mjs";
import { createTwoPartyRetentionFinalizer, TIMBERLINE_CALLS_BOARD, TIMBERLINE_RECORDING_LINK } from "./two-party-retention-finalizer.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** One-shot worker. It starts no HTTP listener and installs no timer/schedule. */
export function createTimberlineRetentionWorker({ store, aircall, monday, correlationKey } = {}) {
  if (!store || !aircall || !monday || typeof correlationKey !== "string") throw new TypeError("invalid_retention_worker");
  const finalizer = createTwoPartyRetentionFinalizer({ store, aircall, monday, correlationKey });
  return Object.freeze({ runOnce: () => finalizer.runOnce() });
}

export function createAircallRetentionAdapter({ aircallId, aircallKey, fetchImpl = globalThis.fetch } = {}) {
  if (!secret(aircallId) || !secret(aircallKey) || typeof fetchImpl !== "function") throw new TypeError("invalid_aircall_retention_adapter");
  const authorization = `Basic ${Buffer.from(`${aircallId}:${aircallKey}`).toString("base64")}`;
  async function request(path, options = {}) { return fetchImpl(`https://api.aircall.io/v1${path}`, { ...options, headers: { Authorization: authorization, ...(options.headers ?? {}) }, signal: AbortSignal.timeout(8000) }); }
  return Object.freeze({
    async deleteRecording(providerCallId) {
      requireId(providerCallId); const response = await request(`/calls/${encodeURIComponent(providerCallId)}/recording`, { method: "DELETE" });
      if (!response.ok) throw new Error("aircall_recording_delete_failed");
    },
    async recordingUnavailable(providerCallId) {
      requireId(providerCallId);
      // Aircall retains recording metadata on the call object after deletion.
      // Only the recording-object endpoint's 404 is authoritative deletion proof.
      const response = await request(`/calls/${encodeURIComponent(providerCallId)}/recording`, { method: "GET" });
      if (response.status === 404) return true;
      if (!response.ok) throw new Error("aircall_recording_reconciliation_failed");
      return false;
    },
  });
}

export function createMondayRetentionAdapter({ mondayToken, fetchImpl = globalThis.fetch } = {}) {
  if (!secret(mondayToken) || typeof fetchImpl !== "function") throw new TypeError("invalid_monday_retention_adapter");
  async function query(query, variables) {
    const response = await fetchImpl("https://api.monday.com/v2", { method: "POST", headers: { Authorization: mondayToken, "content-type": "application/json" }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error("monday_retention_http_failed"); const body = await response.json(); if (body?.errors || !plain(body?.data)) throw new Error("monday_retention_graphql_failed"); return body.data;
  }
  function exact(input) { if (!plain(input) || input.boardId !== TIMBERLINE_CALLS_BOARD || input.columnId !== TIMBERLINE_RECORDING_LINK || !ID.test(String(input.itemId ?? ""))) throw new TypeError("invalid_exact_monday_target"); return String(input.itemId); }
  return Object.freeze({
    async clearExactRecordingLink(input) {
      const itemId = exact(input);
      const mutation = "mutation($board:ID!,$item:ID!,$column:String!,$value:JSON!){change_column_value(board_id:$board,item_id:$item,column_id:$column,value:$value){id board{id}}}";
      const data = await query(mutation, { board: TIMBERLINE_CALLS_BOARD, item: itemId, column: TIMBERLINE_RECORDING_LINK, value: JSON.stringify({}) });
      const changed = data.change_column_value;
      if (String(changed?.id) !== itemId || String(changed?.board?.id) !== TIMBERLINE_CALLS_BOARD) throw new Error("monday_exact_clear_failed");
    },
    async readExactRecordingLink(input) {
      const itemId = exact(input);
      const queryText = "query($ids:[ID!],$column:String!){items(ids:$ids){id board{id} column_values(ids:[$column]){id value}}}";
      const data = await query(queryText, { ids: [itemId], column: TIMBERLINE_RECORDING_LINK }); const items = data.items;
      if (!Array.isArray(items) || items.length !== 1) throw new Error("monday_exact_read_failed");
      const item = items[0], column = item?.column_values?.[0];
      if (String(item?.id) !== itemId || String(item?.board?.id) !== TIMBERLINE_CALLS_BOARD || column?.id !== TIMBERLINE_RECORDING_LINK) throw new Error("monday_exact_read_failed");
      return emptyMondayValue(column.value) ? null : String(column.value);
    },
  });
}

export function createTimberlineRetentionWorkerFromEnv(env = process.env, dependencies = {}) {
  const required = key => { const value = env[key]; if (!secret(value)) throw new TypeError(`missing_${key}`); return value; };
  const store = dependencies.store ?? createPostgresTwoPartyRetentionStore({ databaseUrl: required("TIMBERLINE_RETENTION_DATABASE_URL"), capabilityKey: required("TIMBERLINE_RETENTION_CAPABILITY_KEY") });
  const aircall = dependencies.aircall ?? createAircallRetentionAdapter({ aircallId: required("AIRCALL_API_ID"), aircallKey: required("AIRCALL_API_KEY"), fetchImpl: dependencies.fetchImpl });
  const monday = dependencies.monday ?? createMondayRetentionAdapter({ mondayToken: required("MONDAY_API_TOKEN"), fetchImpl: dependencies.fetchImpl });
  return Object.freeze({ worker: createTimberlineRetentionWorker({ store, aircall, monday, correlationKey: required("TIMBERLINE_RETENTION_CORRELATION_KEY") }), store });
}

/** Executes exactly one queued action, then releases the owned Postgres pool. */
export async function runTimberlineRetentionWorkerOnce(env = process.env, dependencies = {}) {
  const { worker, store } = createTimberlineRetentionWorkerFromEnv(env, dependencies);
  try { return await worker.runOnce(); } finally { if (!dependencies.store && typeof store.close === "function") await store.close(); }
}
function hasRecordingValue(call) { return [call.recording, call.recording_short_url, call.recording_url, call.recording_id, call.recordingId].some(value => value !== null && value !== undefined && value !== ""); }
function emptyMondayValue(value) { if (value === null || value === "" || value === "null") return true; try { const parsed = JSON.parse(value); return parsed === null || (plain(parsed) && Object.keys(parsed).length === 0); } catch { return false; } }
function requireId(value) { if (!ID.test(value ?? "")) throw new TypeError("invalid_provider_call_id"); }
function secret(value) { return typeof value === "string" && value.length >= 16 && !/[\0-\x1f\x7f]/.test(value); }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
if (process.argv[1] === new URL(import.meta.url).pathname) runTimberlineRetentionWorkerOnce().then(result => { process.stdout.write(`${JSON.stringify(result)}\n`); }).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
