import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAircallDeletionReconciler, createProtectedTwoPartyStore, signTrustedDecision } from "./two-party-finalizer-adapters.mjs";
import { createTwoPartyFinalizerRunner } from "./two-party-finalizer-runner.mjs";

const key = Buffer.alloc(32, 7).toString("base64");
const hmacKey = Buffer.alloc(32, 8).toString("base64");
const correlation = Object.freeze({ callId: "call-1", externalPhone: "+1 555 123 4567", aircallNumber: "+1 555 765 4321", started: "2026-08-05T10:00:00Z", answered: "2026-08-05T10:00:05Z", ended: "2026-08-05T10:03:00Z" });
const decision = Object.freeze({ decisionId: "decision-1", audited: true, controller: "two_party", action: "delete_recording", correlation });
async function store() { const dir = await mkdtemp(join(tmpdir(), "two-party-finalizer-")); const file = join(dir, "protected.jsonl"); return { store: createProtectedTwoPartyStore({ file, capabilityKey: key, hmacKey }), file }; }

test("protected store merges answer/asset correlation, refuses uncorrelated decisions, and is root-only encrypted", async () => {
  const { store: s, file } = await store();
  assert.deepEqual(await s.captureEvent({ ...correlation, ended: null }), { stored: true, duplicate: false });
  assert.deepEqual(await s.captureEvent({ ...correlation, started: null, answered: null }), { stored: true, duplicate: false });
  await assert.rejects(s.persistDecision(decision), /invalid_trusted_two_party_decision/);
  assert.deepEqual(await s.persistDecision(signTrustedDecision(decision, hmacKey)), { stored: true, duplicate: false });
  assert.deepEqual(await s.persistDecision(signTrustedDecision(decision, hmacKey)), { stored: true, duplicate: true });
  assert.equal((await s.state("decision-1")).some(x => x.type === "decision"), true);
  const raw = await readFile(file, "utf8"); assert.equal(raw.includes("call-1"), false);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("Aircall deletion is at-most-once locally and requires GET evidence before returning deleted", async () => {
  const { store: s } = await store(); await s.captureEvent(correlation); await s.persistDecision(signTrustedDecision(decision, hmacKey));
  const calls = []; const fetchImpl = async (url, options = {}) => { calls.push({ url, method: options.method ?? "GET" }); if (options.method === "DELETE") return { ok: true, status: 204 }; return { ok: true, status: 200, json: async () => ({ call: { id: "call-1", recording: "" } }) }; };
  const adapter = createAircallDeletionReconciler({ apiId: "a".repeat(16), apiKey: "b".repeat(16), idempotencyKey: hmacKey, fetchImpl, store: s });
  assert.equal((await adapter.reconcileDeletion(decision)).deleted, true);
  assert.equal((await adapter.reconcileDeletion(decision)).source, "durable_reconciliation");
  assert.deepEqual(calls.map(x => x.method), ["DELETE", "GET"]);
});

test("timer runner finalizes only after injected trusted reconciliation and records its terminal marker", async () => {
  const { store: s } = await store(); await s.captureEvent(correlation); await s.persistDecision(signTrustedDecision(decision, hmacKey));
  const env = { TWO_PARTY_FINALIZER_STORE: "/tmp/unused", RECORDING_CAPABILITY_ACTIVE_KEY: key, RECORDING_IDEMPOTENCY_HMAC_KEY: hmacKey, AIRCALL_API_ID: "a".repeat(16), AIRCALL_API_KEY: "b".repeat(16), MONDAY_API_TOKEN: "c".repeat(16) };
  const monday = { findCandidates: async () => [{ itemId: "item-1", boardId: "18419412577", dateColumnIds: { Started: "s", Answered: "a", Ended: "e" }, columns: [{ id: "text_mm4nwyyx", text: "call-1" }, { id: "phone_mm4n3c52", text: correlation.externalPhone }, { id: "phone_mm4nps2a", text: correlation.aircallNumber }, { id: "s", value: JSON.stringify({ date: "2026-08-05", time: "10:00:00" }) }, { id: "a", value: JSON.stringify({ date: "2026-08-05", time: "10:00:05" }) }, { id: "e", value: JSON.stringify({ date: "2026-08-05", time: "10:03:00" }) }] }], clearRecordingLink: async () => {}, readRecordingLink: async () => ({ id: "link_mm4n5qp", text: "", value: null }) };
  const runner = createTwoPartyFinalizerRunner({ env, store: s, monday, reconciler: { reconcileDeletion: async () => ({ deleted: true }) } });
  assert.deepEqual(await runner.runOnce(), { scanned: 1, finalized: 1, results: [{ decisionId: "decision-1", status: "link_cleared_and_verified" }] });
  assert.deepEqual(await runner.runOnce(), { scanned: 0, finalized: 0, results: [] });
});
