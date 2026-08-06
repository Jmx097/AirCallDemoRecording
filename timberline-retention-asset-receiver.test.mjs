import assert from "node:assert/strict";
import test from "node:test";
import { createTwoPartyRetentionFinalizer } from "./two-party-retention-finalizer.mjs";
import { createTimberlineRetentionAssetReceiver, normalizeRetentionAssetEvent } from "./timberline-retention-asset-receiver.mjs";

const token = "t".repeat(32);
const event = (extra = {}) => JSON.stringify({ token, event: "call.comm_assets_generated", data: { id: "call-42", asset_id: "asset-9", ...extra } });
async function post(origin, body, headers = { "content-type": "application/json" }) { const response = await fetch(`${origin}/aircall/retention/assets`, { method: "POST", headers, body }); return { status: response.status, body: await response.json() }; }
function finalizerHarness() {
  const actions = [], calls = { enqueue: 0, deletes: 0, monday: 0 }; const decision = new Set(["call-42"]);
  const store = {
    async recordDecision() { return { recorded: true }; },
    async enqueueAsset(input) { calls.enqueue++; if (!decision.has(input.providerCallId)) return { status: "missing_decision" }; if (actions.includes(input.assetKey)) return { status: "duplicate" }; actions.push(input.assetKey); return { status: "queued" }; },
    async claimNext() { return null; }, async markDeleteRequested() {}, async markDeleteConfirmed() {}, async markMondayCleared() {}, async releaseForReconcile() {}, async markException() {},
  };
  const finalizer = createTwoPartyRetentionFinalizer({ store, correlationKey: "k".repeat(32), aircall: { async deleteRecording() { calls.deletes++; }, async recordingUnavailable() { return false; } }, monday: { async clearExactRecordingLink() { calls.monday++; }, async readExactRecordingLink() { return null; } } });
  return { finalizer, actions, calls };
}
test("receiver rejects bad token, wrong event, malformed asset, and content type without enqueue", async () => {
  const h = finalizerHarness(), receiver = createTimberlineRetentionAssetReceiver({ token, finalizer: h.finalizer }); const address = await receiver.start({ port: 0 }); const origin = `http://${address.host}:${address.port}`;
  try {
    for (const body of [JSON.stringify({ token: "x".repeat(32), event: "call.comm_assets_generated", data: { id: "call-42", asset_id: "asset-9" } }), JSON.stringify({ token, event: "call.ended", data: { id: "call-42", asset_id: "asset-9" } }), JSON.stringify({ token, event: "call.comm_assets_generated", data: { id: "call-42" } }), "not-json"]) assert.equal((await post(origin, body)).status, 401);
    assert.equal((await post(origin, event(), { "content-type": "text/plain" })).status, 404);
    assert.equal(h.calls.enqueue, 0); assert.equal(h.calls.deletes, 0); assert.equal(h.calls.monday, 0);
  } finally { await receiver.close(); }
});
test("authenticated duplicate Aircall assets enqueue one action and receiver has no mutation path", async () => {
  const h = finalizerHarness(), receiver = createTimberlineRetentionAssetReceiver({ token, finalizer: h.finalizer }); const address = await receiver.start({ port: 0 }); const origin = `http://${address.host}:${address.port}`;
  try { assert.deepEqual(await post(origin, event()), { status: 202, body: { accepted: true, outcome: "queued" } }); assert.deepEqual(await post(origin, event()), { status: 202, body: { accepted: true, outcome: "duplicate" } }); assert.equal(h.actions.length, 1); assert.equal(h.calls.deletes, 0); assert.equal(h.calls.monday, 0); } finally { await receiver.close(); }
});
test("missing decision is a receive-only no-op", async () => {
  const h = finalizerHarness(), receiver = createTimberlineRetentionAssetReceiver({ token, finalizer: h.finalizer }); const address = await receiver.start({ port: 0 });
  try { assert.deepEqual(await post(`http://${address.host}:${address.port}`, event({ id: "unknown" })), { status: 202, body: { accepted: true, outcome: "missing_decision" } }); assert.equal(h.actions.length, 0); assert.equal(h.calls.deletes, 0); assert.equal(h.calls.monday, 0); } finally { await receiver.close(); }
});
test("asset identity fallback is stable only for an explicit asset value", () => {
  const first = normalizeRetentionAssetEvent(JSON.stringify({ token, event: "call.comm_assets_generated", data: { id: "call-42", recording_short_url: "https://assets.example/a" } }), token);
  const second = normalizeRetentionAssetEvent(JSON.stringify({ token, event: "call.comm_assets_generated", data: { id: "call-42", recording_short_url: "https://assets.example/a" } }), token);
  assert.ok(first?.assetId); assert.equal(first.assetId, second?.assetId); assert.equal(normalizeRetentionAssetEvent(JSON.stringify({ token, event: "call.comm_assets_generated", data: { id: "call-42" } }), token), null);
});
