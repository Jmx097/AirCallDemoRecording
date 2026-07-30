import assert from "node:assert/strict";
import test from "node:test";
import { createMondayCallbackAdapter } from "./monday-callback-adapter.mjs";
import { resolveCanonicalConsent } from "./consent-resolver.mjs";

const BOARD = "canonical-board";
const STATE = "controlled_state";
const SOURCE = "rep_verified_controlled_state_dropdown";
const PHONES = ["phone_main", "phone_alt"];
const PHONE = "15551234567";

function item(id, columns, boardId = BOARD) { return { id, board: { id: boardId }, column_values: columns }; }
function state(value = "TX", type = "status") { return { id: STATE, text: value, type }; }
function phone(id, text, type = "phone") { return { id, text, type }; }
function page(items, cursor = null, boardId = BOARD) { return { data: { boards: [{ id: boardId, items_page: { items, cursor } }] } }; }
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
    item("a", [state(" "), phone("phone_main", PHONE)]), item("a", [state("TX", "text"), phone("phone_main", PHONE)]),
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
    return page([item("phone-1", [state("NY", "dropdown"), phone("phone_alt", "+1 (555) 123-4567")])]);
  }).findConsentLeadsByPhone(PHONE);
  assert.deepEqual(JSON.parse(result), [{ id: "phone-1", boardId: BOARD, state: { value: "NY", source: SOURCE, verified: true }, phones: [PHONE], phoneDigits: PHONE }]);
  assert.deepEqual(calls[0].variables, { boardId: BOARD, cursor: null, columnIds: [STATE, ...PHONES] });
  assert.match(calls[0].query, /limit: 500/);
  assert.doesNotMatch(calls[0].query, /mutation/i);
  assert.equal(await adapter(async () => { throw new Error("must not query"); }).findConsentLeadsByPhone("555-123-4567"), "[]");

  const collision = adapter(async () => page([item("collision", [state(), phone("phone_main", "995551234567")])]));
  assert.equal(await collision.findConsentLeadsByPhone(PHONE), "[]");
  assert.deepEqual(await resolveCanonicalConsent({ canonicalBoardId: BOARD, stateSource: SOURCE, phoneDigits: PHONE, ...collision }),
    { item: null, method: "unique_phone", reason: "phone_not_found" });
  for (const exactPhone of ["5551234567", PHONE, "4415551234567", "991555123456789"]) {
    const exact = adapter(async () => page([item(`id-${exactPhone.length}`, [state(), phone("phone_main", `+${exactPhone}`)])]));
    const payload = JSON.parse(await exact.findConsentLeadsByPhone(exactPhone));
    assert.equal(payload.length, 1);
    assert.equal(payload[0].phoneDigits, exactPhone);
  }
});

test("wrong phone type and parser-bound violations fail closed", async () => {
  const tooManyColumns = item("many", [state(), phone("phone_main", PHONE), phone("phone_alt", PHONE), phone("extra", PHONE)]);
  const longText = item("long", [state(), phone("phone_main", "1".repeat(257))]);
  const wrongType = item("text-phone", [state(), phone("phone_main", PHONE, "text")]);
  const overPage = Array.from({ length: 501 }, (_, index) => item(`bound-${index}`, [state(), phone("phone_main", PHONE)]));
  for (const response of [page(overPage), page([tooManyColumns]), page([longText]), page([wrongType])]) {
    assert.equal(await adapter(async () => response).findConsentLeadsByPhone(PHONE), "[]");
  }
  const allowedText = adapter(async () => page([item("text-ok", [state(), phone("phone_main", PHONE, "text")])]), { allowedPhoneColumnTypes: ["text"] });
  assert.equal(JSON.parse(await allowedText.findConsentLeadsByPhone(PHONE))[0].phoneDigits, PHONE);
});

test("two unique phone candidates stop the crawl and resolver fails closed as nonunique", async () => {
  const calls = [];
  const dependency = adapter(async ({ variables }) => {
    calls.push(variables.cursor);
    return page([
      item("one", [state(), phone("phone_main", PHONE)]), item("two", [state(), phone("phone_main", PHONE)]),
      item("three", [state(), phone("phone_main", PHONE)]),
    ], "must-not-fetch");
  });
  const payload = await dependency.findConsentLeadsByPhone(PHONE);
  assert.equal(JSON.parse(payload).length, 2);
  assert.deepEqual(calls, [null]);
  assert.deepEqual(await resolveCanonicalConsent({ canonicalBoardId: BOARD, stateSource: SOURCE, phoneDigits: PHONE, ...dependency }),
    { item: null, method: "unique_phone", reason: "phone_not_unique" });
});

test("phone crawl paginates and fails closed on bad board, repeated cursor, or page limit", async () => {
  const cursors = [];
  const paged = adapter(async ({ variables }) => {
    cursors.push(variables.cursor);
    return variables.cursor === null ? page([], "next") : page([item("found", [state(), phone("phone_main", PHONE)])]);
  });
  assert.equal(JSON.parse(await paged.findConsentLeadsByPhone(PHONE)).length, 1);
  assert.deepEqual(cursors, [null, "next"]);
  assert.equal(await adapter(async () => page([], null, "other")).findConsentLeadsByPhone(PHONE), "[]");
  assert.equal(await adapter(async () => page([], "again")).findConsentLeadsByPhone(PHONE), "[]");
  let count = 0;
  assert.equal(await adapter(async () => { count += 1; return page([], `c${count}`); }).findConsentLeadsByPhone(PHONE), "[]");
  assert.equal(count, 20);
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
