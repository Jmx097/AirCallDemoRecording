import assert from "node:assert/strict";
import test from "node:test";
import { createRuntime, normalizeEvent } from "./recording-link-runtime.mjs";

const token="x".repeat(20), phone="15551234567", call="call-1", url="https://assets.aircall.io/recording/call-1";
const config={webhookToken:token,aircallId:"a".repeat(20),aircallKey:"b".repeat(20),mondayToken:"c".repeat(20),host:"127.0.0.1",port:0};
const payload=(extra={})=>JSON.stringify({token,event:"call.comm_assets_generated",data:{id:call,raw_digits:phone,recording_short_url:url,...extra}});
function response(value,{ok=true}={}) { return {ok,json:async()=>value}; }
function mock({sales=["sales-1"],callRows=["call-row-1"]}={}) {
  const calls=[]; let rows=[...callRows];
  const fetch=async (u,o={})=>{
    calls.push({u,o});
    if(u!=="https://api.monday.com/v2") throw new Error("unexpected aircall read");
    const request=JSON.parse(o.body), q=request.query, v=request.variables;
    if(q.startsWith("mutation")){if(q.includes("create_item")){rows.push("created-call-row");return response({data:{create_item:{id:"created-call-row"}}});}return response({data:{change_multiple_column_values:{id:v.item}}});}
    const ids=v.b==="7727339040"?sales:rows;
    const type=v.b==="7727339040"?"phone":"text";
    const text=v.b==="7727339040"?"+1 555 123 4567":call;
    const items=ids.map(id=>({id,board:{id:v.b},column_values:v.b==="7727339040"?[{id:v.c,type,text},{id:"text_2",type:"text",text:"NJ"}]:[{id:v.c,type,text}]}));
    return response({data:{items_page_by_column_values:{items}}});
  };
  return {fetch,calls};
}
async function post(origin,body){const r=await fetch(origin+"/aircall/recording/link-events",{method:"POST",headers:{"content-type":"application/json"},body});return{status:r.status,body:await r.json()};}
function mutations(calls){return calls.filter(x=>x.u==="https://api.monday.com/v2"&&JSON.parse(x.o.body).query.startsWith("mutation"));}

test("normalizes only authenticated completed/asset call events",()=>{assert.equal(normalizeEvent(payload(),token)?.callId,call);assert.equal(normalizeEvent(payload({id:1234567890}),token)?.callId,"1234567890");assert.equal(normalizeEvent(payload({raw_digits:"+1 (555) 123-4567"}),token)?.phoneDigits,"15551234567");assert.equal(normalizeEvent(payload({recording_short_url:"http://bad"}),token)?.url,null);assert.equal(normalizeEvent(payload(),"z".repeat(20)),null);assert.equal(normalizeEvent(JSON.stringify({token,event:"call.answered",data:{id:call,raw_digits:phone}}),token),null);});
test("Sales Board is an exact unique trigger and the link writes only to its matching Aircall Calls row",async()=>{const m=mock();const r=createRuntime({config,fetchImpl:m.fetch,decisionStateForCall:()=>"NJ"});const a=await r.start();try{assert.deepEqual(await post(`http://${a.host}:${a.port}`,payload()),{status:202,body:{accepted:true,outcome:"linked"}});const mutation=mutations(m.calls)[0];assert.ok(mutation);const request=JSON.parse(mutation.o.body);assert.equal(request.variables.board,"18419412577");assert.equal(request.variables.item,"call-row-1");assert.deepEqual(JSON.parse(request.variables.values),{link_mm4n5qp:{url,text:"Aircall recording (expires per Aircall policy)"}});assert.equal(m.calls.filter(x=>x.u==="https://api.monday.com/v2"&&!JSON.parse(x.o.body).query.startsWith("mutation")).some(x=>JSON.parse(x.o.body).variables.b==="7727339040"),true);}finally{await r.close();}});
test("zero or ambiguous Sales trigger and ambiguous target rows never write",async()=>{for(const [options,outcome] of [[{sales:[]},"no_sales_trigger"],[{sales:["a","b"]},"ambiguous_sales_trigger"],[{callRows:["a","b"]},"ambiguous_call_row"]]){const m=mock(options);const r=createRuntime({config,fetchImpl:m.fetch,decisionStateForCall:()=>"NJ"});const a=await r.start();try{assert.deepEqual(await post(`http://${a.host}:${a.port}`,payload()),{status:202,body:{accepted:true,outcome}});assert.equal(mutations(m.calls).length,0);}finally{await r.close();}}});
test("a unique Sales trigger creates and re-reads a missing immutable call ledger row before linking",async()=>{const m=mock({callRows:[]});const r=createRuntime({config,fetchImpl:m.fetch,decisionStateForCall:()=>"NJ"});const a=await r.start();try{assert.deepEqual(await post(`http://${a.host}:${a.port}`,payload()),{status:202,body:{accepted:true,outcome:"linked"}});const requests=m.calls.filter(x=>x.u==="https://api.monday.com/v2").map(x=>JSON.parse(x.o.body));assert.equal(requests.filter(x=>x.query.includes("create_item")).length,1);const link=requests.find(x=>x.query.startsWith("mutation")&&x.query.includes("change_multiple_column_values"));assert.equal(link.variables.item,"created-call-row");assert.equal(link.variables.board,"18419412577");}finally{await r.close();}});
test("two-party webhook processing only stages finalization; it cannot delete Aircall data or mutate Monday",async()=>{const m=mock();const r=createRuntime({config,fetchImpl:m.fetch,decisionStateForCall:()=>"CA",retentionAuditForCall:()=>{}});const a=await r.start();try{assert.deepEqual(await post(`http://${a.host}:${a.port}`,payload()),{status:202,body:{accepted:true,outcome:"two_party_finalization_staged"}});assert.equal(mutations(m.calls).length,0);assert.equal(m.calls.some(x=>x.u.includes("api.aircall.io")&&x.o.method==="DELETE"),false);}finally{await r.close();}});
