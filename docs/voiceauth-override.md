# VoiceAuth recording-retention override — inactive

## Current policy

As of the simplified delayed-retention decision, Aircall `#VoiceAuth` tags have **no effect** on two-party post-asset retention. Every durable two-party action follows the same delayed sequence:

```text
asset received → delete request → recording-object reconciliation (404) → fresh worker lease → exact Monday link clear/read-back
```

The VoiceAuth receiver service is disabled and the matching `call.tagged` Aircall subscription is inactive. Its protected configuration remains stored only for rollback/audit purposes and is not read by the active retention worker.

## Boundary

- No tag can suppress provider deletion or the exact `link_mm4n5qp` clear/read-back.
- The normal authenticated `call.comm_assets_generated` retention subscription remains active.
- Historic VoiceAuth evidence is retained in the protected database for audit; it does not alter any new or pending retention action.

Reintroducing a tag exception requires a new explicit governance decision, implementation review, test, provider-subscription activation, and a fresh internal acceptance call.
