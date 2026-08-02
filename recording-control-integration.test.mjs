import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { normalizeAircallAnsweredControlEvent } from "./aircall-recording-control-event.mjs";
import { createSalesBoardControlAdapter, SALES_CONTROL_LOOKUP_QUERY, SALES_CONTROL_SCHEMA_QUERY } from "./sales-board-recording-control-adapter.mjs";
import { createRecordingControlDecisionService } from "./recording-control-decision-service.mjs";
import { createRecordingControlReceiver } from "./recording-control-receiver.mjs";
import { createRecordingControlRuntime, createWorkerLoop, readRecordingControlConfig, RECORDING_CONTROL_POLICY_VERSION, startRecordingControlRuntime } from "./recording-control-runtime.mjs";

const token = "control-webhook-token-long-enough";
const capabilityKey = Buffer.alloc(32, 1).toString("base64");
const idempotencyKey = "idempotency-control-key-material-0001";
const pseudonymKey = "pseudonym-control-key-material-00001";
const approvalPair = generateKeyPairSync("ed25519");
const approvalPublicKey = approvalPair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const payload = (overrides = {}, root = {}) => JSON.stringify({ event: "call.answered", token,
  data: { id: "call-1", raw_digits: "15125550100", user: { id: 7 }, number: { id: 9 }, ...overrides }, ...root });

function event() { return normalizeAircallAnsweredControlEvent({ payloadJson: payload(), expectedWebhookToken: token }); }
function mondayItem(state = "TX", consent = "Verified — Permit Recording", id = "1", evidenceColumn = "phone__1") {
  return { id, board: { id: "7727339040" }, column_values: [
    { id: "text_2", text: state, type: "text" },
    ...["phone__1", "dup__of_phone7__1", "phone_mkrgdn4"].map((column) => ({ id: column, text: column === evidenceColumn ? "+1 512 555 0100" : "", type: "phone" })),
    { id: "consent_status", text: consent, type: "dropdown" },
  ] };
}
function adapterFor({ state = "TX", consent = "Verified — Permit Recording", ambiguous = false } = {}) {
  return createSalesBoardControlAdapter({ consentColumnId: "consent_status", query: async (request) => {
    assert.equal(request.query, SALES_CONTROL_LOOKUP_QUERY);
    const column = request.variables.phoneColumnId;
    return { data: { items_page_by_column_values: { items: [mondayItem(state, consent, "1", column), ...(ambiguous ? [mondayItem(state, consent, "2", column)] : [])] } } };
  } });
}
function fixedStore(overrides = {}) {
  return {
    ready: Promise.resolve(), checkReady: async () => true, isActionsEnabled: async () => false,
    setActionsEnabled: async () => {}, hasMatchingActivation: async () => false,
    readiness: async () => ({ schema: true, actionsEnabled: false, activationMatches: false, reconciliationCount: 0, unknownKeyCount: 0 }),
    recordDecision: async () => {}, enqueueApprovedAction: async () => ({ enqueued: true, duplicate: false }),
    claimNext: async () => null, resolveAuthorizationContext: async () => null, prepareDispatch: async () => null,
    executeWithDispatchFence: async () => ({ outcome: "outcome_unknown" }), markRetry: async () => {}, cancel: async () => {}, close: async () => {},
    ...overrides,
  };
}
function baseEnv(overrides = {}) {
  return {
    AIRCALL_CONTROL_WEBHOOK_TOKEN: token,
    AIRCALL_CONTROL_DATABASE_URL: "postgres://local/test",
    MONDAY_API_TOKEN: "monday-token",
    MONDAY_RECORDING_CONSENT_COLUMN_ID: "dropdown_mm5v99w5",
    RECORDING_IDEMPOTENCY_HMAC_KEY: idempotencyKey,
    RECORDING_PSEUDONYM_HMAC_KEY: pseudonymKey,
    RECORDING_CAPABILITY_ACTIVE_KEY: capabilityKey,
    RECORDING_CAPABILITY_ACTIVE_KEY_ID: "active-v1",
    RECORDING_APPROVAL_PUBLIC_KEY: approvalPublicKey,
    RECORDING_DEPLOYMENT_ID: "test-deploy-v1",
    ...overrides,
  };
}

 test("normalizer accepts only the direct call.answered payload and emits HMAC-derived minimal keys", () => {
  const accepted = event();
  assert.deepEqual(Object.keys(accepted), ["accepted", "eventKey", "actionKey", "callId", "phoneDigits", "userId", "numberId"]);
  assert.equal(accepted.accepted, true);
  assert.match(accepted.eventKey, /^[a-f0-9]{64}$/);
  assert.match(accepted.actionKey, /^[a-f0-9]{64}$/);
  assert.notEqual(accepted.eventKey, accepted.actionKey);
  const rejected = [
    "{}", JSON.stringify({ event: "call.answered", token, data: { call: { id: "call-1" } } }), payload({ raw_digits: "+1 512" }),
    payload({ user: null }), JSON.stringify({ event: "call.ringing", token, data: {} }), payload({}, { envelope: {} }),
    JSON.stringify({ event: "call.answered", token, payload: JSON.parse(payload()) }),
  ];
  for (const raw of rejected) assert.equal(normalizeAircallAnsweredControlEvent({ payloadJson: raw, expectedWebhookToken: token }).accepted, false);
});

