# Timberline Dave-only Texas pilot consent SOP

**Document owner and handoff owner:** Dave Donovan  
**Pilot status:** Not activated by this document  
**Scope:** Texas-only, Dave-only, one-number recording-control pilot  
**Related runbook:** [Timberline production handoff](timberline-production-handoff.md)

This SOP is an operational control, not legal advice and not standing authorization to record. Recording remains denied unless every gate below is satisfied for the specific call. An approval, deployment, or successful prior call does not waive any per-call gate.

## 1. Fixed pilot scope

| Control | Exact scope |
|---|---|
| Sole pilot operator | Dave Donovan |
| Aircall user | `1980591` (Dave Donovan) |
| Aircall number | `1303588` — **Direct Line - Admin - Dave Donovan** |
| Eligible jurisdiction | Texas (`TX`) only |
| Canonical Monday board | Sales Board `7727339040` |
| Business State field | `text_2` |
| Canonical phone fields | `phone__1`, `dup__of_phone7__1`, `phone_mkrgdn4` |
| Consent control | Single-select dropdown `dropdown_mm5v99w5` |
| Exact permit label | `Verified — Permit Recording` |
| Exact denial label | `Verified — Do Not Record` |
| Audit access | Dave Donovan and Jon only |
| Alert recipient | Jon — `jon@plinkosolutions.com` |
| Retention | 30 days, then Dave/Jon review |

No other user, number, board, State field, phone field, consent label, or jurisdiction is in scope. Do not broaden a comma-separated allowlist, add aliases, or treat similar-looking labels as equivalent.

## 2. Non-negotiable deny rules

Leave recording disabled or select `Verified — Do Not Record` whenever any of the following is true:

- `State` is blank, malformed, uncertain, stale, disputed, or not exactly Texas.
- The customer's or any remote party's physical location at the time of the call is unknown.
- Any party is outside Texas, the call is interstate, or the parties give conflicting location information.
- Consent is blank, conditional, withdrawn, ambiguous, inferred, supplied by someone other than Dave, or not reverified for this call.
- The record cannot be resolved uniquely by exact normalized phone evidence in the three canonical phone columns.
- The incoming call is not handled by Aircall user `1980591` through number `1303588`.
- Dave cannot document the timestamp, source, and basis before selecting Permit.
- The schema, webhook, runtime, provider, database, activation, key, worker, monitoring, or alerting status is uncertain or unhealthy.
- An incident, complaint, revocation, kill-switch action, or unresolved `dispatching`/`outcome_unknown` record exists.

**State alone never authorizes recording.** `text_2 = TX` is supporting business-address evidence only. Area code, caller ID, a prior conversation, a prior Permit value, customer research, or an Aircall contact address is not proof of current location or current consent.

## 3. Roles and access

### Dave Donovan

Dave is the only person permitted to:

- obtain and verify call-specific consent;
- set `dropdown_mm5v99w5` to `Verified — Permit Recording`;
- conduct the single controlled live test;
- operate within the 24-hour pilot window;
- request normal activation or handoff acceptance;
- reset the consent field after a test or call; and
- approve routine pilot disposition at the 30-day review.

Dave may always deny recording or stop the call/test. Dave may not delegate Permit authority during this pilot.

### Jon

Jon is the alert and incident contact and may view pilot audit evidence. Jon may invoke or direct the emergency kill switch, preserve evidence, coordinate incident response, and participate in the 30-day review. Jon must not set Permit.

### Engineering/operator

Engineering may deploy, monitor, disable, rotate credentials, and reconcile technical outcomes. Engineering must not infer consent, set Permit for Dave, enable broader scope, or replay ambiguous provider actions.

Access to consent evidence, pilot audit records, provider call evidence, and recordings is restricted to Dave and Jon. Infrastructure staff may have the minimum system access required to operate the service, but must not use that access to review call content unless Jon authorizes incident handling and the access is logged.

## 4. Per-call consent procedure

Dave must complete these steps for **every** test or pilot call unless a later, explicit, written legal/operations approval changes the re-verification requirement. Until then, prior consent expires for operational purposes at the end of each call.

### A. Confirm the record and scope

1. Open the unique item on Sales Board `7727339040`.
2. Confirm the dialed/received phone exactly matches the item in at least one canonical phone field: `phone__1`, `dup__of_phone7__1`, or `phone_mkrgdn4`.
3. Confirm the business State in `text_2` is exactly `TX`.
4. Confirm Dave is using Aircall user `1980591` and **Direct Line - Admin - Dave Donovan**, number ID `1303588`.
5. Ask and confirm where every remote party is physically located for this call. Every party must be in Texas. If another party joins, repeat the location and consent checks before proceeding; otherwise do not record.

### B. Obtain current consent

