# Callback Business-State Policy

## Approved operating model

For the Callback workflow, the **Callbacks board is the canonical board**. `State` means the customer company's **business-address State**.

The rep-verified controlled `State` dropdown is the authoritative source for any future consent decision. The raw-payload adapter boundary supplies JSON strings; the resolver parses them itself and accepts `state` only as `{ value, source: 'rep_verified_controlled_state_dropdown', verified: true }` (with the source configured by the caller). Bare/free-text states, other sources, Maps-shaped evidence, and unverified values are rejected. A Maps/Places research result is **candidate evidence only**; it is never governing state data and cannot authorize recording.

## Research and verification workflow

1. A Callback with a blank `State` may enter an audit-only research lane.
2. Maps/Places research may use company and other non-sensitive business identifiers to produce candidate evidence.
3. Candidate evidence may be retained in non-governing research fields, such as status, source URL/place identifier, timestamp, and rationale.
4. A rep verifies the business-address State and selects the controlled `State` dropdown on the canonical Callbacks board.
5. Blank, ambiguous, weak, or unresolved research leaves `State` blank. No candidate evidence, phone area code, research status, or evidence text may substitute for the rep-verified dropdown.

## Default safety posture and approval gate

This repository is **audit-only and disabled by default**. Its classifier always returns `leave_disabled`, including when a supplied ruleset marks a state as eligible; that result is only an audit classification, not recording authorization. It contains no live legal ruleset, provider configuration, credentials, webhook registration, or recording control.

Any proposal to enable an integration or recording behavior requires an explicit, separately documented approval gate from **Dave Donovan**, followed by the required legal, security, operational, and provider review. Until that gate is satisfied, all outcomes must leave recording disabled.

## Research cost and retry guardrail

Research should run only when `State` is blank and the research status is empty or `Needs Research`. Terminal outcomes (for example `Candidate Found`, `Verified`, or `Unresolved`) suppress repeat Maps calls unless a human explicitly resets the record for re-research.
