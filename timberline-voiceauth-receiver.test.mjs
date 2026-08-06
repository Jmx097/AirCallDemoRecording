import assert from "node:assert/strict";
import test from "node:test";
import { normalizeVoiceAuthEvent, createVoiceAuthReceiver } from "./timberline-voiceauth-receiver.mjs";

const TOKEN = "t".repeat(32), KEY = "k".repeat(32), TAG = "918273";
const body = (data = { id: "call-1", tags: [{ id: TAG, name: "#VoiceAuth" }] }) => JSON.stringify({ event: "call.tagged", token: TOKEN, data });
test("accepts only an authenticated call.tagged event with the configured immutable tag id", () => {
  assert.equal(normalizeVoiceAuthEvent(body(), TOKEN, TAG)?.providerCallId, "call-1");
  assert.equal(normalizeVoiceAuthEvent(body({ id: "call-1", tags: [{ id: "7", name: "#VoiceAuth" }] }), TOKEN, TAG), null);
  assert.equal(normalizeVoiceAuthEvent(body(), "x".repeat(32), TAG), null);
  assert.equal(normalizeVoiceAuthEvent(JSON.stringify({ event: "call.answered", token: TOKEN, data: { id: "call-1", tags: [{ id: TAG }] } }), TOKEN, TAG), null);
});
test("receiver records only opaque override evidence and has no destructive interface", async () => {
  const calls=[]; const receiver=createVoiceAuthReceiver({token:TOKEN,voiceAuthTagId:TAG,correlationKey:KEY,store:{recordVoiceAuthOverride:async value=>calls.push(value)}});
  const {host,port}=await receiver.start({port:0});
  try { const r=await fetch(`http://${host}:${port}/aircall/recording/voiceauth-events`,{method:"POST",headers:{"content-type":"application/json"},body:body()}); assert.equal(r.status,202); assert.deepEqual(await r.json(),{accepted:true,outcome:"voiceauth_retained"}); assert.equal(calls.length,1); assert.match(calls[0].providerCallKeyHash,/^[a-f0-9]{64}$/); assert.match(calls[0].eventKeyHash,/^[a-f0-9]{64}$/); } finally { await receiver.close(); }
});