1. Before permitting recording, clearly tell every remote party that the call will be recorded and state the recording purpose.
2. Ask for an unambiguous affirmative response from every remote party.
3. If a party declines, hesitates, conditions consent, cannot answer, withdraws consent, or location remains uncertain, do not permit recording. Set `Verified — Do Not Record` if an explicit denial should be preserved; otherwise leave the field blank.
4. If consent changes after recording begins, end the call immediately and invoke the kill switch. The controller has no pause/stop action, so do not rely on it to stop an active recording. Use a separately verified Aircall UI/administrative stop control only if the approved incident procedure identifies one, then follow incident response in the handoff runbook. Do not continue on an assumption that the earlier consent remains valid.

### C. Create the evidence before Permit

Before selecting Permit, Dave must create an auditable entry in the call/customer record containing:

- UTC timestamp of verification;
- Dave Donovan as verifier;
- source of consent (for example, verbal consent on the current call);
- basis: all remote parties identified, each party's current physical location confirmed as Texas, disclosure made, purpose stated, and each party's affirmative response;
- the specific call/test reference and destination;
- any restrictions stated by a party; and
- intended one-call validity.

Do not put secrets, tokens, full webhook payloads, or unnecessary sensitive content in the entry. If the approved call record has no auditable place to store these fields, deny recording and escalate; do not improvise an untracked note.

### D. Set the control

Only after A–C pass, Dave may set `dropdown_mm5v99w5` to the exact value `Verified — Permit Recording`. Visually re-open the item and confirm the value, unique phone, and State immediately before the call is answered/controlled.

Any blank, other label, duplicate record, conflicting field, or failed refresh is a denial. Never pre-populate Permit for a future call or a batch of contacts.

### E. Close the call

1. Note whether recording was expected and whether Aircall shows it occurred; do not assume a provider timeout means no action occurred.
2. Immediately reset `dropdown_mm5v99w5` to blank after the one-off live test. For pilot calls, reset it to blank after the call unless retaining `Verified — Do Not Record` is appropriate to preserve a denial.
3. If consent was denied or withdrawn, use `Verified — Do Not Record` where appropriate and add a concise audit entry.
4. Report any unexpected recording, missing expected recording, complaint, field mutation, wrong user/number, or uncertain provider result to Jon and follow the incident procedure.

## 5. Single controlled live test

The test destination will be supplied live at execution time. It must be controlled by the test participant and **must never be a customer or customer number**. Do not write the destination into this repository, a command history, a ticket visible beyond Dave/Jon, or reusable configuration.

Preconditions:

- all production-handoff preflight and activation checks are signed;
- Dave and Jon are present or immediately reachable;
- alert transport to `jon@plinkosolutions.com` has been configured and proven with a test alert;
- the kill switch has been rehearsed while disabled;
- there are zero unresolved `dispatching` or `outcome_unknown` rows;
- Dave creates a temporary, clearly identified non-customer Sales Board test item with exact test phone, `text_2 = TX`, and blank consent;
- the test participant confirms current physical presence in Texas and gives current affirmative consent; and
- Dave records the required evidence, then sets Permit.

Place one call only, using user `1980591`, number `1303588`, and the live-provided test destination. Success requires the acceptance evidence defined in the handoff runbook; an HTTP success or queued action alone is not sufficient. Whether the test succeeds or fails, reset consent to blank, delete or sanitize the temporary test record according to approved test-data handling, and reconcile the action before another attempt. A second live attempt requires a fresh go/no-go decision and fresh per-call consent.

**No live test is represented as completed by this SOP.** Record actual date, call reference, evidence, and result only after execution.

## 6. 24-hour monitored pilot

The 24-hour window starts only after one controlled live test has been reconciled as successful and Dave and Jon record a go decision. During the window:

- only Dave/user `1980591` and number `1303588` are eligible;
- only all-Texas calls with fresh, documented, per-call consent may be permitted;
- Dave follows this SOP for every call;
- monitoring and alerting remain staffed as specified in the handoff runbook;
- any Sev-1/Sev-2 condition, scope breach, consent complaint, unresolved provider result, loss of monitoring, or loss of alert transport ends the pilot and triggers disablement; and
- the service is disabled at the end of 24 hours unless a new explicit approval authorizes a next stage.

A quiet 24-hour period does not authorize expansion or permanent operation.

## 7. Records and retention

Keep only the minimum evidence needed to show the consent decision, technical action, reconciliation, incident handling, and signoff. Pilot recordings and pilot audit artifacts are retained for **30 days**, then Dave and Jon jointly review them for deletion or an explicitly documented extension/legal hold. Default disposition after review is deletion. Record the review date, participants, disposition, deletion confirmation, and any hold authority.

Do not use operational logs as a substitute for the call-record consent entry. Do not grant access beyond Dave/Jon, export recordings for convenience, or retain raw webhook payloads/secrets as audit evidence.

## 8. Deviations

There are no verbal exceptions. A proposed exception—different user, number, state, consent label, consent cadence, destination type, access list, duration, or retention—requires the pilot to remain disabled while legal, privacy/security, operations, and Dave approve a revised, versioned scope and activation artifact.