test("Sales lookup revalidates every requested phone column and requires exactly one item", async () => {
  const calls = [];
  const adapter = createSalesBoardControlAdapter({ consentColumnId: "consent_status", query: async (request) => {
    calls.push(request.variables.phoneColumnId);
    return { data: { items_page_by_column_values: { items: [mondayItem("TX", "Verified — Permit Recording", "1", request.variables.phoneColumnId)] } } };
  } });
  const found = await adapter.resolveByPhone("15125550100");
  assert.equal(found.status, "found");
  assert.deepEqual(found.record.consent, { value: "Verified — Permit Recording", source: "consent_status", verified: true });
  assert.deepEqual(calls, ["phone__1", "dup__of_phone7__1", "phone_mkrgdn4"]);
  assert.equal((await adapterFor({ ambiguous: true }).resolveByPhone("15125550100")).status, "not_unique");
  const bad = mondayItem(); bad.column_values = bad.column_values.filter((x) => x.id !== "phone_mkrgdn4");
  await assert.rejects(createSalesBoardControlAdapter({ consentColumnId: "consent_status", query: async () => ({ data: { items_page_by_column_values: { items: [bad] } } }) }).resolveByPhone("15125550100"), /evidence/);
});

test("schema readiness verifies fixed board, exact column types, required dropdown labels, and single-select", async () => {
  const columns = [
    { id: "text_2", type: "text" }, { id: "phone__1", type: "phone" }, { id: "dup__of_phone7__1", type: "phone" }, { id: "phone_mkrgdn4", type: "phone" },
    { id: "consent_status", type: "dropdown", settings_str: JSON.stringify({ labels: [{ name: "Verified — Permit Recording" }, { name: "Verified — Do Not Record" }], allow_multiple_selection: false }) },
  ];
  const make = (edit = (x) => x) => createSalesBoardControlAdapter({ consentColumnId: "consent_status", query: async (request) => {
    assert.equal(request.query, SALES_CONTROL_SCHEMA_QUERY); return { data: { boards: [{ id: "7727339040", columns: edit(structuredClone(columns)) }] } };
  } });
  assert.equal(await make().checkSchema(), true);
  assert.equal(await make((value) => { value[4].settings_str = JSON.stringify({ labels: ["Verified — Permit Recording", "Verified — Do Not Record"], allow_multiple_selection: false }); return value; }).checkSchema(), true);
  assert.equal(await make((value) => { value[4].type = "status"; return value; }).checkSchema(), false);
  assert.equal(await make((value) => { value[4].settings_str = JSON.stringify({ labels: [{ name: "Verified — Permit Recording" }, { name: "Verified — Do Not Record" }], allow_multiple_selection: true }); return value; }).checkSchema(), false);
  assert.equal(await make((value) => { value[4].settings_str = JSON.stringify({ labels: [{ name: "Verified — Permit Recording" }], allow_multiple_selection: false }); return value; }).checkSchema(), false);
});

