# Timberline production handoff runbook — Dave-only Texas pilot

**Handoff owner:** Dave Donovan  
**Incident/alert contact:** Jon (`jon@plinkosolutions.com`)  
**Current status:** Checklist and runbook only; not proof of activation or test success  
**Consent procedure:** [Dave-only Texas pilot consent SOP](timberline-dave-consent-sop.md)

This runbook controls a single, conservative production pilot. It does not itself approve recording, configure email delivery, activate the runtime, or attest that a live test passed.

## 1. Frozen production scope

| Item | Required value |
|---|---|
| Canonical Sales Board | `7727339040` |
| State text column | `text_2` |
| Phone columns | `phone__1`, `dup__of_phone7__1`, `phone_mkrgdn4` |
| Consent dropdown | `dropdown_mm5v99w5`, single-select |
| Exact labels | `Verified — Permit Recording`; `Verified — Do Not Record` |
| Eligible State | `TX` only, with every remote party physically in Texas |
| Pilot Aircall user | `1980591` — Dave Donovan only |
| Pilot Aircall number | `1303588` — **Direct Line - Admin - Dave Donovan** |
| Live test destination | Supplied live; controlled test endpoint; never a customer |
| Pilot duration | One reconciled successful test, then a separately approved 24-hour monitored window |
| Audit access | Dave and Jon only |
| Retention | 30 days, then Dave/Jon review |

The controller can only request `resume_recording`; it is not a general record/pause manager. It fails closed on mismatched scope and uses at-most-once dispatch. State alone is never authorization; Dave's fresh call-specific consent record and exact Permit value are mandatory operational prerequisites.

## 2. Ownership and contact sheet

Complete before production access is granted.

| Function | Primary | Backup / rule | Confirmed at / evidence |
|---|---|---|---|
| Handoff and consent owner | Dave Donovan | No delegated Permit setter | _Pending_ |
| Incident and alert contact | Jon, `jon@plinkosolutions.com` | Loss of contact ends pilot | _Pending_ |
| Deployment operator | _Name_ | May deploy/disable; cannot set Permit | _Pending_ |
| Database operator | _Name_ | Least privilege; reconciliation changes require review | _Pending_ |
| Aircall administrator | _Name_ | Scope changes prohibited during pilot | _Pending_ |
| Monday administrator | _Name_ | Protect schema and Dave-only Permit mutation | _Pending_ |
| Legal/privacy approval reference | _Reference_ | Must cover the exact pilot | _Pending_ |

Alerts must reach Jon, but **this repository does not establish that email transport is configured**. The deployment owner must identify the external alerting service, configure `jon@plinkosolutions.com`, send a test alert, receive Jon's acknowledgement, and attach timestamped evidence before activation. Never treat a log line or this address in a document as delivery proof.

## 3. Release and approval artifacts

Before go-live, pin and record:

- immutable source revision and build artifact digest;
- Node.js version (20 or later) and dependency lock/build evidence;
- database migration status through `migrations/002-recording-action-store.sql`;
- policy version `timberline-recording-control-2026-08-02.2` and its runtime-computed policy hash;
- exact pilot hash for only user `1980591` and number `1303588`;
- deployment ID;
- consent column `dropdown_mm5v99w5`;
- approval reference and approver-reference hash;
- activation expiry covering no more than the approved test/pilot window;
- signed Ed25519 activation artifact and offline verification evidence; and
- legal, privacy/security, operations, and Dave approvals for this exact TX-only scope.

The online host receives only the Ed25519 public key. The signing private key remains offline in a root-owned `0600` regular file and must not be copied to the runtime, secret manager entry used by the runtime, ticket, or logs. Follow [automatic recording control operations](automatic-recording-control.md) for key generation and artifact verification.

## 4. Production prerequisites

### Infrastructure and isolation

