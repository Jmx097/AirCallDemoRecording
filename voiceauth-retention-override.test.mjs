import assert from "node:assert/strict";
import test from "node:test";
import { createTwoPartyRetentionFinalizer } from "./two-party-retention-finalizer.mjs";

test("tag-shaped legacy store methods cannot suppress delayed two-party deletion", async () => {
  const calls=[];
  const store={
    recordDecision:async()=>({recorded:true}),enqueueAsset:async()=>({status:"queued"}),
    claimNext:async()=>({id:"1",status:"delete_pending",providerCallId:"call-1",providerCallKeyHash:"a".repeat(64),callsItemId:"2",leaseToken:"lease"}),
    hasVoiceAuthOverride:async()=>true,markVoiceAuthRetained:async()=>calls.push("retained"),markException:async()=>calls.push("exception"),
    markDeleteRequested:async()=>calls.push("delete-requested"),markDeleteConfirmed:async()=>{},markMondayCleared:async()=>{},releaseForReconcile:async()=>{},
  };
  const aircall={deleteRecording:async()=>calls.push("delete"),recordingUnavailable:async()=>false,hasVoiceAuthTag:async()=>true};
  const monday={clearExactRecordingLink:async()=>calls.push("clear"),readExactRecordingLink:async()=>null};
  const r=createTwoPartyRetentionFinalizer({store,aircall,monday,correlationKey:"k".repeat(32)});
  assert.deepEqual(await r.runOnce(),{outcome:"delete_requested"});
  assert.deepEqual(calls,["delete","delete-requested"]);
});