function serviceHarness({ state = "TX", consent = "Verified — Permit Recording", users = [7], numbers = [9], enabled = true, enqueueResult = { enqueued: true, duplicate: false }, enqueueFails = false, mode = "CONTROL_ENABLED" } = {}) {
  const calls = { denied: [], queued: [] };
  const store = { async isActionsEnabled() { return enabled; }, async recordDecision(value) { calls.denied.push(value); },
    async enqueueApprovedAction(value) { calls.queued.push(value); if (enqueueFails) throw new Error(); return enqueueResult; } };
  return { calls, service: createRecordingControlDecisionService({ adapter: adapterFor({ state, consent }), store,
    idempotencyKey, pseudonymKey, mode,
    policyVersion: RECORDING_CONTROL_POLICY_VERSION, approvedPolicyVersion: RECORDING_CONTROL_POLICY_VERSION,
    eligibleStates: ["TX"], consentColumnId: "consent_status", pilotUserIds: users, pilotNumberIds: numbers }) };
}

test("decision service enqueues only approval and durably records every normalized denial", async () => {
  let harness = serviceHarness();
  assert.deepEqual(await harness.service.process(event()), { accepted: true, outcome: "request_resume_recording", duplicate: false });
  assert.equal(harness.calls.queued[0].authorizationContext.callId, "call-1");
  assert.deepEqual(Object.keys(harness.calls.queued[0]).sort(), ["actionKeyHash", "actionType", "approved", "authorizationContext", "capabilityTtlMs", "correlation", "decisionKeyHash", "evidenceDigest", "maxAttempts", "policyKeyHash", "reasonCode", "targetKeyHash"].sort());
  for (const options of [{ state: "CA" }, { consent: "Verified — Do Not Record" }, { users: [8] }, { numbers: [10] }, { enabled: false }, { mode: "DISABLED" }, { enqueueResult: { enqueued: false } }, { enqueueFails: true }]) {
    harness = serviceHarness(options);
    const result = await harness.service.process(event());
    assert.equal(result.outcome, "left_disabled");
    assert.equal(harness.calls.denied.length, 1);
  }
});

test("revalidation checks the live adapter schema immediately before lookup and fails closed on drift", async () => {
  for (const schemaCheck of [async () => false, async () => { throw new Error("schema dependency"); }]) {
    let lookups = 0;
    const adapter = { checkSchema: schemaCheck, resolveByPhone: async () => { lookups += 1; throw new Error("must not lookup"); } };
    const service = createRecordingControlDecisionService({ adapter, store: fixedStore({ isActionsEnabled: async () => true }), idempotencyKey, pseudonymKey,
      mode: "CONTROL_ENABLED", policyVersion: RECORDING_CONTROL_POLICY_VERSION, approvedPolicyVersion: RECORDING_CONTROL_POLICY_VERSION,
      consentColumnId: "consent_status", pilotUserIds: [7], pilotNumberIds: [9] });
    assert.deepEqual(await service.revalidate({ phoneDigits: "15125550100" }), { authorized: false, reason: "schema_drift" });
    assert.equal(lookups, 0);
  }
});

test("real receiver serves local health/readiness and processes only strict authenticated JSON", async (t) => {
  const seen = [];
  const receiver = createRecordingControlReceiver({ expectedWebhookToken: token, service: { process: async (value) => { seen.push(value); return { accepted: true, outcome: "left_disabled", reason: "mode_not_control_enabled" }; } },
    readiness: async () => ({ state: "staged", db: true, schema: true, actionsEnabled: false, workerAuthority: false, providerAuthority: false, checkedAt: "2026-08-02T00:00:00.000Z" }),
    mode: "DISABLED", armed: false, host: "127.0.0.1", port: 0 });
  const address = await receiver.start();
  t.after(() => receiver.close());
  const origin = `http://127.0.0.1:${address.port}`;
  let response = await fetch(`${origin}/health`); assert.equal(response.status, 200);
  response = await fetch(`${origin}/ready`); assert.equal(response.status, 200);
  const ready = await response.json(); assert.equal(ready.armed, false); assert.equal(ready.ok, true); assert.equal(ready.state, "staged"); assert.equal(JSON.stringify(ready).includes("7727339040"), false);
  response = await fetch(`${origin}/aircall/recording/control-events`, { method: "POST", headers: { "content-type": "application/json" }, body: payload() });
  assert.equal(response.status, 202); assert.equal(seen.length, 1);
  response = await fetch(`${origin}/aircall/recording/control-events`, { method: "POST", headers: { "content-type": "application/json" }, body: payload({}, { extra: true }) });
  assert.equal(response.status, 400); assert.equal(seen.length, 1);
  response = await fetch(`${origin}/aircall/recording/control-events`, { method: "POST", headers: { "content-type": "text/plain" }, body: payload() });
  assert.equal(response.status, 415);
});