- [ ] Dedicated production database/role; TLS and backups verified; no test data or test credentials.
- [ ] Migrations completed under change control; default control row is disabled.
- [ ] Runtime bound to `127.0.0.1` only. A managed TLS ingress/reverse proxy exposes only the required webhook path.
- [ ] Ingress restricts method/path/content type/body size, preserves the raw JSON body, and does not log tokens or bodies.
- [ ] Egress is restricted to required Monday, Aircall, database, secret manager, and alert endpoints.
- [ ] Audit and recording access is restricted to Dave/Jon; access test and denial test are evidenced.
- [ ] Host/service account is least privilege; secret files are not world/group readable; core dumps and verbose request logging are disabled.
- [ ] Clock synchronization, log timestamps in UTC, disk capacity, backup restore procedure, and service restart policy are verified.
- [ ] Separate live audit-only receiver remains logically and operationally distinct from control ingress.

### Monday schema and workflow

- [ ] Board is exactly `7727339040`.
- [ ] `text_2` is a text column; all three canonical phone columns are phone columns.
- [ ] `dropdown_mm5v99w5` is a single-select dropdown with exact byte-for-byte labels `Verified — Permit Recording` and `Verified — Do Not Record`.
- [ ] Dave alone can set Permit. Other users cannot set Permit through UI, automations, API tokens, integrations, templates, defaults, imports, or bulk edits.
- [ ] No automation pre-populates or preserves Permit between calls.
- [ ] An auditable place exists in the call/customer record for Dave's timestamp, source, and basis.
- [ ] Schema-change protection and a change alert to Jon are active.
- [ ] Duplicate/no-match phone cases have been tested to deny.

### Aircall and webhook

- [ ] Aircall user `1980591` is Dave Donovan and is the sole configured pilot user.
- [ ] Number `1303588` is named **Direct Line - Admin - Dave Donovan** and is the sole configured pilot number.
- [ ] Account-level/default recording posture is understood and compatible with the controller's resume-only behavior; no other automation can start recording unexpectedly.
- [ ] `call.answered` webhook sends the documented direct call object at root `payload.data`, includes the expected token, and routes only to `/aircall/recording/control-events`.
- [ ] Webhook retries/duplicates have been exercised with synthetic payloads and shown not to duplicate provider action.
- [ ] Invalid token, malformed body, oversized body, alternate wrapper shape, wrong user, and wrong number all fail closed.
- [ ] Webhook secret can be rotated without accepting both an uncontrolled old and new stream or creating unsafe duplicate behavior.

### Monitoring and response

- [ ] Dashboards/queries in section 9 work against production without exposing phone numbers, call IDs, tokens, payloads, or consent narrative.
- [ ] Alerts are configured for readiness loss, actions unexpectedly enabled/disabled, schema failure, worker failure, provider errors/timeouts, any `dispatching`/`outcome_unknown`, unknown key IDs, authentication failures/spikes, and scope-denial anomalies.
- [ ] A test alert has been delivered to and acknowledged by Jon at `jon@plinkosolutions.com`; evidence is attached.
- [ ] Dave and Jon can invoke the kill switch without the deployment pipeline or an approval artifact.
- [ ] On-call coverage exists for the controlled test and full 24-hour window.

## 5. Credential inventory and rotation

Store each value separately in the approved production secret manager. Do not put real values in this repository or shell history.

| Secret/configuration | Runtime name | Rotation rule |
|---|---|---|
| Control database URL | `AIRCALL_CONTROL_DATABASE_URL` | Rotate DB password/role; validate disabled readiness before reactivation |
| Monday API token | `MONDAY_API_TOKEN` | Read/minimum required scope; revoke old after lookup/schema checks pass |
| Webhook authentication token | `AIRCALL_CONTROL_WEBHOOK_TOKEN` | Coordinated provider/ingress cutover; account for dedupe-key change; disable during uncertain overlap |
| Durable idempotency HMAC key | `RECORDING_IDEMPOTENCY_HMAC_KEY` | Independent high-entropy secret; rotation requires reviewed dedupe/cutover plan |
| Pseudonymization HMAC key | `RECORDING_PSEUDONYM_HMAC_KEY` | Independent high-entropy secret; preserve only as required for audit continuity |
| Active capability key | `RECORDING_CAPABILITY_ACTIVE_KEY` | Canonical base64, exactly 32 bytes; rotate with key ID and previous-key overlap |
| Capability key ID | `RECORDING_CAPABILITY_ACTIVE_KEY_ID` | New unique ID for each new capability key |
| Previous capability keys | `RECORDING_CAPABILITY_PREVIOUS_KEYS` | `id:BASE64` list; keep until unknown-key count is zero, then remove under change control |
| Aircall API ID/key | `AIRCALL_API_ID`, `AIRCALL_API_KEY` | Minimum control scope; rotate together per provider procedure |
| Approval public key | `RECORDING_APPROVAL_PUBLIC_KEY` | Public SPKI DER base64; rotation requires new offline authority and new exact-scope artifact |

