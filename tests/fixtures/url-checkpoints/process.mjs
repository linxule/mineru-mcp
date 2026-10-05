import assert from 'node:assert/strict';
import {appendFileSync,readFileSync,writeFileSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';

const [root,output,signal,mode,explicitUrl]=process.argv.slice(2);
const endpoint='https://service.example/api/v4',remoteId='synthetic-url-task';
const networkAttempts=[];
function denied(surface){return()=>{networkAttempts.push(surface);throw Object.assign(new Error('fixture_network_denied'),{code:'fixture_network_denied'});};}
// Install guards before loading production transport imports. The adapter below
// represents remote behavior with local files; every real network path is denied.
globalThis.fetch=denied('fetch');
for(const [name,module] of [['dns',dns],['dns/promises',dnsPromises]])for(const method of ['lookup','lookupService','resolve','resolve4','resolve6','resolveAny'])module[method]=denied(`${name}.${method}`);
for(const [name,module] of [['http',http],['https',https]])for(const method of ['request','get'])module[method]=denied(`${name}.${method}`);
net.connect=denied('net.connect');net.createConnection=denied('net.createConnection');net.Socket.prototype.connect=denied('net.Socket.connect');
tls.connect=denied('tls.connect');dgram.createSocket=denied('dgram.createSocket');
syncBuiltinESMExports();
const {Operations}=await import('../../../dist/operations.js');
const digest=value=>createHash('sha256').update(value).digest('hex');
const journal=id=>JSON.parse(readFileSync(`${root}/operations/${id}/operation.json`,'utf8'));
function persist(path,value,append=false){
 const bytes=JSON.stringify(value)+'\n';
 if(append)appendFileSync(path,bytes,{mode:0o600});else writeFileSync(path,bytes,{mode:0o600});
 const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
}
let operationId;
async function stop(boundary,extra={}){
 persist(signal,{boundary,operation_id:operationId,...extra});
 setInterval(()=>{},1000);await new Promise(()=>{});
}
function unexpected(call){persist(signal+'.accepted',{call},true);throw new Error(`unexpected_adapter_${call}`);}
const adapter={
 api:'v4',endpoint,
 capabilities:async()=>({api:'v4',endpoint,observed_at:null,validation:'fixture-only',sources:['url'],formats:['zip'],tiers:null,ranges:true,remote_cancel:false,lost_id_lookup:false}),
 submit:async request=>{
  assert.equal(typeof request.url,'string');
  assert.ok(operationId);
  const record=journal(operationId);
  assert.equal(record.phase,'submit_pending');assert.equal(record.remote_id,null);
  assert.equal(record.source_sha256,null);assert.ok(!Object.hasOwn(record.request,'url'));
  // Acceptance is outside the journal. Kill after this durable acknowledgement
  // but before the async submit call returns its ID to Operations.start().
  persist(signal+'.accepted',{call:'submit',operation_id:operationId,remote_id:remoteId,url_sha256:digest(request.url),source_sha256:request.sha256,size:request.size},true);
  if(mode==='crash-accepted')await stop('accepted_before_id',{remote_id:remoteId});
  return remoteId;
 },
 prepare:async()=>unexpected('prepare'),transfer:async()=>unexpected('transfer'),complete:async()=>unexpected('complete'),inspectUpload:async()=>unexpected('inspectUpload'),
 status:async()=>unexpected('status'),download:async()=>unexpected('download')
};
try{
 const ops=new Operations({stateDir:root,adapterFactory:()=>adapter,checkpoint:async(name,id)=>{operationId=id;if(mode==='crash-preflight'&&name==='intent_saved')await stop('durable_preflight');}});
 let result;
 if(['resume','status','refresh'].includes(mode)){
  operationId=JSON.parse(readFileSync(signal,'utf8')).operation_id;
  result=mode==='resume'?await ops.resume(operationId):await ops.status(operationId,mode==='refresh');
 }else if(['submit','crash-preflight','crash-accepted'].includes(mode)){
  if(mode==='submit')operationId=JSON.parse(readFileSync(signal,'utf8')).operation_id;
  assert.equal(typeof explicitUrl,'string','Submission needs a URL supplied to this process explicitly.');
  // No restart path reads a URL from disk or has a hardcoded source URL.
  result=await ops.submit({url:explicitUrl,direct_url:true,api:'v4',model:'vlm',pages:'1-2',output_dir:output});
 }else throw new Error('invalid_fixture_mode');
 process.stdout.write(JSON.stringify({result,networkAttempts}));
}catch(error){process.stdout.write(JSON.stringify({error:error.code??error.message,networkAttempts}));process.exitCode=1;}
