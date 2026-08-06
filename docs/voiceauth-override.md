# VoiceAuth recording-retention override

## Approved policy change

A verified Aircall `#VoiceAuth` tag, identified by a configured immutable Aircall Tag ID, overrides two-party **post-asset deletion** and Monday `link_mm4n5qp` clearing for the exact provider Call ID. The override is durable and redacted.

## Event contract

- Aircall event: `call.tagged`.
- Receiver: `POST /aircall/recording/voiceauth-events`.
- The receiver accepts only a token-authenticated direct Call object whose `data.tags` includes the configured numeric `AIRCALL_VOICEAUTH_TAG_ID`.
- It writes only HMAC/hash-keyed evidence. It cannot call Aircall recording APIs or Monday.
- The retention worker checks the durable evidence immediately before deletion. When configured, it additionally re-reads `GET /v1/calls/:id` and requires that the configured tag ID is absent before delete dispatch.

## Boundary

Aircall documents that in-call agent tagging can emit `call.tagged` only at call end. This flow therefore prevents deletion/link clearing; it cannot retroactively prevent an answer-time pause. A no-pause override requires authoritative pre-answer evidence.

## Activation prerequisites

1. Read the immutable ID of the existing Aircall `#VoiceAuth` tag and set `AIRCALL_VOICEAUTH_TAG_ID`.
2. Set `AIRCALL_VOICEAUTH_WEBHOOK_TOKEN` to the token belonging to the repurposed inactive Aircall subscription.
3. Install/start `aircall-voiceauth-receiver.service`, add the Nginx exact route to local port `3341`, and verify authenticated/unauthenticated probes.
4. Only then repurpose the inactive `audit-events` subscription to `call.tagged` at the new route. Do not alter the live `call.answered` control or link/asset subscriptions.
5. Use a fresh internal non-customer call tagged with VoiceAuth, verify durable override, no DELETE, and no Monday clear.
