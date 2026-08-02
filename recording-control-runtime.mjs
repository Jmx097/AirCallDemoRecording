import { createHash } from "node:crypto";
import { createPostgresRecordingActionStore } from "./postgres-recording-action-store.mjs";
import { createAircallRecordingClient } from "./aircall-recording-client.mjs";
import { createRecordingActionWorker } from "./recording-action-worker.mjs";
import { createSalesBoardControlAdapter, SALES_CONTROL_LOOKUP_QUERY, SALES_CONTROL_SCHEMA_QUERY } from "./sales-board-recording-control-adapter.mjs";
import { createRecordingControlDecisionService } from "./recording-control-decision-service.mjs";
import { createRecordingControlReceiver } from "./recording-control-receiver.mjs";
import { hashPilotScope, validateActivationApprovalPublicKey } from "./recording-activation-approval.mjs";
export const RECORDING_CONTROL_POLICY_VERSION="timberline-recording-control-2026-08-02.2";
export const RECORDING_CONSENT_COLUMN_ID="dropdown_mm5v99w5";
const POLICY_HASH=createHash("sha256").update(JSON.stringify({version:RECORDING_CONTROL_POLICY_VERSION,board:"7727339040",state:"text_2",phones:["phone__1","dup__of_phone7__1","phone_mkrgdn4"],consent:RECORDING_CONSENT_COLUMN_ID,eligibleStates:["TX"]})).digest("hex");
export function readRecordingControlConfig(env=process.env) {
  const get=k=>typeof env?.[k]==="string"?env[k]:undefined;
  const mode=get("RECORDING_CONTROL_MODE")??"DISABLED";
  if(!["DISABLED","CONTROL_ENABLED"].includes(mode)||get("RECORDING_CONTROL_HOST")&&! ["127.0.0.1"].includes(get("RECORDING_CONTROL_HOST")))throw new TypeError("invalid_control_environment");
  const userIds=list(get("RECORDING_PILOT_USER_IDS")),numberIds=list(get("RECORDING_PILOT_NUMBER_IDS"));
  const required={databaseUrl:get("AIRCALL_CONTROL_DATABASE_URL"),mondayToken:get("MONDAY_API_TOKEN"),webhookToken:get("AIRCALL_CONTROL_WEBHOOK_TOKEN"),idempotencyKey:get("RECORDING_IDEMPOTENCY_HMAC_KEY"),pseudonymKey:get("RECORDING_PSEUDONYM_HMAC_KEY"),capabilityKey:get("RECORDING_CAPABILITY_ACTIVE_KEY"),capabilityKeyId:get("RECORDING_CAPABILITY_ACTIVE_KEY_ID"),approvalPublicKey:get("RECORDING_APPROVAL_PUBLIC_KEY"),deploymentId:get("RECORDING_DEPLOYMENT_ID")};
  for(const [k,v]of Object.entries(required))if(!text(v)||(k.endsWith("Key")&&!['capabilityKey','approvalPublicKey'].includes(k)&&v.length<32))throw new TypeError("separate_recording_secrets_required");
  if(RECORDING_CONSENT_COLUMN_ID!==get("MONDAY_RECORDING_CONSENT_COLUMN_ID"))throw new TypeError("invalid_consent_column");
  key32(required.capabilityKey);
  validateActivationApprovalPublicKey(required.approvalPublicKey);
  const previous=(get("RECORDING_CAPABILITY_PREVIOUS_KEYS")??"").split(",").filter(Boolean);
  for(const x of previous){const at=x.indexOf(":");if(at<1)throw new TypeError("invalid_previous_keys");key32(x.slice(at+1));}
  enforceSecretSeparation(required,previous);
  const envArmed=mode==="CONTROL_ENABLED"&&get("CONTROL_ENABLED")==="true"&&get("RECORDING_CONTROL_POLICY_VERSION")===RECORDING_CONTROL_POLICY_VERSION&&userIds.length>0&&numberIds.length>0&&text(get("AIRCALL_API_ID"))&&text(get("AIRCALL_API_KEY"));
  if(mode==="CONTROL_ENABLED"&&!envArmed)throw new TypeError("control_activation_requirements_not_met");
  const scope=Object.freeze({deploymentId:required.deploymentId,policyHash:POLICY_HASH,pilotHash:hashPilotScope(userIds,numberIds),consentColumnId:RECORDING_CONSENT_COLUMN_ID});
  return Object.freeze({...required,previous,userIds,numberIds,mode,envArmed,scope,policyHash:POLICY_HASH,policyVersion:RECORDING_CONTROL_POLICY_VERSION,aircallApiId:get("AIRCALL_API_ID"),aircallApiKey:get("AIRCALL_API_KEY"),host:"127.0.0.1",port:port(get("RECORDING_CONTROL_PORT"))});
}
export function createRecordingControlRuntime({env=process.env,fetchImpl=globalThis.fetch,createStore=createPostgresRecordingActionStore,createReceiver=createRecordingControlReceiver,createProvider=createAircallRecordingClient,createWorker=createRecordingActionWorker,workerLoopFactory=createWorkerLoop}={}){const config=readRecordingControlConfig(env);const store=createStore({databaseUrl:config.databaseUrl,capabilityKey:config.capabilityKey,capabilityKeyId:config.capabilityKeyId,previousCapabilityKeys:config.previous,approvalPublicKey:config.approvalPublicKey,activationScope:config.scope,maxDecisionAgeMs:120000,leaseMs:30000});const query=createMondayReadQuery({token:config.mondayToken,fetchImpl});const adapter=createSalesBoardControlAdapter({consentColumnId:RECORDING_CONSENT_COLUMN_ID,query});const service=createRecordingControlDecisionService({adapter,store,idempotencyKey:config.idempotencyKey,pseudonymKey:config.pseudonymKey,mode:config.mode,policyVersion:config.policyVersion,approvedPolicyVersion:RECORDING_CONTROL_POLICY_VERSION,policyHash:config.policyHash,consentColumnId:RECORDING_CONSENT_COLUMN_ID,pilotUserIds:config.userIds,pilotNumberIds:config.numberIds});let provider=null,loop=null,workerStarted=false;
  async function initializeAuthority(){
    if(!config.envArmed)return false;
    const [schema,current]=await Promise.all([adapter.checkSchema(),store.readiness(config.scope)]);
    if(schema!==true||current?.actionsEnabled!==true||current?.activationMatches!==true
      ||current?.reconciliationCount!==0||current?.unknownKeyCount!==0)return false;
    provider=createProvider({apiId:config.aircallApiId,apiKey:config.aircallApiKey,fetch:fetchImpl});
    const worker=createWorker({store,revalidate:service.revalidate,resumeRecording:provider.resumeRecording,audit:async()=>{},providerTimeoutMs:10000,retryDelaysMs:[1000,5000,30000]});
    loop=workerLoopFactory(worker);
    return true;
  }
  async function readiness(){
    const checkedAt=new Date().toISOString();
    const [db,schema,s]=await Promise.allSettled([store.checkReady(),adapter.checkSchema(),store.readiness(config.scope)]);
    const state=s.status==="fulfilled"?s.value:{};
    const loopHealth=loop?.health?.()??{};
    const lastRunMs=typeof loopHealth.lastRunAt==="string"?Date.parse(loopHealth.lastRunAt):NaN;
    const workerHealthy=workerStarted&&Number.isFinite(lastRunMs)&&(Date.now()-lastRunMs)<5000&&loopHealth.consecutiveFailures===0;
    const base={db:db.status==="fulfilled"&&db.value===true,schema:schema.status==="fulfilled"&&schema.value===true,actionsEnabled:state.actionsEnabled===true,activationMatches:state.activationMatches===true,reconciliationCount:state.reconciliationCount??-1,unknownKeyCount:state.unknownKeyCount??-1,envArmed:config.envArmed,workerAuthority:loop!==null,providerAuthority:provider!==null,workerHealthy,checkedAt};
    let phase="not_ready";
    if(!config.envArmed&&base.actionsEnabled===false&&!base.workerAuthority&&!base.providerAuthority)phase="staged";
    else if(config.envArmed&&base.actionsEnabled===false)phase="ready_for_activation";
    else if(config.envArmed&&base.actionsEnabled&&base.activationMatches&&base.workerHealthy&&base.providerAuthority&&base.reconciliationCount===0&&base.unknownKeyCount===0&&base.schema&&base.db)phase="actively_controlling";
    return Object.freeze({...base,state:phase});
  }
  const receiver=createReceiver({expectedWebhookToken:config.webhookToken,idempotencyKey:config.idempotencyKey,service,readiness,mode:config.mode,armed:config.envArmed,host:config.host,port:config.port});return {config:Object.freeze({mode:config.mode,armed:config.envArmed,host:config.host,port:config.port}),store,receiver,get loop(){return loop;},initializeAuthority,markWorkerStarted(){workerStarted=true;}};}
