import assert from "node:assert/strict";
import test from "node:test";
import { createTwoPartyRetentionFinalizer } from "./two-party-retention-finalizer.mjs";

test("deletion confirmation releases its lease before a fresh claim clears the exact Monday link", async () => {
  const calls = [];
  const claims = [
    { id: "action-1", status: "delete_requested", providerCallId: "call-1", providerCallKeyHash: "a".repeat(64), callsItemId: "item-1", leaseToken: "lease-1" },
    { id: "action-1", status: "delete_confirmed", providerCallId: "call-1", providerCallKeyHash: "a".repeat(64), callsItemId: "item-1", leaseToken: "lease-2" },
  ];
  const store = {
    recordDecision: async () => ({ recorded: true }),
    enqueueAsset: async () => ({ status: "queued" }),
    claimNext: async () => claims.shift() ?? null,
    markDeleteRequested: async () => calls.push("delete-requested"),
    markDeleteConfirmed: async action => calls.push(`confirmed:${action.leaseToken}`),
    markMondayCleared: async action => calls.push(`cleared:${action.leaseToken}`),
    releaseForReconcile: async () => calls.push("released-for-reconcile"),
    markException: async (_action, code) => calls.push(`exception:${code}`),
    hasVoiceAuthOverride: async () => false,
    markVoiceAuthRetained: async () => calls.push("voiceauth-retained"),
  };
  const aircall = {
    deleteRecording: async () => calls.push("delete"),
    recordingUnavailable: async () => { calls.push("reconcile"); return true; },
    hasVoiceAuthTag: async () => false,
  };
  const monday = {
    clearExactRecordingLink: async ({ itemId }) => calls.push(`clear:${itemId}`),
    readExactRecordingLink: async ({ itemId }) => { calls.push(`read:${itemId}`); return null; },
  };
  const finalizer = createTwoPartyRetentionFinalizer({ store, aircall, monday, correlationKey: "k".repeat(32) });

  assert.deepEqual(await finalizer.runOnce(), { outcome: "delete_confirmed" });
  assert.deepEqual(calls, ["reconcile", "confirmed:lease-1"]);

  assert.deepEqual(await finalizer.runOnce(), { outcome: "monday_link_cleared" });
  assert.deepEqual(calls, ["reconcile", "confirmed:lease-1", "clear:item-1", "read:item-1", "cleared:lease-2"]);
});
