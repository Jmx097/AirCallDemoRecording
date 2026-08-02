/** At-most-once recording worker. Provider authority exists only inside the store's dispatch fence. */
export function createRecordingActionWorker(options={}) {
  const store=options.store;
  const claim=method(store,"claimNext"), resolve=method(store,"resolveAuthorizationContext"), prepare=method(store,"prepareDispatch"), fenced=method(store,"executeWithDispatchFence"), retry=method(store,"markRetry"), cancel=method(store,"cancel");
  const revalidate=fn(options.revalidate,"revalidate"), resume=fn(options.resumeRecording,"resumeRecording");
  const audit=typeof options.audit==="function"?options.audit:async()=>{};
  const delays=Object.freeze([...(options.retryDelaysMs??[1000,5000,30000])]);
  if(delays.some(x=>!Number.isInteger(x)||x<1||x>86_400_000)||delays.length>20)throw new TypeError("invalid_retry_schedule");
  async function terminal(c,reason){try{const saved=await cancel(c,reason);return Object.freeze({outcome:saved?.status==="canceled"?"canceled":"store_failure",reason});}catch{return Object.freeze({outcome:"store_failure"});}}
  async function defer(c,reason){const delayMs=delays[c.attempt-1];if(delayMs===undefined)return terminal(c,"authorization_expired");try{const saved=await retry(c,{delayMs,reason});return Object.freeze({outcome:saved?.status??"store_failure",reason,...(saved?.status==="retry_scheduled"?{delayMs}:{})});}catch{return Object.freeze({outcome:"store_failure"});}}
  async function runOnce(){let raw;try{raw=await claim();}catch{return Object.freeze({outcome:"store_failure"});}if(!raw)return Object.freeze({outcome:"idle"});const c=snapshotClaim(raw);if(!c)return Object.freeze({outcome:"malformed_claim"});
    let context;try{context=await resolve(c);}catch{return defer(c,"capability_failure");}if(context?.unavailable==="unknown_key")return terminal(c,"unknown_key");if(!validContext(context))return defer(c,"capability_failure");
    let current;try{current=await revalidate(context);}catch{return defer(c,"revalidation_failure");}if(!authorized(current,context))return terminal(c,"authorization_denied");
    try{await audit(Object.freeze({event:"recording_resume_dispatch",actionKey:c.actionKeyHash,attempt:c.attempt,evidenceDigest:context.evidenceDigest}));}catch{return defer(c,"audit_failure");}
    let prepared;try{prepared=await prepare(c);}catch{return terminal(c,"authorization_denied");}
    // No injected operation may occur between prepare and the transaction fence.
    try{return await fenced(prepared,()=>resume(context.callId,{signal:AbortSignal.timeout(options.providerTimeoutMs??10_000)}));}
    catch{return Object.freeze({outcome:"dispatch_fence_failure"});}
  }
  return Object.freeze({runOnce,processNext:runOnce});
}
function method(o,n){if(!o||typeof o[n]!=="function")throw new TypeError(`Store.${n} must be a function.`);return o[n].bind(o);}function fn(v,n){if(typeof v!=="function")throw new TypeError(`${n} required`);return v;}
function snapshotClaim(v){try{const actionKeyHash=v.actionKeyHash??v.actionKey;if(!/^[0-9a-f]{64}$/.test(actionKeyHash)||typeof v.leaseToken!=="string"||!Number.isInteger(v.attempt)||v.attempt<1||!Number.isInteger(v.controlEpoch)||v.controlEpoch<0)return null;return Object.freeze({actionKeyHash,actionKey:actionKeyHash,leaseToken:v.leaseToken,attempt:v.attempt,controlEpoch:v.controlEpoch});}catch{return null;}}
function validContext(v){return v&&typeof v==="object"&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v.callId??"")&&/^\d{10,15}$/.test(v.phoneDigits??"")&&/^[0-9a-f]{64}$/.test(v.evidenceDigest??"");}
function authorized(v,c){return v?.authorized===true&&v.itemId===c.itemId&&v.evidenceDigest===c.evidenceDigest;}
export default createRecordingActionWorker;
