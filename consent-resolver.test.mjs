import assert from "node:assert/strict";
import test from "node:test";
import { resolveCanonicalConsent } from "./consent-resolver.mjs";

const CANONICAL_BOARD_ID = "canonical-board-for-test";
const STATE_SOURCE = "sales_board_business_state";
const PHONE = "15551234567";
const json = (value) => JSON.stringify(value);

function verifiedState(value = "TX", overrides = {}) {
  return { value, source: STATE_SOURCE, verified: true, ...overrides };
}
function lead(overrides = {}) {
  return { id: "lead-1", boardId: CANONICAL_BOARD_ID, state: verifiedState(), phoneDigits: PHONE, ...overrides };
}
function resolver(overrides = {}) {
  return {
    canonicalBoardId: CANONICAL_BOARD_ID,
    stateSource: STATE_SOURCE,
    getConsentLeadById: async () => null,
    findConsentLeadsByPhone: async () => json([]),
    ...overrides,
  };
}

test("trusts a native item only after the same item has unique exact phone association", async () => {
  let phoneLookups = 0;
  const result = await resolveCanonicalConsent({
    nativeItemId: "native-lead", phoneDigits: PHONE,
    ...resolver({
      getConsentLeadById: async (id) => json(lead({ id, state: verifiedState(" tx ") })),
      findConsentLeadsByPhone: async () => { phoneLookups += 1; return json([lead({ id: "native-lead" })]); },
    }),
  });
  assert.deepEqual(result, { item: { id: "native-lead", boardId: CANONICAL_BOARD_ID, state: "TX" }, method: "native_item_id", reason: null });
  assert.equal(phoneLookups, 1);
});

test("native item fails closed when exact phone association is absent, ambiguous, or belongs to another item", async () => {
  for (const matches of [[], [lead({ id: "native-lead" }), lead({ id: "two" })], [lead({ id: "different" })]]) {
    const result = await resolveCanonicalConsent({
      nativeItemId: "native-lead", phoneDigits: PHONE,
      ...resolver({ getConsentLeadById: async () => json(lead({ id: "native-lead" })), findConsentLeadsByPhone: async () => json(matches) }),
    });
    assert.equal(result.item, null);
  }
});

test("parses a unique phone JSON array string after a null native lookup", async () => {
  const result = await resolveCanonicalConsent({
    nativeItemId: "missing-native", phoneDigits: PHONE,
    ...resolver({
      getConsentLeadById: async () => null,
      findConsentLeadsByPhone: async (phone) => { assert.equal(phone, PHONE); return json([lead({ id: "phone-lead", state: verifiedState("ca") })]); },
    }),
  });
  assert.deepEqual(result, { item: { id: "phone-lead", boardId: CANONICAL_BOARD_ID, state: "CA" }, method: "unique_phone", reason: null });
});

test("objects and Proxies from either adapter are denied rather than becoming items", async () => {
  const proxy = new Proxy(lead(), {});
  for (const payload of [lead(), proxy]) {
    const native = await resolveCanonicalConsent({ nativeItemId: "native-lead", phoneDigits: PHONE, ...resolver({ getConsentLeadById: async () => payload }) });
    assert.deepEqual(native, { item: null, method: "native_item_id", reason: "invalid_native_lookup_result" });
    const phone = await resolveCanonicalConsent({ phoneDigits: PHONE, ...resolver({ findConsentLeadsByPhone: async () => payload }) });
    assert.deepEqual(phone, { item: null, method: "unique_phone", reason: "invalid_phone_lookup_result" });
  }
});

test("malformed JSON and wrong top-level JSON shapes are denied", async () => {
  for (const payload of [undefined, "not json", json(null), json([]), json("record")]) {
    const result = await resolveCanonicalConsent({ nativeItemId: "native-lead", phoneDigits: PHONE, ...resolver({ getConsentLeadById: async () => payload }) });
    assert.deepEqual(result, { item: null, method: "native_item_id", reason: "invalid_native_lookup_result" });
  }
  for (const payload of [undefined, "not json", json(null), json({}), json("records")]) {
    const result = await resolveCanonicalConsent({ phoneDigits: PHONE, ...resolver({ findConsentLeadsByPhone: async () => payload }) });
    assert.deepEqual(result, { item: null, method: "unique_phone", reason: "invalid_phone_lookup_result" });
  }
});

test("Maps evidence, free text, wrong source, and unverified JSON provenance are denied", async () => {
  const invalidStates = [
    "TX",
    { value: "TX", source: STATE_SOURCE, verified: false },
    { value: "TX", source: "maps_places_candidate", verified: true },
    { value: "TX", source: STATE_SOURCE },
    { value: "Texas", source: STATE_SOURCE, verified: true },
    { mapEntries: [["value", "TX"], ["source", STATE_SOURCE], ["verified", true]] },
    { evidence: "Maps says TX", source: "maps_places_candidate", verified: true },
  ];
  for (const state of invalidStates) {
    const result = await resolveCanonicalConsent({
      nativeItemId: "native-lead", phoneDigits: PHONE,
      ...resolver({ getConsentLeadById: async () => json(lead({ id: "native-lead", state })) }),
    });
    assert.deepEqual(result, { item: null, method: "native_item_id", reason: "invalid_state_provenance" });
  }
});

test("denies bad canonical identity, ambiguous phones, and nonmatching phone evidence", async () => {
  for (const item of [lead({ id: "different" }), lead({ boardId: "wrong-board" })]) {
    const result = await resolveCanonicalConsent({ nativeItemId: "native-lead", phoneDigits: PHONE, ...resolver({ getConsentLeadById: async () => json(item) }) });
    assert.equal(result.item, null);
  }
  for (const matches of [[], [lead(), lead({ id: "two" })], [lead({ phoneDigits: "19998887777" })]]) {
    const result = await resolveCanonicalConsent({ phoneDigits: PHONE, ...resolver({ findConsentLeadsByPhone: async () => json(matches) }) });
    assert.equal(result.item, null);
  }
});

test("rejects invalid inputs, lookup failures, and invalid configured source", async () => {
  for (const input of [null, [], "bad", 42]) assert.deepEqual(await resolveCanonicalConsent(input), { item: null, method: "none", reason: "invalid_input" });
  assert.deepEqual(await resolveCanonicalConsent({ nativeItemId: "native-lead", phoneDigits: PHONE, ...resolver({ getConsentLeadById: async () => { throw new Error("down"); } }) }), { item: null, method: "native_item_id", reason: "native_lookup_failed" });
  assert.deepEqual(await resolveCanonicalConsent({ nativeItemId: "native-lead", phoneDigits: PHONE, ...resolver({ stateSource: "", getConsentLeadById: async () => json(lead()) }) }), { item: null, method: "none", reason: "invalid_state_source" });
});
