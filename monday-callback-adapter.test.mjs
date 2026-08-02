import assert from "node:assert/strict";
import test from "node:test";
import { createMondayCallbackAdapter } from "./monday-callback-adapter.mjs";
import { resolveCanonicalConsent } from "./consent-resolver.mjs";

const BOARD = "canonical-board";
const STATE = "business_state";
const SOURCE = "sales_board_business_state";
const PHONES = ["phone_main", "phone_alt", "phone_third"];
const PHONE = "15551234567";


function item(id, columns, boardId = BOARD) { return { id, board: { id: boardId }, column_values: columns }; }
function state(value = "TX", type = "text") { return { id: STATE, text: value, type }; }
function phone(id, text, type = "phone") { return { id, text, type }; }
function phonePage(items) { return { data: { items_page_by_column_values: { items } } }; }
function adapter(query, overrides = {}) {
  return createMondayCallbackAdapter({ canonicalBoardId: BOARD, stateColumnId: STATE, phoneColumnIds: PHONES, stateSource: SOURCE, query, ...overrides });
}

test("rejects invalid configuration including allowed phone column types", () => {
  const query = async () => ({});
  for (const overrides of [
    { canonicalBoardId: "" }, { stateSource: "free text" }, { stateColumnId: "bad id" }, { phoneColumnIds: [] },
    { phoneColumnIds: ["phone_main", "phone_main"] }, { phoneColumnIds: [STATE] },
    { phoneColumnIds: Array.from({ length: 17 }, (_, i) => `p${i}`) }, { query: null },
    { allowedPhoneColumnTypes: [] }, { allowedPhoneColumnTypes: ["phone", "PHONE"] }, { allowedPhoneColumnTypes: ["bad type"] },
  ]) assert.throws(() => adapter(query, overrides), /invalid_monday_adapter_config/);
});

test("native lookup verifies board, raw requested identity, and canonical JSON", async () => {
  const calls = [];
  const result = await adapter(async (request) => {
    calls.push(request);
    return { data: { items: [item("native-1", [state(" ca "), phone("phone_main", "+1 (555) 123-4567")])] } };
  }).getConsentLeadById("native-1");
  assert.deepEqual(JSON.parse(result), { id: "native-1", boardId: BOARD, state: { value: "ca", source: SOURCE, verified: true }, phones: [PHONE] });
  assert.deepEqual(calls[0].variables, { itemId: "native-1", columnIds: [STATE, ...PHONES] });
  assert.match(calls[0].query, /^query ReadCanonicalItem/);
  assert.doesNotMatch(calls[0].query, /mutation/i);
  assert.equal(await adapter(async () => ({ data: { items: [item("substitute", [state(), phone("phone_main", PHONE)])] } })).getConsentLeadById("native-1"), null);
});

test("native lookup denies foreign, malformed state, candidate-only columns, and response bounds", async () => {
  const cases = [
    item("a", [state(), phone("phone_main", PHONE)], "foreign-board"), item("a", [phone("phone_main", PHONE)]),
    item("a", [state(" "), phone("phone_main", PHONE)]), item("a", [state("TX", "status"), phone("phone_main", PHONE)]),
    item("a", [state(), state("CA"), phone("phone_main", PHONE)]), item("a", [{ id: "maps_candidate", text: "TX", type: "status" }, phone("phone_main", PHONE)]),
  ];
  for (const value of cases) assert.equal(await adapter(async () => ({ data: { items: [value] } })).getConsentLeadById("a"), null);
  const overPage = Array.from({ length: 501 }, (_, index) => item(`item-${index}`, [state(), phone("phone_main", PHONE)]));
  assert.equal(await adapter(async () => ({ data: { items: overPage } })).getConsentLeadById("item-0"), null);
});

