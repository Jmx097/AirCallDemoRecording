# Timberline Aircall/Monday Recording Controller

This repository contains two deliberately separated runtimes: the live **audit-only** receiver and a fail-closed **automatic recording control** plane that is staged disabled until an exact pilot approval is installed.

## Current status

- **Automatic recording is NOT enabled.** The live audit-only service still cannot control recording, and the separate control runtime defaults to `DISABLED` with no worker or provider authority.
- **The audit classifier remains audit-only.** It always returns `action: 'leave_disabled'`; even an eligible one-party state is reported only as `audit_only_eligible_one_party_state`.
- The staged controller is implemented in `recording-control-runtime.mjs`. It can only request Aircall `resume_recording`, and only after exact current Sales Board State, phone, explicit consent, pilot user, pilot number, schema, activation, keyring, reconciliation, and database kill-switch gates all pass.
- The control action lifecycle is at-most-once: authorization context is AES-256-GCM encrypted, current evidence is revalidated before dispatch, `dispatching` is never lease-reclaimed, and ambiguous provider outcomes become `outcome_unknown` for manual reconciliation rather than automatic replay.
- Activation requires an unexpired Ed25519 artifact scoped to the exact deployment, policy, pilot user/number set, and consent column. The online runtime receives only the public verification key; the private signing key remains offline in a root-owned file.
- `audit-only-receiver.mjs` remains the live loopback audit receiver. `recording-control-receiver.mjs` is a separate loopback control ingress and does not replace audit service behavior merely by being deployed.
- `audit-only-runtime.mjs` uses canonical Sales Board `7727339040`, State `text_2`, and phones `phone__1`, `dup__of_phone7__1`, and `phone_mkrgdn4`. The control runtime additionally requires consent dropdown `dropdown_mm5v99w5` with the two exact approved labels and single-select behavior.
- `aircall-recording-event.mjs` is a pure, audit-only future-ingress boundary. It accepts only a supplied raw JSON body and supplied webhook token, compares SHA-256 digests of the UTF-8 root `token` values with `timingSafeEqual`, and normalizes only a `call.answered` event whose complete call is directly at root `payload.data`. It neither receives HTTP nor reads configuration, and it never invokes Aircall, a server, or recording actions. Its event key and 24-character correlation are **token-keyed opaque audit correlation**, intended only within the configured webhook scope: HMAC-SHA256 over `aircall-recording-v1\0event\0callId`, keyed by the expected webhook token. They exclude phone, timestamps, and the raw payload.
- Aircall's [Webhook API overview](https://developers.aircall.io/api-references#webhook-api-overview) establishes webhook tokens and events. The `payload.data` call shape is instead a redacted, local observed contract and requires live audit acceptance before operational use. Do not accept unproven alternate shapes. Token rotation changes the deduplication key, so it must use a controlled cutover/overlap or a permitted duplicate-safety stop; never use raw provider call IDs as correlation.
- This repository does **not** contain credentials, secrets, or production configuration.
- Any future move beyond audit-only operation requires explicit approval from **Dave Donovan** and separate review of the applicable legal, operational, security, and provider controls.

## Trust boundaries and baseline behavior

- Invalid, missing, ambiguous, malformed, or hostile inputs leave recording disabled.
- The audit classifier uses a supplied, version-approved ruleset solely to label an eligible one-party state. A controller policy, including an active-looking policy, has no authorization role in this baseline.
- Canonical-record adapters are a raw-payload boundary: `getConsentLeadById` must return either `null` (not found) or a **JSON object string**; `findConsentLeadsByPhone` must return a **JSON array string**. The resolver calls `JSON.parse` itself and only then creates its canonical plain records. Object returns, Proxies, malformed JSON, and wrong top-level shapes are rejected.
- Canonical state accepts only structured JSON provenance of the form `{ value, source: 'sales_board_business_state', verified: true }` (with the source configured by the caller). The adapter derives this only from the canonical Sales Board `State` text column. Blank or malformed State, other sources, lookup errors, and ambiguous phone associations are rejected.
- `monday-callback-adapter.mjs` is an isolated, injected **read-only** Monday adapter. It emits the resolver's JSON-string boundary only after verifying the configured board and configured `text` State column. It queries every configured phone column separately, then unions and deduplicates item IDs before the resolver rejects zero or multiple candidates. A requested 10–15 digit phone must exactly equal the normalized digits displayed by the queried phone-column ID whose Monday type is in the configured allowlist (default: `phone`): there is no last-ten matching or country inference. A native item ID is accepted only when canonical-board, exact-phone, and unique-association evidence agree. The adapter does not read, fabricate, or enforce recording consent. It has no write/mutation or provider-recording capability.
- `consent-decision-service.mjs` is an isolated, injected durable-store lifecycle service. It claims an opaque idempotency key, resolves and classifies canonical consent, then calls token-fenced `finalize(claim, outcome, correlation)`. The durable adapter must atomically record final status plus the redacted audit/outbox in one transaction; `release` is a token-fenced no-op unless that lease is still processing. The service is non-routable and non-live: it has no web/runtime/provider integration and cannot import or call the Aircall client.
- A PostgreSQL durable-store adapter and migration (`postgres-consent-decision-store.mjs`, `migrations/001-consent-decision-store.sql`) back the deployed audit-only lifecycle. The separate control store uses migration 002 and remains disabled unless its independent activation gates pass. Migration initialization is serialized with transaction-scoped PostgreSQL advisory locks and commits schema changes plus version rows atomically.

### PostgreSQL store API

`createPostgresConsentDecisionStore` requires `{ databaseUrl }`. The adapter exclusively owns the `pg` pool it creates: direct `client`, `query`, `pool`, facade, and other executor injection are unsupported and rejected. It acquires and releases one client via `pool.connect()` for every migration and finalization transaction. `finalize` keeps `BEGIN`, its fenced claim update, audit/outbox insert, and `COMMIT` (or `ROLLBACK`) on that acquired client; the static migration is sent as separate SQL statements inside its own advisory-lock-protected transaction rather than as a multi-statement query.

The source-of-truth policy for Sales Board business state and exact-phone association is documented in [docs/sales-board-business-state-policy.md](docs/sales-board-business-state-policy.md). The safe audit-only fixture is [policy/recording-controller.policy.json](policy/recording-controller.policy.json). Any future move beyond this fixture is governed by the non-executable [recording-control approval packet](docs/recording-control-approval-packet.md) and its empty [legal-review template](policy/legal-ruleset.review-template.json); neither artifact authorizes recording or is loaded by the runtime.

## Local verification

This baseline has no runtime dependencies. It requires **Node.js 20 or later**. With a supported Node.js release installed:

```sh
npm test
git diff --check
```

Do not add real credentials to this checkout. Local `.env*`, audit data, runtime data, and common key/certificate files are intentionally ignored.
