# Timberline — Dave State-Gated Aircall Recording Demo

**Status:** Live, Dave-only pilot. Controller health: `https://aircall-audit.plinkosolutions.com/aircall/recording/control-health`

## Live scope

- Aircall user: **Dave Donovan** (`1980591`)
- Aircall number: **Direct Line - Admin - Dave Donovan** (`1303588`)
- Default live recording on this number: **off**
- Monday board: **Sales Board** (`7727339040`)
- Exact phone evidence: `phone__1`, `dup__of_phone7__1`, or `phone_mkrgdn4`
- Authoritative State field: Sales Board `text_2`

## Decision rule

At an authenticated Aircall `call.answered` event, the controller resumes recording only when all conditions are true:

1. the call is Dave using the configured direct number;
2. its dialed/contact phone has exactly one Sales Board match across all three phone columns; and
3. that matched item has a configured one-party State (for example, **TX**).

It leaves recording disabled when the State is non-eligible (for example, **CA**), missing, malformed, when there is no matching Sales Board item, when association is ambiguous, or when a different user/number places the call.

## Live demo procedure

### Positive proof — TX

1. Use an internal, non-customer Sales Board test item with exactly one canonical phone match and State `TX`.
2. Confirm the test number appears in only one of Phone1, Phone2, or Phone3 across the Sales Board.
3. From Dave’s direct line, place an internal call to that test number.
4. After the call is answered, open the Aircall call view and confirm recording begins/is available.
5. Complete the call. The separate Aircall Recording Link lane can then attach its recording reference to the matched Monday item.

Expected controller outcome: `resume_recording`.

### Negative proof — CA

1. Use a distinct internal test item with exactly one canonical phone match and State `CA`.
2. Place and answer an internal call from Dave’s direct line.
3. Confirm recording does not begin and no recording asset is produced.

Expected controller outcome: `left_disabled`.

### Negative proof — missing / ambiguous State or association

- Empty/invalid State, no Sales Board phone match, or a phone duplicated across items must remain unrecorded.
- Do not use a customer record to demonstrate these safety stops.

## Verified before demo

- Dave’s number default setting is `live_recording_activated: false`.
- The state-gated controller is active and health-checked.
- Aircall has one active Dave control subscription for `call.answered`.
- An authenticated public out-of-scope/no-match event returned HTTP 202 with `left_disabled`.

## Boundary

This pilot changes recording only for Dave’s configured direct line. It does not change any other Aircall number or user. The recording-link-to-Monday receiver is separate and only associates a completed recording with one exact Sales Board match.