The webhook, idempotency, pseudonymization, and capability secrets must be independent; literal representations and decoded material must not be reused. After any suspected exposure: disable first, revoke/rotate the affected provider and local credentials, rotate dependent HMAC/capability material as applicable, issue a new deployment ID and activation artifact, verify no unknown key IDs or unresolved actions, and only then consider reactivation. Never print a secret to prove rotation.

## 6. Staged deployment and webhook acceptance

1. Deploy with control disabled. Keep `RECORDING_CONTROL_MODE=DISABLED`; do not set provider/worker authority.
2. Supply all required production dependencies and separate secrets so schema/database readiness can be checked, but keep the database kill switch false.
3. Start `node recording-control-runtime.mjs` under the managed service account.
4. Through the local/admin health path, confirm `/health` identifies recording-control in disabled mode and `/ready` reports `staged` with healthy DB/schema, `actionsEnabled=false`, `workerAuthority=false`, and `providerAuthority=false`.
5. Configure the TLS ingress and Aircall `call.answered` webhook using the production token. Do not expose the loopback listener directly.
6. Send only approved synthetic webhook cases while disabled. Confirm authentication, direct `payload.data` contract, bounded body handling, unique exact-phone lookup, and denial outcomes. Confirm no provider call and no recording.
7. Confirm raw payload/token/phone/call identifiers did not enter application, proxy, alert, or tracing logs.
8. Run the complete deny portion of the acceptance matrix. Any discrepancy blocks activation.

## 7. Activation procedure

Activation is a two-person change: deployment/database operator executes; Dave verifies scope and gives go/no-go. Jon must be reachable.

1. Announce the change window and freeze Monday/Aircall schema and integration changes.
2. Confirm the consent field is blank for the temporary test item and there are no customer items left at Permit from preparation.
3. Re-run tests against the pinned release (`npm test`) and whitespace validation (`git diff --check`) in the release pipeline. Tests do not replace production checks.
4. Verify the exact activation scope offline: deployment ID, policy hash, pilot hash for only `1980591`/`1303588`, consent column, approver-reference hash, and expiry.
5. Set the exact production scope:

   ```text
   RECORDING_CONTROL_MODE=CONTROL_ENABLED
   CONTROL_ENABLED=true
   RECORDING_CONTROL_POLICY_VERSION=timberline-recording-control-2026-08-02.2
   RECORDING_PILOT_USER_IDS=1980591
   RECORDING_PILOT_NUMBER_IDS=1303588
   MONDAY_RECORDING_CONSENT_COLUMN_ID=dropdown_mm5v99w5
   ```

   Set the deployment ID, public key, database/Monday/Aircall credentials, four independent recording secrets, capability key ID/keyring, and loopback port from the secret/config manager. Do not paste values into the change record.
6. Restart while the database action control remains false. Confirm `/ready` reports `ready_for_activation`, not `actively_controlling`; `actionsEnabled=false` and no worker/provider authority must remain visible.
7. Reconfirm schema, activation expiry, zero unknown capability-key IDs, and zero unresolved `dispatching`/`outcome_unknown` rows.
8. Using the approved administrative invocation of the store API, call `activateWithAttestation(approval, metadata)` with the verified artifact and recorded change correlation. There is intentionally no ordinary `setActionsEnabled(true)` path. The production deployment procedure must name and peer-review the actual administrative wrapper before this step; do not invent an ad hoc console command during the window.
9. Restart/initialize authority if required by the service manager. Confirm `/ready` becomes `actively_controlling` and shows: DB/schema healthy, exact activation match, actions enabled, worker healthy, provider and worker authority present, reconciliation count zero, and unknown key count zero.
10. If any check differs, invoke the kill switch immediately and execute rollback. Do not troubleshoot while enabled.
11. Dave performs the single live test from the SOP using the destination supplied live at execution time. The destination must never be a customer.
12. Reconcile the test. One success is required before the 24-hour pilot may begin. Reset the test item's consent to blank and remove/sanitize the temporary item.
13. Dave and Jon record an explicit test result and a separate go/no-go for the 24-hour window. If go, record start/end UTC. If no-go, disable.

