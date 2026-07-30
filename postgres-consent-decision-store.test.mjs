import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { createPostgresConsentDecisionStore } from "./postgres-consent-decision-store.mjs";

test("Postgres store requires databaseUrl and rejects every injected executor surface", async () => {
  assert.throws(() => createPostgresConsentDecisionStore(), /databaseUrl is required/);
  assert.throws(() => createPostgresConsentDecisionStore({ databaseUrl: "" }), /databaseUrl is required/);

  const pool = new pg.Pool();
  const facades = [
    ["client", { query: async () => ({ rows: [] }) }],
    ["query", async () => ({ rows: [] })],
    ["pool", pool],
    ["facade", { query: async () => ({ rows: [] }), connect() {} }],
  ];
  for (const [option, value] of facades) {
    assert.throws(
      () => createPostgresConsentDecisionStore({ databaseUrl: "postgres://example.invalid/consent", [option]: value }),
      new RegExp(`unsupported store option: ${option}`),
    );
  }
  assert.throws(
    () => createPostgresConsentDecisionStore(Object.create({ client: { query() {} } })),
    /plain object with databaseUrl/,
  );
  await pool.end();
});