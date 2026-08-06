import assert from "node:assert/strict";
import test from "node:test";
import { createTwoPartyRetentionFinalizer } from "./two-party-retention-finalizer.mjs";

test("VoiceAuth durable override prevents deletion and Monday mutation", async () => {
  const calls=[];
  const store={
    recordDecision:async()=>({recorded:true}),enqueueAsset:async()=>({status:"queued"}),
    claimNext:async()=>({id:"1",status:"delete_pending",providerCallId:"call-1",providerCallKeyHash:"a".repeat(64),callsItemId:"2",leaseToken:"lease"}),
    hasVoiceAuthOverride:async()=>true,markVoiceAuthRetained:async()=>calls.push("retained"),markException:async()=>calls.push("exception"),
    markDeleteRequested:async()=>calls.push("delete-requested"),markDeleteConfirmed:async()=>{},markMondayCleared:async()=>{},releaseForReconcile:async()=>{},
  };
  const aircall={deleteRecording:async()=>calls.push("delete"),recordingUnavailable:async()=>false};
  const monday={clearExactRecordingLink:async()=>calls.push("clear"),readExactRecordingLink:async()=>null};
  const r=createTwoPartyRetentionFinalizer({store,aircall,monday,correlationKey:"k".repeat(32)});
  assert.deepEqual(await r.runOnce(),{outcome:"voiceauth_retained"});
  assert.deepEqual(calls,["retained"]);
});