## 8. Kill switch, rollback, and safe stop

### Immediate kill switch

Dave, Jon, or the authorized operator may disable without approval. In an emergency, do not wait for diagnosis:

1. Call `store.setActionsEnabled(false, {reasonCode:'emergency_disable', correlation:'<approved-redacted-correlation>'})` through the pre-approved administrative wrapper.
2. Confirm the database control row is false and `control_epoch` increased.
3. Stop the worker/control service and remove provider authority. Keep webhook ingress disabled or routed to a safe deny response while preserving only minimal metadata.
4. Confirm readiness is no longer `actively_controlling` and no new provider actions are dispatched.
5. Notify Dave and Jon through the tested incident path. Email is supplementary if delivery is uncertain.
6. Inspect `dispatching` and `outcome_unknown`; do not replay or reset them.

A disable that commits before dispatch prevents it. If disable waits behind a dispatch fence, one provider request may already be in flight; classify and reconcile it rather than claiming the switch retroactively prevented it.

### Planned rollback

1. Prevent new calls/test actions; ask Dave to set relevant temporary Permit values to blank or `Verified — Do Not Record` as appropriate.
2. Use `maintenance_disable` through the approved administrative wrapper.
3. Confirm false control state and incremented epoch; stop worker/provider authority.
4. Revert service configuration to `RECORDING_CONTROL_MODE=DISABLED` and remove `CONTROL_ENABLED=true`, pilot lists, and provider credentials from runtime authority (retain secrets only in the secret manager as policy requires).
5. Roll back application release only after disabling. Do not reverse migration 002 or delete audit/outbox rows as a routine rollback.
6. Reconcile unresolved rows and provider evidence; preserve the incident/change record.
7. Verify `staged` readiness: DB/schema healthy, actions false, no worker/provider authority.
8. Rotate/revoke credentials if rollback involved exposure or unintended access.

Reactivation always requires fresh readiness, exact-scope unexpired attestation, acceptance checks, and Dave go/no-go. A previous true state or artifact must not be inherited.

## 9. Monitoring during test and 24-hour window

The deployment owner watches continuously during the live test, then maintains staffed alerts for the 24-hour window. At minimum check at activation, immediately before/after the test, every 15 minutes for the first hour, hourly thereafter, on every alert, and at pilot close.

Use redacted operational queries:

```sql
SELECT status, count(*)
FROM recording_action_outbox
GROUP BY status;

SELECT action_key_hash, status, updated_at, failure_code
FROM recording_action_outbox
WHERE status IN ('dispatching', 'outcome_unknown')
ORDER BY updated_at;

SELECT key_id, count(*)
FROM recording_action_capabilities
GROUP BY key_id;

SELECT actions_enabled, control_epoch, changed_at
FROM recording_action_control;
```

Also record:

- `/ready` state and freshness (booleans/counts only);
- worker heartbeat/consecutive failures/last outcome;
- webhook accepted/denied counts by redacted reason;
- provider success/error/timeout counts;
- Monday schema/lookup health and drift;
- Aircall/Monday scope changes;
- alert-delivery health; and
- Dave's expected call count versus reconciled provider outcomes.

**Immediate disable thresholds:** any unexpected recording; wrong user/number/state; consent complaint or withdrawal uncertainty; any unresolved `dispatching`/`outcome_unknown`; schema drift; unknown capability key; activation mismatch/expiry; worker/readiness failure; inability to query provider evidence; alert transport failure; unauthorized audit access; secret exposure; or unexplained count mismatch.

## 10. `dispatching` and `outcome_unknown` reconciliation

These states are intentionally never automatically retried. A crash after prepare can remain `dispatching`; a provider timeout/error after the fenced request becomes `outcome_unknown`. Never reset either to `pending`, requeue it, delete it, or place a second call to “see what happens.”