test("phone lookup requires exact normalized evidence, not last-ten/country inference", async () => {
  const calls = [];
  const result = await adapter(async (request) => {
    calls.push(request);
    return phonePage([item("phone-1", [state("NY"), phone("phone_alt", "+1 (555) 123-4567")])]);
  }).findConsentLeadsByPhone(PHONE);
  assert.deepEqual(JSON.parse(result), [{ id: "phone-1", boardId: BOARD, state: { value: "NY", source: SOURCE, verified: true }, phones: [PHONE], phoneDigits: PHONE }]);
  assert.deepEqual(calls[0].variables, { boardId: BOARD, phoneColumnId: "phone_main", phoneDigits: PHONE, columnIds: [STATE, ...PHONES] });
  assert.match(calls[0].query, /items_page_by_column_values\(board_id: \$boardId, columns: .*limit: 2\)/);
  assert.doesNotMatch(calls[0].query, /boards\s*\(/);
  assert.doesNotMatch(calls[0].query, /items_page\(limit: 500|cursor/);
  assert.doesNotMatch(calls[0].query, /mutation/i);
  assert.equal(await adapter(async () => { throw new Error("must not query"); }).findConsentLeadsByPhone("555-123-4567"), "[]");

  const collision = adapter(async () => phonePage([item("collision", [state(), phone("phone_main", "995551234567")])]));
  assert.equal(await collision.findConsentLeadsByPhone(PHONE), "[]");
  assert.deepEqual(await resolveCanonicalConsent({ canonicalBoardId: BOARD, stateSource: SOURCE, phoneDigits: PHONE, ...collision }),
    { item: null, method: "unique_phone", reason: "phone_not_found" });
  for (const exactPhone of ["5551234567", PHONE, "4415551234567", "991555123456789"]) {
    const exact = adapter(async () => phonePage([item(`id-${exactPhone.length}`, [state(), phone("phone_main", `+${exactPhone}`)])]));
    const payload = JSON.parse(await exact.findConsentLeadsByPhone(exactPhone));
    assert.equal(payload.length, 1);
    assert.equal(payload[0].phoneDigits, exactPhone);
  }
});

test("wrong phone type and parser-bound violations fail closed", async () => {
  const tooManyColumns = item("many", [state(), phone("phone_main", PHONE), phone("phone_alt", PHONE), phone("phone_third", PHONE), phone("extra", PHONE)]);
  const longText = item("long", [state(), phone("phone_main", "1".repeat(257))]);
  const wrongType = item("text-phone", [state(), phone("phone_main", PHONE, "text")]);
  const overPage = Array.from({ length: 3 }, (_, index) => item(`bound-${index}`, [state(), phone("phone_main", PHONE)]));
  for (const response of [phonePage(overPage), phonePage([tooManyColumns]), phonePage([longText]), phonePage([wrongType])]) {
    assert.equal(await adapter(async () => response).findConsentLeadsByPhone(PHONE), "[]");
  }
  const allowedText = adapter(async () => phonePage([item("text-ok", [state(), phone("phone_main", PHONE, "text")])]), { allowedPhoneColumnTypes: ["text"] });
  assert.equal(JSON.parse(await allowedText.findConsentLeadsByPhone(PHONE))[0].phoneDigits, PHONE);
});

test("two unique phone candidates still query all phone columns and resolver fails closed as nonunique", async () => {
  const calls = [];
  const dependency = adapter(async ({ variables }) => {
    calls.push(variables.phoneColumnId);
    return phonePage([
      item("one", [state(), phone("phone_main", PHONE)]), item("two", [state(), phone("phone_main", PHONE)]),
    ]);
  });
  const payload = await dependency.findConsentLeadsByPhone(PHONE);
  assert.equal(JSON.parse(payload).length, 2);
  assert.deepEqual(calls, PHONES);
  assert.deepEqual(await resolveCanonicalConsent({ canonicalBoardId: BOARD, stateSource: SOURCE, phoneDigits: PHONE, ...dependency }),
    { item: null, method: "unique_phone", reason: "phone_not_unique" });
});

test("phone lookup unions separate column results and deduplicates the same item ID", async () => {
  const calls = [];
  const dependency = adapter(async ({ variables }) => {
    calls.push(variables.phoneColumnId);
    if (variables.phoneColumnId === "phone_third") return phonePage([]);
    return phonePage([item("same", [state(), phone(variables.phoneColumnId, PHONE)])]);
  });
  const payload = JSON.parse(await dependency.findConsentLeadsByPhone(PHONE));
  assert.deepEqual(calls, PHONES);
  assert.deepEqual(payload.map(({ id }) => id), ["same"]);
});

test("phone lookup queries each configured column directly and fails closed on invalid responses", async () => {
  const queriedColumns = [];
  const direct = adapter(async ({ variables }) => {
    queriedColumns.push(variables.phoneColumnId);
    return variables.phoneColumnId === "phone_main" ? phonePage([]) : phonePage([item("found", [state(), phone("phone_alt", PHONE)])]);
  });
  assert.equal(JSON.parse(await direct.findConsentLeadsByPhone(PHONE)).length, 1);
  assert.deepEqual(queriedColumns, PHONES);
  assert.equal(await adapter(async () => phonePage([item("foreign-board", [state(), phone("phone_main", PHONE)], "other")])).findConsentLeadsByPhone(PHONE), "[]");
  assert.equal(await adapter(async () => phonePage([item("one", [state(), phone("phone_main", PHONE)]), item("two", [state(), phone("phone_main", PHONE)]), item("three", [state(), phone("phone_main", PHONE)])])).findConsentLeadsByPhone(PHONE), "[]");
  // A result from another configured column cannot satisfy this column's direct query.
  assert.equal(await adapter(async ({ variables }) => variables.phoneColumnId === "phone_main"
    ? phonePage([item("wrong-column", [state(), phone("phone_alt", PHONE)])]) : phonePage([])).findConsentLeadsByPhone(PHONE), "[]");
});

test("Sales Board state and phone evidence neither requires nor fabricates consent", async () => {
  const dependency = adapter(async () => phonePage([item("lead", [state(), phone("phone_main", PHONE)])]));
  const payload = JSON.parse(await dependency.findConsentLeadsByPhone(PHONE));
  assert.equal(payload.length, 1);
  assert.equal("consent" in payload[0], false);
  assert.equal(JSON.stringify(payload).includes("Permit Recording"), false);
});

test("query failures, hostile getters, proxies, and thenables remain redacted and nonthrowing", async () => {
  const failing = adapter(async () => { throw new Error("token=secret"); });
  await assert.rejects(() => failing.getConsentLeadById("a"), { message: "monday_read_failed" });
  await assert.rejects(() => failing.findConsentLeadsByPhone(PHONE), { message: "monday_read_failed" });
  const hostile = new Proxy({}, { get() { throw new Error("secret response"); } });
  assert.equal(await adapter(() => hostile).getConsentLeadById("a"), null);
  assert.equal(await adapter(() => hostile).findConsentLeadsByPhone(PHONE), "[]");
  const getter = { get data() { throw new Error("secret getter"); } };
  assert.equal(await adapter(() => getter).getConsentLeadById("a"), null);
  assert.equal(await adapter(() => getter).findConsentLeadsByPhone(PHONE), "[]");
  assert.equal(await adapter(() => ({ then() { throw new Error("secret thenable"); } })).findConsentLeadsByPhone(PHONE), "[]");
});
