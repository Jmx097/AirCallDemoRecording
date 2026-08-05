import assert from "node:assert/strict";
import test from "node:test";
import { createDelayedMondayLinkFinalizer, createMondayCallsFinalizerAdapter, resolveUniqueCallRow } from "./two-party-recording-finalizer.mjs";

const decision = Object.freeze({
  decisionId: "decision-1", audited: true, controller: "two_party", action: "delete_recording",
  correlation: Object.freeze({ callId: "provider-call-id", externalPhone: "+1 (555) 123-4567", aircallNumber: "+1 (555) 765-4321", started: "2026-08-05T10:00:00Z", answered: "2026-08-05T10:00:05Z", ended: "2026-08-05T10:03:00Z" }),
});
const row = (itemId = "item-1", overrides = {}) => ({
  itemId, boardId: "18419412577", dateColumnIds: { Started: "date_started", Answered: "date_answered", Ended: "date_ended" },
  columns: [
    { id: "text_mm4nwyyx", text: overrides.callId ?? "different-monday-id" },
    { id: "phone_mm4n3c52", text: overrides.externalPhone ?? "+1 555 123 4567" },
    { id: "phone_mm4nps2a", text: overrides.aircallNumber ?? "+1 555 765 4321" },
    { id: "date_started", value: JSON.stringify({ date: "2026-08-05", time: "10:00:00" }) },
    { id: "date_answered", value: JSON.stringify({ date: "2026-08-05", time: "10:00:05" }) },
    { id: "date_ended", value: JSON.stringify({ date: "2026-08-05", time: "10:03:00" }) },
  ],
});

function finalizer({ deletion = { deleted: true }, rows = [row()], blank = true } = {}) {
  const calls = [];
  return { calls, service: createDelayedMondayLinkFinalizer({
    readAuditedDecision: async (id) => { calls.push(`decision:${id}`); return decision; },
    reconcileDeletion: async () => { calls.push("reconcile"); return deletion; },
    monday: {
      findCandidates: async () => { calls.push("find"); return rows; },
      clearRecordingLink: async (itemId) => { calls.push(`clear:${itemId}`); },
      readRecordingLink: async (itemId) => { calls.push(`read:${itemId}`); return blank ? { id: "link_mm4n5qp", text: "", value: null } : { id: "link_mm4n5qp", text: "still present", value: "{\"url\":\"https://example.invalid\"}" }; },
    },
  }) };
}

test("resolver accepts one exact two-phone/two-time target even when Call ID does not match the controller's provider ID", () => {
  assert.deepEqual(resolveUniqueCallRow(decision, [row()]), { status: "resolved", itemId: "item-1", callIdMatches: false, timeMatches: 3 });
});
test("resolver fails closed on missing time evidence, phone mismatch, and multiple exact targets", () => {
  const oneTime = row("item-1"); oneTime.columns[4].value = JSON.stringify({ date: "2026-08-05", time: "11:00:05" }); oneTime.columns[5].value = JSON.stringify({ date: "2026-08-05", time: "11:03:00" });
  assert.equal(resolveUniqueCallRow(decision, [oneTime]).status, "no_unique_target");
  assert.equal(resolveUniqueCallRow(decision, [row("item-1", { aircallNumber: "+1 555 000 0000" })]).status, "no_unique_target");
  assert.equal(resolveUniqueCallRow(decision, [row("item-1"), row("item-2")]).status, "ambiguous_target");
});
test("finalizer reconciles deletion before Monday, clears only the resolved item's Recording column, and reads blank", async () => {
  const f = finalizer();
  assert.deepEqual(await f.service.finalize("decision-1"), { status: "link_cleared_and_verified", itemId: "item-1", callIdMatches: false });
  assert.deepEqual(f.calls, ["decision:decision-1", "reconcile", "find", "clear:item-1", "read:item-1"]);
});
test("unreconciled deletion, ineligible audit, ambiguity, and failed readback never report finalization", async () => {
  const noDelete = finalizer({ deletion: { deleted: false } });
  assert.deepEqual(await noDelete.service.finalize("decision-1"), { status: "deletion_not_reconciled" });
  assert.deepEqual(noDelete.calls, ["decision:decision-1", "reconcile"]);
  const ambiguous = finalizer({ rows: [row("item-1"), row("item-2")] });
  assert.deepEqual(await ambiguous.service.finalize("decision-1"), { status: "ambiguous_target" });
  assert.deepEqual(ambiguous.calls, ["decision:decision-1", "reconcile", "find"]);
  const readback = finalizer({ blank: false });
  await assert.rejects(readback.service.finalize("decision-1"), /monday_recording_link_not_blank/);
  const ineligible = createDelayedMondayLinkFinalizer({ readAuditedDecision: async () => ({ ...decision, audited: false }), reconcileDeletion: async () => ({ deleted: true }), monday: { findCandidates: async () => { throw new Error("must_not_query"); }, clearRecordingLink: async () => {}, readRecordingLink: async () => ({}) } });
  assert.deepEqual(await ineligible.finalize("decision-1"), { status: "decision_not_eligible" });
});
test("Monday adapter mutation contains only link_mm4n5qp:null and readback targets the exact Calls-board item", async () => {
  const requests = [];
  const adapter = createMondayCallsFinalizerAdapter({ mondayToken: "x".repeat(20), fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body); requests.push(request);
    if (request.query.startsWith("mutation")) return { ok: true, json: async () => ({ data: { change_multiple_column_values: { id: request.variables.item } } }) };
    return { ok: true, json: async () => ({ data: { items: [{ id: "item-1", board: { id: "18419412577" }, column_values: [{ id: "link_mm4n5qp", text: "", value: null }] }] } }) };
  } });
  await adapter.clearRecordingLink("item-1");
  assert.deepEqual(JSON.parse(requests[0].variables.values), { link_mm4n5qp: null });
  assert.equal(requests[0].variables.board, "18419412577");
  assert.equal(requests[0].variables.item, "item-1");
  assert.deepEqual(await adapter.readRecordingLink("item-1"), { id: "link_mm4n5qp", text: "", value: null });
});
