import assert from "node:assert/strict";
import test from "node:test";
import { createAircallRetentionAdapter, createMondayRetentionAdapter, createTimberlineRetentionWorkerFromEnv, runTimberlineRetentionWorkerOnce } from "./timberline-retention-worker.mjs";

const env = { TIMBERLINE_RETENTION_DATABASE_URL: "postgres://unused", TIMBERLINE_RETENTION_CAPABILITY_KEY: Buffer.alloc(32, 7).toString("base64"), TIMBERLINE_RETENTION_CORRELATION_KEY: "c".repeat(32), AIRCALL_API_ID: "a".repeat(20), AIRCALL_API_KEY: "b".repeat(20), MONDAY_API_TOKEN: "m".repeat(20) };
function idleStore() { const calls = []; return { calls, async recordDecision() { calls.push("recordDecision"); }, async enqueueAsset() { calls.push("enqueueAsset"); }, async claimNext() { calls.push("claimNext"); return null; }, async markDeleteRequested() { calls.push("markDeleteRequested"); }, async markDeleteConfirmed() { calls.push("markDeleteConfirmed"); }, async markMondayCleared() { calls.push("markMondayCleared"); }, async releaseForReconcile() { calls.push("releaseForReconcile"); }, async markException() { calls.push("markException"); }, async close() { calls.push("close"); } }; }
test("one-shot runner accepts injected dependencies and idle run makes no provider or Monday mutation", async () => {
  const store = idleStore(), calls = []; const aircall = { async deleteRecording() { calls.push("delete"); }, async recordingUnavailable() { calls.push("get"); return false; } }, monday = { async clearExactRecordingLink() { calls.push("clear"); }, async readExactRecordingLink() { calls.push("read"); return null; } };
  const created = createTimberlineRetentionWorkerFromEnv(env, { store, aircall, monday });
  assert.deepEqual(store.calls, []); assert.deepEqual(calls, []);
  assert.deepEqual(await created.worker.runOnce(), { outcome: "idle" });
  assert.deepEqual(store.calls, ["claimNext"]); assert.deepEqual(calls, []);
  assert.deepEqual(await runTimberlineRetentionWorkerOnce(env, { store, aircall, monday }), { outcome: "idle" });
  assert.equal(store.calls.includes("close"), false, "injected store is not closed by runner");
});
test("Aircall adapter is bounded to DELETE recording then GET reconciliation", async () => {
  const requests = []; const fetchImpl = async (url, init) => { requests.push({ url, init }); return init.method === "DELETE" ? { ok: true } : { ok: false, status: 404 }; };
  const adapter = createAircallRetentionAdapter({ aircallId: env.AIRCALL_API_ID, aircallKey: env.AIRCALL_API_KEY, fetchImpl });
  await adapter.deleteRecording("call-1"); assert.equal(await adapter.recordingUnavailable("call-1"), true);
  assert.deepEqual(requests.map(x => [x.init.method, x.url]), [["DELETE", "https://api.aircall.io/v1/calls/call-1/recording"], ["GET", "https://api.aircall.io/v1/calls/call-1/recording"]]);
});
test("Monday adapter rejects any non-fixed board or column before a network mutation", async () => {
  let requests = 0; const monday = createMondayRetentionAdapter({ mondayToken: env.MONDAY_API_TOKEN, fetchImpl: async () => { requests++; return { ok: true, json: async () => ({ data: {} }) }; } });
  await assert.rejects(monday.clearExactRecordingLink({ boardId: "other", itemId: "item-1", columnId: "link_mm4n5qp" }), /invalid_exact_monday_target/);
  await assert.rejects(monday.readExactRecordingLink({ boardId: "18419412577", itemId: "item-1", columnId: "other" }), /invalid_exact_monday_target/);
  assert.equal(requests, 0);
});
