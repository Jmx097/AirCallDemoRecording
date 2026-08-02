# Sales Board Business-State Policy

## Canonical audit model

For the recording audit-only resolver, the **Sales Board (`7727339040`) is the canonical board**. `State` means the customer company's business-address State and is read from the Sales Board `State` text column (`text_2`). Resolver provenance identifies it as `sales_board_business_state`.

Audit association is based only on an exact normalized 10–15 digit phone match in one of the three canonical Sales Board phone columns (`phone__1`, `dup__of_phone7__1`, or `phone_mkrgdn4`). The adapter queries each column separately, unions and deduplicates item IDs, and the resolver rejects zero or multiple associated items. A native item ID is only a hint: it must resolve on the canonical Sales Board, contain the exact phone evidence, and agree with the unique phone lookup.

The Sales Board State is a business field, not proof of human recording consent. This schema has no configured recording-consent column. The audit path must not invent, infer, or require a consent value.

## Default safety posture and approval gate

This repository is **audit-only and disabled by default**. Its classifier always returns `leave_disabled`, including when the existing supplied `AUDIT_RULESET` marks a state as eligible; that result is only an audit classification, not recording authorization. The runtime contains no provider recording action and does not import or activate `aircall-recording-client`.

Blank, malformed, non-State, foreign-board, unmatched, or ambiguous records fail closed. No phone area code, candidate research, free-form evidence, native item ID alone, or unconfigured consent value can authorize recording.

Any proposal to enable recording behavior requires an explicit, separately documented approval gate from **Dave Donovan**, followed by the required legal, security, operational, and provider review. Until that gate is satisfied, all outcomes must leave recording disabled.