test("receiver readiness is unavailable only when operational dependencies fail", async (t) => {
  const receiver = createRecordingControlReceiver({ expectedWebhookToken: token, service: { process: async () => ({ accepted: true }) }, readiness: async () => ({ state: "not_ready", db: true, schema: false }), mode: "CONTROL_ENABLED", armed: true });
  const address = await receiver.start(); t.after(() => receiver.close());
  const response = await fetch(`http://127.0.0.1:${address.port}/ready`);
  assert.equal(response.status, 503); assert.equal((await response.json()).armed, true);
});

test("config defaults disabled but always requires canonical 32-byte capability key and hostile input is rejected", () => {
  assert.equal(readRecordingControlConfig(baseEnv()).mode, "DISABLED");
  for (const bad of [undefined, "", "AAAA", capabilityKey.replace(/=$/, "=="), capabilityKey.slice(0, -1) + "A"])
    assert.throws(() => readRecordingControlConfig(baseEnv({ RECORDING_CAPABILITY_ACTIVE_KEY: bad })), /key|environment|secrets/);
  for (const environment of [
    baseEnv({ RECORDING_CONTROL_MODE: "enabled" }), baseEnv({ RECORDING_CONTROL_HOST: "0.0.0.0" }),
    baseEnv({ RECORDING_CONTROL_PORT: "0" }), baseEnv({ RECORDING_PILOT_USER_IDS: "7, 8" }), baseEnv({ RECORDING_PILOT_NUMBER_IDS: "9,9" }),
  ]) assert.throws(() => readRecordingControlConfig(environment));
  assert.throws(() => readRecordingControlConfig(baseEnv({ RECORDING_CONTROL_MODE: "CONTROL_ENABLED" })), /activation/);
  const armed = readRecordingControlConfig(baseEnv({ RECORDING_CONTROL_MODE: "CONTROL_ENABLED", CONTROL_ENABLED: "true", RECORDING_CONTROL_POLICY_VERSION,
    AIRCALL_API_ID: "id", AIRCALL_API_KEY: "key", RECORDING_PILOT_USER_IDS: "7", RECORDING_PILOT_NUMBER_IDS: "9" }));
  assert.equal(armed.envArmed, true);
});

test("config rejects reuse across every recording secret representation and comparable key material", () => {
  for (const overrides of [
    { RECORDING_IDEMPOTENCY_HMAC_KEY: token },
    { RECORDING_PSEUDONYM_HMAC_KEY: token },
    { RECORDING_PSEUDONYM_HMAC_KEY: idempotencyKey },
    { AIRCALL_CONTROL_WEBHOOK_TOKEN: capabilityKey },
    { RECORDING_IDEMPOTENCY_HMAC_KEY: capabilityKey },
    { RECORDING_PSEUDONYM_HMAC_KEY: capabilityKey },
    { RECORDING_IDEMPOTENCY_HMAC_KEY: Buffer.alloc(32, 1).toString("latin1") },
    { RECORDING_CAPABILITY_PREVIOUS_KEYS: `old:${capabilityKey}` },
  ]) assert.throws(() => readRecordingControlConfig(baseEnv(overrides)), /separate_recording_secrets_required/);
});

