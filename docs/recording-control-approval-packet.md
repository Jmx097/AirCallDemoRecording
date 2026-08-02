# Recording-Control Approval Packet

**Status:** `NOT_APPROVED`

**Current operational mode:** `AUDIT_ONLY`
**Recording action status:** disabled

This packet is the governance handoff for any proposal to move the Timberline Aircall/Monday recording lane beyond audit-only classification. It is **not legal advice**, a provider configuration guide, or authorization to record.

## Fixed safety baseline

The live receiver must remain audit-only unless a separate, explicit production-change approval is completed. Today it:

- accepts only authenticated audit events;
- resolves an exact, unique Sales Board record by querying all three configured phone columns with bounded, read-only Monday lookups;
- reads business-address `State` from Sales Board text column `text_2`; no recording-consent field or value is configured in the audit runtime;
- leaves the outcome disabled for every missing, denied, malformed, ambiguous, stale, or dependency-failed input;
- does not import or call an Aircall recording-control client.

`State` is supporting jurisdiction evidence only. It does not substitute for human consent or a legally reviewed ruleset.

## Required approval record

No jurisdiction may be added to a production ruleset until all four named reviews have been recorded against the same immutable ruleset version:

| Review | Required owner | Evidence to attach | Required result |
|---|---|---|---|
| Legal counsel | Licensed counsel designated by Timberline | Per-jurisdiction memorandum/reference, effective date, review date, expiry/review date, and relevant conditions | Explicit approved / not-approved conclusion; no inference from generalized state lists |
| Privacy & security | Privacy/security owner | Threat assessment, secret/retention/access-control review, logging/redaction decision | Explicit approval of the operating controls |
| Operations | Process owner | Rep training/attestation, controlled-field workflow, exception/escalation process, monitoring owner | Confirmation that State remains human-owned and any future consent control is separately designed and approved |
| Executive | Dave Donovan | Written approval referencing the exact ruleset version and change request | Explicit limited authorization to proceed to the next gated stage |

The review packet must name the scope: business type, call participants/locations, customer population, provider configuration, recording purpose, retention, and any jurisdiction-specific preconditions. A single broad approval is not a substitute for this scope.

## Jurisdiction evidence requirements

For each proposed jurisdiction entry, attach:

1. Canonical code/value read from the Sales Board `State` text column.
2. Counsel-reviewed legal authority and date checked.
3. Exact eligibility conditions and exclusions; include how cross-jurisdiction or uncertain participant location is handled.
4. Ruleset effective date and mandatory expiry/review date.
5. Owner responsible for withdrawal or emergency disablement.
6. A synthetic test scenario that proves the state is only an **audit classification** until the separately approved control stage.

Unknown, expired, incomplete, conflicting, or unreviewed evidence must be represented as **not eligible**.

## Controlled artifacts

- Baseline runtime policy: [`policy/recording-controller.policy.json`](../policy/recording-controller.policy.json). It must remain `DISABLED`, `AUDIT_ONLY`, `recordingActionsPermitted: false`, and `legalRuleset: null` pending approval.
- Legal-review overview template: [`policy/legal-ruleset.review-template.json`](../policy/legal-ruleset.review-template.json). It is intentionally non-executable, empty, and `NOT_APPROVED`.
- Schema-aligned review-record template: [`policy/legal-review-record.template.json`](../policy/legal-review-record.template.json). It is intentionally incomplete and `NOT_APPROVED`; it is rejected by the structural validator until every required evidence field **and approval gate** is complete.
- State evidence policy: [`docs/sales-board-business-state-policy.md`](sales-board-business-state-policy.md).

Do **not** insert a reviewed ruleset into the live runtime merely by changing JSON. A future implementation must introduce a separate, reviewed promotion path that validates: immutable version, all required approval references, current non-expired review, and an explicit production-change approval.

## Future gated sequence (not authorized by this packet)

1. Legal, privacy/security, operations, and Dave complete the review record for a bounded scope.
2. Engineering designs a ruleset loader that rejects templates, missing approvers, expired reviews, unknown schema versions, and any ruleset lacking a matching explicit approval reference.
3. Engineering may use the pure `legal-ruleset-review.mjs` helper only to reject malformed records before any future loader is designed. It validates schema structure and dates, **not** counsel identity, legal correctness, source integrity, or authorization; it is not imported by the audit runtime.
4. Add tests for approved, expired, revoked, malformed, cross-jurisdiction, missing future consent controls, and multiple-match cases. Retain audit-only behavior.
5. Conduct synthetic live audit acceptance using temporary fictitious Sales Board records; verify only redacted outcome/reason fields and delete the records.
6. Dave gives a separate decision on whether to begin a recording-control design review. This is not a request to enable control.
7. Before any live provider action: complete provider-control review, webhook/inbound authenticity review, rollback/kill-switch validation, monitoring/on-call ownership, and a separate go/no-go approval.

## Decision record

| Field | Value |
|---|---|
| Proposed ruleset version | _Not assigned_ |
| Scope | _Not approved_ |
| Legal counsel approval | _Not approved_ |
| Privacy/security approval | _Not approved_ |
| Operations approval | _Not approved_ |
| Dave Donovan approval | _Not approved_ |
| Runtime status | `AUDIT_ONLY`; recording disabled |
| Next permitted action | Collect review evidence; no provider-control implementation |
