# Aircall Recording Link Routing

**Live target board:** Aircall Calls (`18419412577`)
**Target key:** `Call ID` (`text_mm4nwyyx`)
**Target field:** `Recording/Voicemail Link` (`link_mm4n5qp`)
**Sales trigger board:** Sales Board (`7727339040`)
**Sales trigger fields:** `phone__1`, `dup__of_phone7__1`, `phone_mkrgdn4`

## Boundary

This receiver only associates an already-created Aircall recording/voicemail URL. It cannot enable, pause, resume, delete, retain, or otherwise control Aircall recording behavior.

## Decision path

```text
Authenticated Aircall call.ended / call.comm_assets_generated event
→ recording URL present or read from Aircall call detail
→ exact normalized phone has exactly one Sales Board record
→ exact Aircall call ID has exactly one Aircall Calls record
→ write URL only to Aircall Calls → Recording/Voicemail Link
```

The Sales Board is a **trigger/qualification** source only. The receiver never writes the recording URL to the Sales Board.

## Fail-closed behavior

No Monday mutation occurs on bad token/input, recording not ready, zero/multiple Sales Board matches, zero/multiple Aircall Calls rows, invalid target column evidence, or Aircall/Monday dependency failure. Repeated provider events converge by writing the same link value to the same Call ID row; they do not create items.

## Verification order

1. Local tests cover exact unique routing and every zero/ambiguous trigger/target stop.
2. A signed synthetic no-match event returns `no_sales_trigger` and cannot mutate Monday.
3. A controlled non-customer call with a known unique Sales Board phone and pre-existing Aircall Calls row proves the real provider delivery path. Read back only the target link presence/type/host.

Provider recording URLs may expire under Aircall policy; the Monday value is an operational reference, not an archive.