test("disabled runtime composes against the fixed store and never constructs or starts worker authority", async () => {
  let providerConstructions = 0;
  let workerConstructions = 0;
  let starts = 0;
  let receiverOptions;
  let storeOptions;
  const runtime = createRecordingControlRuntime({ env: baseEnv({ AIRCALL_API_ID: "present-but-inert", AIRCALL_API_KEY: "present-but-inert" }),
    fetchImpl: async () => { throw new Error("not called during composition"); }, createStore: (options) => { storeOptions = options; return fixedStore(); },
    createProvider: () => { providerConstructions += 1; return { resumeRecording: async () => {} }; },
    createWorker: () => { workerConstructions += 1; return { runOnce: async () => {} }; },
    workerLoopFactory: () => ({ start: () => { starts += 1; }, stop: async () => {} }),
    createReceiver: (options) => { receiverOptions = options; return { start: async () => ({ address: "127.0.0.1", port: 1 }), close: async () => {} }; },
  });
  assert.equal(runtime.config.armed, false); assert.equal(receiverOptions.armed, false);
  assert.equal(storeOptions.approvalPublicKey, approvalPublicKey);
  assert.equal("approvalKey" in storeOptions, false);
  await startRecordingControlRuntime(runtime);
  assert.deepEqual([providerConstructions, workerConstructions, starts], [0, 0, 0]);
});

test("armed runtime alone constructs and starts one worker loop", async () => {
  let starts = 0;
  const env = baseEnv({ RECORDING_CONTROL_MODE: "CONTROL_ENABLED", CONTROL_ENABLED: "true", RECORDING_CONTROL_POLICY_VERSION,
    AIRCALL_API_ID: "id", AIRCALL_API_KEY: "key", RECORDING_PILOT_USER_IDS: "7", RECORDING_PILOT_NUMBER_IDS: "9" });
  const schemaFetch = async () => new Response(JSON.stringify({ data: { boards: [{ id: "7727339040", columns: [
    { id: "text_2", type: "text" }, { id: "phone__1", type: "phone" }, { id: "dup__of_phone7__1", type: "phone" },
    { id: "phone_mkrgdn4", type: "phone" }, { id: "dropdown_mm5v99w5", type: "dropdown", settings_str: JSON.stringify({ labels: [
      { name: "Verified — Permit Recording" }, { name: "Verified — Do Not Record" }], allow_multiple_selection: false }) },
  ] }] } }), { status: 200, headers: { "content-type": "application/json" } });
  const runtime = createRecordingControlRuntime({ env, fetchImpl: schemaFetch, createStore: () => fixedStore({
    isActionsEnabled: async () => true,
    hasMatchingActivation: async () => true,
    readiness: async () => ({ schema: true, actionsEnabled: true, activationMatches: true, reconciliationCount: 0, unknownKeyCount: 0 }),
  }),
    createProvider: () => ({ resumeRecording: async () => {} }), createWorker: () => ({ runOnce: async () => {} }),
    workerLoopFactory: () => ({ start: () => { starts += 1; }, stop: async () => {} }),
    createReceiver: () => ({ start: async () => ({ address: "127.0.0.1", port: 1 }), close: async () => {} }) });
  await startRecordingControlRuntime(runtime); assert.equal(starts, 1);
});

test("worker loop never overlaps and graceful stop awaits the active call", async () => {
  let concurrent = 0; let maximum = 0; let runs = 0; let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const loop = createWorkerLoop({ runOnce: async () => { concurrent += 1; maximum = Math.max(maximum, concurrent); runs += 1; await gate; concurrent -= 1; } }, { intervalMs: 1 });
  loop.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(runs, 1); assert.equal(maximum, 1);
  assert.equal(loop.health().active, true); assert.equal(loop.health().running, true); assert.equal(loop.health().lastRunAt, null);
  const stopping = loop.stop(); let stopped = false; stopping.then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 5)); assert.equal(stopped, false);
  release(); await stopping; assert.equal(stopped, true);
  const health = loop.health(); assert.equal(health.active, false); assert.equal(health.running, false);
  assert.equal(health.consecutiveFailures, 0); assert.equal(health.lastOutcome, "unknown"); assert.equal(Number.isFinite(Date.parse(health.lastRunAt)), true);
});
