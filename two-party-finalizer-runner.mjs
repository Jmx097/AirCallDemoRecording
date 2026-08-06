import { createDelayedMondayLinkFinalizer, createMondayCallsFinalizerAdapter } from "./two-party-recording-finalizer.mjs";
import { createAircallDeletionReconciler, createProtectedTwoPartyStore } from "./two-party-finalizer-adapters.mjs";

const DEFAULT_STORE = "/var/lib/aircall-recording-control/two-party-finalizer.protected.jsonl";

/** One bounded systemd-timer invocation; it does not listen, daemonize, or deploy. */
export function readTwoPartyFinalizerConfig(env = process.env) {
  const get = key => typeof env?.[key] === "string" ? env[key] : "";
  const config = { file: get("TWO_PARTY_FINALIZER_STORE") || DEFAULT_STORE, capabilityKey: get("RECORDING_CAPABILITY_ACTIVE_KEY"), hmacKey: get("RECORDING_IDEMPOTENCY_HMAC_KEY"), apiId: get("AIRCALL_API_ID"), apiKey: get("AIRCALL_API_KEY"), mondayToken: get("MONDAY_API_TOKEN") };
  if (!config.file.startsWith("/") || ![config.capabilityKey, config.hmacKey, config.apiId, config.apiKey, config.mondayToken].every(secret)) throw new TypeError("invalid_two_party_finalizer_environment");
  return Object.freeze(config);
}
export function createTwoPartyFinalizerRunner({ env = process.env, fetchImpl = globalThis.fetch, store: injectedStore, monday: injectedMonday, reconciler: injectedReconciler } = {}) {
  const config = readTwoPartyFinalizerConfig(env);
  const store = injectedStore ?? createProtectedTwoPartyStore({ file: config.file, capabilityKey: config.capabilityKey, hmacKey: config.hmacKey });
  const reconciler = injectedReconciler ?? createAircallDeletionReconciler({ apiId: config.apiId, apiKey: config.apiKey, idempotencyKey: config.hmacKey, fetchImpl, store });
  const monday = injectedMonday ?? createMondayCallsFinalizerAdapter({ mondayToken: config.mondayToken, fetchImpl });
  const finalizer = createDelayedMondayLinkFinalizer({ readAuditedDecision: store.readAuditedDecision, reconcileDeletion: reconciler.reconcileDeletion, monday });
  async function runOnce() {
    const ids = await store.pendingDecisionIds(); const results = [];
    for (const decisionId of ids) {
      try { const result = await finalizer.finalize(decisionId); if (result.status === "link_cleared_and_verified") await store.recordMondayFinalized(decisionId, result.itemId); results.push(Object.freeze({ decisionId, status: result.status })); }
      catch { results.push(Object.freeze({ decisionId, status: "dependency_failure" })); }
    }
    return Object.freeze({ scanned: ids.length, finalized: results.filter(x => x.status === "link_cleared_and_verified").length, results: Object.freeze(results) });
  }
  return Object.freeze({ runOnce, store });
}
export async function main() { const result = await createTwoPartyFinalizerRunner().runOnce(); process.stdout.write(`${JSON.stringify({ event: "two_party_finalizer_completed", scanned: result.scanned, finalized: result.finalized, statuses: result.results.map(x => x.status) })}\n`); }
function secret(value) { return typeof value === "string" && value.length >= 16 && !/[\0-\x1f\x7f]/.test(value); }
if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) void main().catch(() => { process.stderr.write("two_party_finalizer_failed\n"); process.exitCode = 1; });