1. Disable immediately and suspend the pilot.
2. Capture UTC times, action-key hash, status, failure code, control epoch, readiness, and deployment/approval references. Do not copy raw payload, secret, phone, or call ID into general logs.
3. With Dave/Jon-only access, correlate the redacted action to the approved call record and inspect Aircall call/recording/audit evidence.
4. Determine one of: provider action definitely succeeded; definitely did not occur; or remains indeterminate.
5. If provider action succeeded, confirm recording scope/consent and handle the recording per retention/incident rules. If it should not have succeeded, treat as a consent incident.
6. If definitely absent, document that conclusion. Do not replay; a new call requires a fresh record, fresh consent, new event, and go/no-go.
7. If indeterminate, treat recording as potentially present, request provider support evidence, restrict access, and keep the pilot disabled.
8. Record reviewer names, sources checked, UTC conclusion, provider ticket/reference, recording disposition, and any incident link in a separately reviewed reconciliation record.
9. Use only the approved manual reconciliation procedure to mark the operational case resolved. Readiness must show reconciliation count zero before any reactivation.

## 11. Incident response

### Severity

- **Sev 1:** recording without verified consent; non-TX/interstate/unknown-location recording; wrong user/number/customer test destination; unauthorized disclosure/access; credible secret compromise.
- **Sev 2:** unexpected/missing recording, consent withdrawal uncertainty, `dispatching`/`outcome_unknown`, schema drift, activation/scope mismatch, monitoring/alert failure.
- **Sev 3:** denied malformed traffic, transient dependency issue with confirmed no dispatch, documentation defect.

### Response

1. **Stop:** invoke emergency disable and stop worker/provider authority for Sev 1/2.
2. **Protect people:** Dave ends or continues the conversation unrecorded only if the provider state is known safe; honor withdrawal and complaints without debate.
3. **Notify:** contact Jon and Dave through the tested path; do not rely on unverified email delivery. Escalate to legal/privacy/security for Sev 1 or personal-data exposure.
4. **Contain:** restrict recording/audit access to Dave/Jon, revoke exposed links/tokens, freeze deletion when a hold is required, and prevent further webhook dispatch.
5. **Preserve minimum evidence:** UTC timeline, hashes/correlations, control epochs, provider references, access logs, consent record, decisions, and configuration versions. Never collect secrets or broad raw payloads as evidence.
6. **Reconcile:** follow section 10 for ambiguous outcomes and determine recording existence/disposition.
7. **Remediate:** correct scope/schema/integration, rotate credentials if implicated, and validate deny cases while disabled.
8. **Review:** document root cause, affected calls/parties, notifications, deletion/hold, owner, and corrective actions. Reactivation requires explicit Dave/Jon go/no-go plus all original gates.

## 12. Acceptance matrix

Execute synthetic/disabled cases first. The sole live positive case uses the live-provided controlled destination and current consent. “No action” means no outbox provider dispatch and no Aircall recording created by this controller.

| Case | Inputs / condition | Expected result | Required evidence |
|---|---|---|---|
| Valid live test | Dave `1980591`; number `1303588`; unique exact test phone; `TX`; all parties currently in TX; fresh documented consent; exact Permit | Exactly one resume request; recording confirmed and reconciled; no duplicate | Call record, redacted action hash, Aircall evidence, monitor snapshot, Dave/Jon result |
| Blank consent | All scope valid, consent blank | Deny; no action | Denial reason/count and provider absence |
| Explicit denial | Exact `Verified — Do Not Record` | Deny; no action | Denial evidence |
| Similar/malformed label | Typographic variant, whitespace, multiple select, or unknown label | Schema/decision denial; no action | Schema/readiness or denial evidence |
| State alone | `text_2 = TX`, no fresh consent evidence | Deny; no action | Call record remains non-Permit |
| Non-TX State | Any value other than exact `TX` | Deny; no action | Denial evidence |
| Location unknown/conflict | Business State TX but remote location unknown, interstate, or parties conflict | Dave must not set Permit; no action | SOP entry/denial evidence |
| Wrong user | User other than `1980591` | Deny; no action | Redacted scope denial |
| Wrong number | Number other than `1303588` | Deny; no action | Redacted scope denial |
| No phone match | No exact canonical phone match | Deny; no action | Lookup denial |
| Duplicate phone match | More than one canonical item | Deny; no action | Ambiguity denial |
| Wrong board/column | Foreign board, missing/type-changed canonical column | Schema/lookup denial; not ready | Readiness evidence |
| Invalid webhook | Wrong token, body, content type, shape, path, or oversized body | Reject; no lookup/provider action; no secret leakage | Ingress/app metrics |
| Duplicate webhook | Same authenticated answered event delivered repeatedly | At most one action | One action hash/provider request |
| Kill switch false | Valid-looking call while DB actions disabled | Deny; no action | Control row/epoch and provider absence |
| Activation mismatch/expiry | Wrong scope/hash or expired artifact | No worker/provider authority; no action | Readiness/activation check |
| Consent revoked before dispatch | Permit changed to denial/blank before worker revalidation | Canceled; no provider request | Outbox status and provider absence |
| Provider timeout/error | Fenced provider outcome unavailable | One `outcome_unknown`; never retried; immediate disable | Query, alert, reconciliation record |
| Crash after prepare | `dispatching` remains unresolved | Never reclaimed/retried; immediate disable | Query and reconciliation record |
| Alert test | Trigger non-sensitive test alert | Jon receives and acknowledges | Alert ID, UTC delivery/ack |
| Access denial | Non-Dave/Jon user requests audit/recording | Access denied and logged | IAM/access test |
| Consent reset | Test/call completed | Field blank or Do Not Record as appropriate | Monday audit evidence |

