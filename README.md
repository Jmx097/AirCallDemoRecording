# Timberline Aircall/Monday Recording Controller

This repository is an **audit-only, fail-closed baseline** for future development of a recording controller. It contains only portable consent classification and canonical-record resolution logic with unit tests.

## Current status

- **Recording is NOT enabled.** The audit-only controller flow cannot enable, start, resume, pause, or otherwise control recording.
- **The classifier is audit-only.** It always returns `action: 'leave_disabled'`; even an eligible one-party state is reported only as `audit_only_eligible_one_party_state`.
- A tested, standalone Aircall provider-client contract exists only for the per-call `resume_recording` endpoint. It is **not wired** into the controller or consent/resolver logic, is not configured, makes no live request in this baseline, and cannot be called by the audit-only controller flow.
- No webhooks, service routes, deployment assets, runtime configuration, or production integrations are included.
- `aircall-recording-event.mjs` is a pure, audit-only future-ingress boundary. It accepts only a supplied raw JSON body and supplied webhook token, compares SHA-256 digests of the UTF-8 root `token` values with `timingSafeEqual`, and normalizes only a `call.answered` event whose complete call is directly at root `payload.data`. It neither receives HTTP nor reads configuration, and it never invokes Aircall, a server, or recording actions. Its event key and 24-character correlation are **token-keyed opaque audit correlation**, intended only within the configured webhook scope: HMAC-SHA256 over `aircall-recording-v1\0event\0callId`, keyed by the expected webhook token. They exclude phone, timestamps, and the raw payload.
- Aircall's [Webhook API overview](https://developers.aircall.io/api-references#webhook-api-overview) establishes webhook tokens and events. The `payload.data` call shape is instead a redacted, local observed contract and requires live audit acceptance before operational use. Do not accept unproven alternate shapes. Token rotation changes the deduplication key, so it must use a controlled cutover/overlap or a permitted duplicate-safety stop; never use raw provider call IDs as correlation.
- This repository does **not** contain credentials, secrets, or production configuration.
- Any future move beyond audit-only operation requires explicit approval from **Dave Donovan** and separate review of the applicable legal, operational, security, and provider controls.

## Trust boundaries and baseline behavior

- Invalid, missing, ambiguous, malformed, or hostile inputs leave recording disabled.
- The audit classifier uses a supplied, version-approved ruleset solely to label an eligible one-party state. A controller policy, including an active-looking policy, has no authorization role in this baseline.
- Canonical-record adapters are a raw-payload boundary: `getConsentLeadById` must return either `null` (not found) or a **JSON object string**; `findConsentLeadsByPhone` must return a **JSON array string**. The resolver calls `JSON.parse` itself and only then creates its canonical plain records. Object returns, Proxies, malformed JSON, and wrong top-level shapes are rejected.
- Canonical state accepts only structured JSON provenance of the form `{ value, source: 'rep_verified_controlled_state_dropdown', verified: true }` (with the source configured by the caller). Maps/candidate evidence, free text, unverified data, lookup errors, and ambiguous phone associations are rejected.
- `monday-callback-adapter.mjs` is an isolated, injected **read-only** Monday callback adapter. It emits the resolver's JSON-string boundary only after verifying the configured board and a configured `status`/`dropdown` state column; phone matching crawls only that board with bounded pagination. A requested 10–15 digit phone must exactly equal the normalized digits displayed by a configured phone-column ID whose Monday column type is in the configured allowlist (default: `phone`): there is no last-ten matching or country inference, and returned `phoneDigits` preserves the matched display evidence. It enforces bounded page/item/column response shapes and stops phone discovery after two unique candidates. It has no token/API configuration, deployment, runtime connection, webhook/server, Aircall import, or write/mutation capability. Its board and column mapping must be validated against a live Monday schema in a separately approved future integration before use.
- `consent-decision-service.mjs` is an isolated, injected durable-store lifecycle service. It claims an opaque idempotency key, resolves and classifies canonical consent, then calls token-fenced `finalize(claim, outcome, correlation)`. The durable adapter must atomically record final status plus the redacted audit/outbox in one transaction; `release` is a token-fenced no-op unless that lease is still processing. The service is non-routable and non-live: it has no web/runtime/provider integration and cannot import or call the Aircall client.
- A PostgreSQL durable-store adapter and migration (`postgres-consent-decision-store.mjs`, `migrations/001-consent-decision-store.sql`) now exist for this audit-only lifecycle. They have **not** been provisioned, deployed, or runtime-configured; this remains non-routable and audit-only. Migration initialization is serialized with a transaction-scoped PostgreSQL advisory lock and commits schema changes plus the version row atomically.

### PostgreSQL store API

`createPostgresConsentDecisionStore` requires `{ databaseUrl }`. The adapter exclusively owns the `pg` pool it creates: direct `client`, `query`, `pool`, facade, and other executor injection are unsupported and rejected. It acquires and releases one client via `pool.connect()` for every migration and finalization transaction. `finalize` keeps `BEGIN`, its fenced claim update, audit/outbox insert, and `COMMIT` (or `ROLLBACK`) on that acquired client; the static migration is sent as separate SQL statements inside its own advisory-lock-protected transaction rather than as a multi-statement query.

The source-of-truth policy for callback business state is documented in [docs/callback-business-state-policy.md](docs/callback-business-state-policy.md). The safe audit-only fixture is [policy/recording-controller.policy.json](policy/recording-controller.policy.json).

## Local verification

This baseline has no runtime dependencies. It requires **Node.js 20 or later**. With a supported Node.js release installed:

```sh
npm test
git diff --check
```

Do not add real credentials to this checkout. Local `.env*`, audit data, runtime data, and common key/certificate files are intentionally ignored.
