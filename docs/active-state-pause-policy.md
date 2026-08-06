# Timberline active state-pause policy

**Policy version:** `timberline-state-pause-2026-08-05.2`
**Recorded:** 2026-08-05T16:30:34Z
**Approvals recorded:** Jonathan McLemore and Dave Donovan; legal and operations approvals attested by the operator.

## Approved operating model

- Scope is the exact 26-pair runtime scope, fingerprinted in `policy/active-state-pause.policy.json`.
- Only authenticated, outbound `call.answered` events from an exact scoped pair may reach the unique Sales Board phone-to-State resolver.
- A known two-party State produces one `pause_recording` request.
- A known one-party State produces **no provider request**; recording remains governed by the provider’s default setting.
- Missing, malformed, noncanonical, ambiguous, unauthenticated, inbound, out-of-scope, or unknown-State events produce no provider request.
- Provider timeouts and HTTP failures are recorded as bounded redacted outcomes and are never automatically replayed.

## Provider-default deployment gate

This model requires `live_recording_activated: true` on every in-scope Aircall number before the pause-only controller can be restarted.

The historical 47-pair scope was reconciled through each approved user's current Aircall default-number assignment under Jon and Dave's approved replacement-scope decision. The resulting 26 exact current pairs are recorded in a root-only reconciliation artifact. All 26 current scoped numbers were updated and read back with `live_recording_activated: true` at 2026-08-05T17:00:00Z. The provider-default gate is satisfied for this policy version.

## Relationship to the audit-only policy

`policy/recording-controller.policy.json` stays disabled and audit-only because it is consumed by the separate audit receiver. The active pause-only controller consumes `policy/active-state-pause.policy.json`; the two lanes are intentionally separate.