**Live-test pass criteria:** every positive-case gate passed; exactly one provider action and recording are confirmed; no duplicate/unexpected recording; consent reset; temporary test item removed/sanitized; all denial tests remain clean; reconciliation count is zero; alerts and monitoring stayed healthy. Anything less is a failed test and triggers rollback. This document does not state that the test has been run.

## 13. Pilot close and 30-day disposition

At the 24-hour end time:

1. Disable, stop worker/provider authority, and confirm staged readiness.
2. Ensure all Permit values from pilot handling are blank or correctly set to Do Not Record.
3. Reconcile every expected call and require zero unresolved statuses.
4. Export only the minimum Dave/Jon-accessible close report: counts, redacted correlations, consent compliance, incidents, access events, and deviations.
5. Revoke unnecessary temporary access and test configuration.
6. Schedule the 30-day Dave/Jon review for recordings and pilot audit artifacts.
7. At day 30, delete by default unless a documented approved extension or legal hold applies. Record deletion confirmation or hold authority/scope/next review date.
8. Record a final decision: stop, revise and reapprove, or propose a new stage. Do not leave the runtime active pending a decision.

## 14. Handoff signoff

All blanks must be completed with durable references; signatures are not implied by names printed in this file.

| Acceptance | Name | UTC date/time | Evidence/reference | Decision/signature |
|---|---|---|---|---|
| Exact legal/privacy/operations pilot approval | _Pending_ | _Pending_ | _Pending_ | _Pending_ |
| Release/build/migration verified | _Pending_ | _Pending_ | _Pending_ | _Pending_ |
| Monday Dave-only workflow verified | Dave Donovan | _Pending_ | _Pending_ | _Pending_ |
| Aircall user/number/webhook verified | _Pending_ | _Pending_ | _Pending_ | _Pending_ |
| Secrets/IAM/rotation/backup verified | _Pending_ | _Pending_ | _Pending_ | _Pending_ |
| Monitoring and Jon alert delivery proven | Jon | _Pending_ | _Pending_ | _Pending_ |
| Kill switch and rollback rehearsal passed | Dave + operator | _Pending_ | _Pending_ | _Pending_ |
| Deny acceptance matrix passed | _Pending_ | _Pending_ | _Pending_ | _Pending_ |
| Single live test reconciled successful | Dave + Jon | _Not run_ | _Pending_ | _Pending_ |
| 24-hour pilot go/no-go | Dave + Jon | _Pending_ | _Pending_ | _Pending_ |
| 24-hour pilot closure | Dave + Jon | _Pending_ | _Pending_ | _Pending_ |
| 30-day retention review/disposition | Dave + Jon | _Pending_ | _Pending_ | _Pending_ |

**Final handoff state (choose one):** `NOT READY` / `READY FOR CONTROLLED TEST` / `24-HOUR PILOT ACTIVE` / `DISABLED AND CLOSED`  
**Recorded state:** `NOT READY` until the table is completed and independently evidenced.