export async function startRecordingControlRuntime(runtime){try{await runtime.store.ready;const authority=await runtime.initializeAuthority();const address=await runtime.receiver.start();if(authority){runtime.loop.start();runtime.markWorkerStarted();}return address;}catch{await Promise.allSettled([runtime.loop?.stop(),runtime.receiver.close(),runtime.store.close()]);throw new Error("recording_control_start_failed");}}
export async function stopRecordingControlRuntime(runtime){
  await Promise.allSettled([runtime.loop?.stop(),runtime.receiver.close()]);
  await runtime.store.close();
}
export async function main(){
  const runtime=createRecordingControlRuntime();
  const address=await startRecordingControlRuntime(runtime);
  process.stdout.write(`${JSON.stringify({event:"recording_control_started",address:address.address,port:address.port,mode:runtime.config.mode,armed:runtime.config.armed})}\n`);
  let stopping=false;
  const shutdown=async(signal)=>{
    if(stopping)return;
    stopping=true;
    await stopRecordingControlRuntime(runtime);
    process.stdout.write(`${JSON.stringify({event:"recording_control_stopped",signal})}\n`);
  };
  process.once("SIGTERM",()=>void shutdown("SIGTERM").then(()=>process.exit(0),()=>process.exit(1)));
  process.once("SIGINT",()=>void shutdown("SIGINT").then(()=>process.exit(0),()=>process.exit(1)));
}
if(process.argv[1]&&import.meta.url===new URL(process.argv[1],"file:").href)void main().catch(()=>{process.stderr.write("recording_control_start_failed\n");process.exitCode=1;});
export function createWorkerLoop(worker,{intervalMs=250}={}){
  let active=false,running=null,timer,lastRunAt=null,consecutiveFailures=0,lastOutcome="not_started";
  const schedule=()=>{if(active){timer=setTimeout(run,intervalMs);timer.unref?.();}};
  const run=()=>{
    if(!active||running)return;
    running=Promise.resolve().then(()=>worker.runOnce()).then(result=>{
      lastRunAt=new Date().toISOString();
      lastOutcome=typeof result?.outcome==="string"?result.outcome:"unknown";
      consecutiveFailures=["store_failure","malformed_claim","dispatch_fence_failure"].includes(lastOutcome)?consecutiveFailures+1:0;
    }).catch(()=>{
      lastRunAt=new Date().toISOString();
      lastOutcome="unhandled_failure";
      consecutiveFailures+=1;
    }).finally(()=>{running=null;schedule();});
  };
  return Object.freeze({
    start(){if(!active){active=true;run();}},
    async stop(){active=false;clearTimeout(timer);await running;},
    health(){return Object.freeze({active,running:running!==null,lastRunAt,consecutiveFailures,lastOutcome});},
  });
}
export function createMondayReadQuery({token,fetchImpl}){if(!text(token)||typeof fetchImpl!=="function")throw new TypeError("invalid_monday_client");return async request=>{if(![SALES_CONTROL_LOOKUP_QUERY,SALES_CONTROL_SCHEMA_QUERY].includes(request?.query))throw new Error("monday_query_rejected");let response;try{response=await fetchImpl("https://api.monday.com/v2",{method:"POST",headers:{authorization:token,"content-type":"application/json"},body:JSON.stringify(request),redirect:"error",signal:AbortSignal.timeout(5000)});}catch{throw new Error("monday_read_failed");}if(response?.ok!==true)throw new Error("monday_read_failed");const bytes=await boundedResponse(response,262144);let value;try{value=JSON.parse(bytes.toString("utf8"));}catch{throw new Error("monday_read_failed");}if(!value||typeof value!=="object"||value.errors?.length)throw new Error("monday_read_failed");return value;};}
async function boundedResponse(response,cap){if(response.body?.getReader){const reader=response.body.getReader();const chunks=[];let n=0;try{for(;;){const {done,value}=await reader.read();if(done)break;n+=value.byteLength;if(n>cap)throw new Error("monday_read_failed");chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}return Buffer.concat(chunks);}const textValue=await response.text();if(Buffer.byteLength(textValue)>cap)throw new Error("monday_read_failed");return Buffer.from(textValue);}
function list(v){if(!v)return Object.freeze([]);const x=v.split(",");if(x.some(y=>!y||y!==y.trim())||new Set(x).size!==x.length)throw new TypeError("invalid_pilot_identifiers");return Object.freeze(x);}
function key32(v){const b=Buffer.from(v??"","base64");if(b.length!==32||b.toString("base64")!==v)throw new TypeError("invalid_32_byte_key");return b;}
function enforceSecretSeparation(required,previous){
  const entries=[
    {representation:required.webhookToken,material:Buffer.from(required.webhookToken)},
    {representation:required.idempotencyKey,material:Buffer.from(required.idempotencyKey)},
    {representation:required.pseudonymKey,material:Buffer.from(required.pseudonymKey)},
    {representation:required.capabilityKey,material:key32(required.capabilityKey)},
    ...previous.map(x=>{const at=x.indexOf(":");const value=x.slice(at+1);return{representation:value,material:key32(value)};}),
  ];
  for(let i=0;i<entries.length;i+=1)for(let j=i+1;j<entries.length;j+=1){
    const a=entries[i],b=entries[j];
    if(a.representation===b.representation||(a.material.length===b.material.length&&a.material.equals(b.material)))throw new TypeError("separate_recording_secrets_required");
  }
}
function text(v){return typeof v==="string"&&v.length>0&&!/[\r\n\0]/.test(v);}function port(v){if(v===undefined)return 8081;if(!/^\d+$/.test(v)||Number(v)<1||Number(v)>65535)throw new TypeError("invalid_port");return Number(v);}
