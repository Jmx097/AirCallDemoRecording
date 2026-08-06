import assert from "node:assert/strict";
import test from "node:test";
import { createTimberlineAnswerTimeRetentionWriter } from "./timberline-answer-time-retention-writer.mjs";

const secrets = { aircallId: "a".repeat(16), aircallKey: "b".repeat(16), mondayToken: "c".repeat(16) };
const callId = "aircall-123", external = "15551234567";
function response(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
function harness({ items = ["calls-item-1"], call = validCall(), createId = "created-calls-item" } = {}) {
  const requests = [], decisions = []; let created = false;
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).startsWith("https://api.aircall.io/")) return response({ call });
    if (String(url) === "https://api.monday.com/v2") {
      const request = JSON.parse(init.body);
      if (request.query.startsWith("mutation")) { created = true; return response({ data: { create_item: { id: createId } } }); }
      const current = created && items.length === 0 ? [createId] : items;
      return response({ data: { items_page_by_column_values: { items: current.map(id => ({ id, board: { id: "18419412577" }, column_values: [{ id: "text_mm4nwyyx", type: "text", text: callId }] })) } } });
    }
    throw new Error("unexpected_request");
  };
  const writer = createTimberlineAnswerTimeRetentionWriter({ ...secrets, fetchImpl, finalizer: { async recordAnswerTimeDecision(d) { decisions.push(d); return { recorded: true }; } } });
  return { writer, requests, decisions };
}
function validCall() { return { id: callId, raw_digits: external, number: { raw_digits: "+1 (555) 123-4568" }, started_at: "2026-08-05T10:00:00.000Z", answered_at: "2026-08-05T10:00:10.000Z" }; }

test("records only an exact immutable Calls-board match using Aircall GET details", async () => {
  const h = harness();
  await h.writer.recordAfterSuccessfulPause({ providerCallId: callId, externalPhoneDigits: external });
  assert.deepEqual(h.decisions, [{ policyOutcome: "two_party_delete", providerCallId: callId, callsItemId: "calls-item-1", externalPhoneDigits: external, scopedPhoneDigits: "15551234568", callStartedAt: "2026-08-05T10:00:00.000Z", answeredAt: "2026-08-05T10:00:10.000Z" }]);
  assert.deepEqual(h.requests.map(x => [x.init.method, x.url]), [["GET", `https://api.aircall.io/v1/calls/${callId}`], ["POST", "https://api.monday.com/v2"]]);
  const lookup = JSON.parse(h.requests[1].init.body); assert.deepEqual(lookup.variables, { board: "18419412577", column: "text_mm4nwyyx", value: callId });
  assert.equal(h.requests.some(x => /delete|clear|mutation/i.test(`${x.init.method} ${x.init.body ?? ""}`)), false);
});

test("creates and re-reads a missing immutable Calls row, while multiple rows still fail closed", async () => {
  const missing = harness({ items: [] });
  await missing.writer.recordAfterSuccessfulPause({ providerCallId: callId, externalPhoneDigits: external });
  assert.equal(missing.decisions[0].callsItemId, "created-calls-item");
  const mutation = JSON.parse(missing.requests[2].init.body);
  assert.deepEqual(JSON.parse(mutation.variables.values), { text_mm4nwyyx: callId });
  const multiple = harness({ items: ["one", "two"] });
  await assert.rejects(multiple.writer.recordAfterSuccessfulPause({ providerCallId: callId, externalPhoneDigits: external }), /missing_or_ambiguous_calls_item/);
  assert.equal(multiple.decisions.length, 0);
});

test("missing, malformed, or webhook-conflicting trusted details fail closed before decision persistence", async () => {
  for (const call of [{ ...validCall(), answered_at: undefined }, { ...validCall(), number: {} }, { ...validCall(), raw_digits: "15551230000" }, { ...validCall(), started_at: "not-a-date" }]) {
    const h = harness({ call });
    await assert.rejects(h.writer.recordAfterSuccessfulPause({ providerCallId: callId, externalPhoneDigits: external }));
    assert.equal(h.decisions.length, 0);
  }
});
