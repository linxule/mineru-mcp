/** Durable single-writer standalone execution. Provider URLs/headers never enter the journal. */
import {mkdirSync,linkSync,readFileSync,writeFileSync,renameSync,existsSync,openSync,closeSync,fsyncSync,unlinkSync,lstatSync,rmSync,constants,fstatSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {canonicalHash} from './canonical.js';
import {sha256,DEFAULT_LIMITS} from './bundle/archive.js';
import {readRegular} from './bundle/manifest.js';
import {safeOutput,retainArchive} from './bundle/download.js';
import {createOperationBundle} from './bundle/operation_writer.js';
import {Transport,ProviderError,id} from './providers/transport.js';
import {V1Adapter} from './providers/v1.js';
import {V4Adapter} from './providers/v4.js';
import type {Adapter,Api,Request,Capabilities,Snapshot} from './providers/types.js';
export interface SubmitOptions {file?:string;url?:string;api?:Api;direct_url?:boolean;model?:string;tier?:string;pages?:string;output_dir:string;}
interface RecordData {version:1;operation_id:string;fingerprint:string;api:Api;endpoint:string;phase:string;state:string;created_at:string;updated_at:string;request:Request;source_sha256:string|null;output_dir:string;remote_id:string|null;remote_kind:string;upload_id:string|null;file_id:string|null;source_binding:string;outputs:Array<{id:string;format:string;path:string;sha256:string;size:number}>;missing:string[];remote_state:string;error:string|null;bundle_dir:string|null;attempts:number;next_attempt_at:number|null;cancelled:boolean;events:Array<{phase:string;at:string;code:string}>;capabilities:Capabilities;}
export interface OperationConfig {stateDir?:string;apiKey?:string;v4Endpoint?:string;v1Endpoint?:string;allowV1Execution?:boolean;adapterFactory?:(api:Api,endpoint:string)=>Adapter;clock?:()=>number;}
export class Operations {
 readonly root:string;private now:()=>number;
 constructor(private config:OperationConfig={}){this.root=safeOutput(config.stateDir??process.env.MINERU_STATE_DIR??join(homedir(),'.local','share','mineru-cloud'));this.now=config.clock??Date.now;safeOutput(join(this.root,'operations'));}
 private adapter(api:Api,endpoint?:string){const base=endpoint??(api==='v1'?(this.config.v1Endpoint??'https://mineru.net/api/v1'):(this.config.v4Endpoint??'https://mineru.net/api/v4'));return this.config.adapterFactory?.(api,base)??(api==='v1'?new V1Adapter(base,new Transport(base,this.config.apiKey)):new V4Adapter(base,new Transport(base,this.config.apiKey)));}
 private dir(operationId:string){if(!/^[a-f0-9]{64}$/.test(operationId))throw new ProviderError('invalid_operation_id');return join(this.root,'operations',operationId);}
 private read(operationId:string):RecordData {const path=join(this.dir(operationId),'operation.json');const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const st=fstatSync(fd);if(!st.isFile()||st.size>16*1024*1024)throw new ProviderError('invalid_journal');return JSON.parse(readFileSync(fd,'utf8'));}finally{closeSync(fd);}}
 private save(r:RecordData){r.updated_at=new Date(this.now()).toISOString();const dir=this.dir(r.operation_id),tmp=join(dir,`.journal-${randomUUID()}`);const fd=openSync(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,JSON.stringify(r));fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,join(dir,'operation.json'));const d=openSync(dir,'r');try{fsyncSync(d);}finally{closeSync(d);}}
 private phase(r:RecordData,phase:string,code='checkpoint'){if(r.phase!==phase)r.attempts=0;r.phase=phase;r.events.push({phase,at:new Date(this.now()).toISOString(),code});this.save(r);}
 private async locked<T>(fn:()=>Promise<T>):Promise<T>{
  const path=join(this.root,'writer.lock'),token=randomUUID(),candidate=join(this.root,`.owner-${token}`);
  const owner={pid:process.pid,token};const fd=openSync(candidate,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,JSON.stringify(owner));fsyncSync(fd);}finally{closeSync(fd);}
  let acquired=false;
  try{
   for(let attempt=0;attempt<2&&!acquired;attempt++){
    try{linkSync(candidate,path);acquired=true;break;}catch(error:any){if(error.code!=='EEXIST')throw error;}
    let old:any;try{old=JSON.parse(readFileSync(path,'utf8'));}catch{throw new ProviderError('operation_lock_recovery_required');}
    if(!Number.isSafeInteger(old.pid)||typeof old.token!=='string')throw new ProviderError('operation_lock_recovery_required');
    try{process.kill(old.pid,0);throw new ProviderError('operation_busy');}catch(error:any){if(error.code!=='ESRCH')throw new ProviderError('operation_busy');}
    // Serial reapers compare the original token again. An intervening new
    // owner cannot be unlinked by a delayed contender. An interrupted reaper
    // itself remains fail-closed for explicit operator inspection.
    const reaper=join(this.root,'recovery.lock');let guard:number;try{guard=openSync(reaper,'wx',0o600);}catch{throw new ProviderError('operation_lock_recovery_required');}
    try{const current=JSON.parse(readFileSync(path,'utf8'));if(current.token===old.token)unlinkSync(path);}catch(error:any){if(error.code!=='ENOENT')throw error;}finally{closeSync(guard);unlinkSync(reaper);}
   }
   if(!acquired)throw new ProviderError('operation_busy');return await fn();
  }finally{if(acquired){try{const current=JSON.parse(readFileSync(path,'utf8'));if(current.token===token)unlinkSync(path);}catch{}}unlinkSync(candidate);}
 }

 result(r:RecordData){return{ok:!['failed_terminal','reconciliation_required','needs_input'].includes(r.state),status:r.missing.length>0||r.remote_state==='partial'||['reconciliation_required','needs_input'].includes(r.state)?'partial':r.state==='failed_terminal'?'error':'ok',state:r.state,pollable:!r.cancelled&&['waiting_external','retry_scheduled','queued'].includes(r.state),operation_id:r.operation_id,phase:r.phase,remote_id:r.remote_id,remote_state:r.remote_state,source_sha256:r.source_sha256,source_binding:r.source_binding,outputs:r.outputs.map(({path,...output})=>output),missing_outputs:r.missing,bundle_dir:r.bundle_dir,error:r.error?{code:r.error,message:r.error}:null,warnings:!r.source_sha256?[{code:'direct_url_submission_uncertain',message:'No byte-verified source association; uncertain submission will not be repeated.'}]:[],meta:{extra:{contract:'mineru.execution.v1',capabilities:r.capabilities}}};}
 async capabilities(api:Api='v4',refresh=false){const adapter=this.adapter(api);const cache=join(this.root,`capabilities-${canonicalHash({api,endpoint:adapter.endpoint})}.json`);if(!refresh&&existsSync(cache))return JSON.parse(readFileSync(cache,'utf8'));const value=await adapter.capabilities(refresh);if(refresh)writeFileSync(cache,JSON.stringify(value),{mode:0o600});return value;}
 async submit(options:SubmitOptions){return this.locked(async()=>{
  if(Boolean(options.file)===Boolean(options.url)||options.direct_url&&!options.url)throw new ProviderError('invalid_source');const api=options.api??'v4';if(api==='v1'&&!this.config.allowV1Execution&&!this.config.adapterFactory)throw new ProviderError('hosted_v1_not_validated');
  const adapter=this.adapter(api);if(!this.config.adapterFactory&&!this.config.apiKey)throw new ProviderError('credentials_missing');if(api==='v1'&&(options.pages||options.model)||api==='v4'&&(options.tier||options.model&&!['pipeline','vlm'].includes(options.model)))throw new ProviderError('unsupported_capability');
  if(options.pages&&!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(options.pages))throw new ProviderError('invalid_page_ranges');
  let bytes:Buffer|null=null;if(options.file){bytes=await readRegular(resolve(options.file),DEFAULT_LIMITS.max_archive_bytes);}
  else if(!options.direct_url){const u=new URL(options.url!);bytes=await new Transport(u.origin).bytes(u.href);}
  if(bytes&&!bytes.subarray(0,8).toString('ascii').startsWith('%PDF-'))throw new ProviderError('unsupported_source_format');
  const caps=await adapter.capabilities(api==='v1');if(api==='v1'&&(!caps.sources?.includes(options.direct_url?'url':'file_id')||!options.tier||!caps.tiers?.includes(options.tier)))throw new ProviderError('unsupported_capability');
  const formats=api==='v4'?['zip']:(caps.formats??[]).filter(f=>['zip','markdown','md','json','content_list','images','html','layout','model'].includes(f));if(!formats.length)throw new ProviderError('unsupported_capability');
  const request:Request={sha256:bytes?sha256(bytes):'',size:bytes?.length??0,filename:'source.pdf',formats,...(options.model?{model:options.model}:{}),...(options.tier?{tier:options.tier}:{}),...(options.pages?{pages:options.pages}:{}),...(options.direct_url?{url:options.url}: {})};
  // URLs may contain private transport tokens: retain a digest for dedupe only.
  const fingerprint=canonicalHash({...request,url:options.direct_url?sha256(Buffer.from(options.url!)):null,endpoint:adapter.endpoint,api});const dir=this.dir(fingerprint);
  if(existsSync(join(dir,'operation.json')))return this.result(this.read(fingerprint));
  safeOutput(dir);if(bytes)writeFileSync(join(dir,'source.pdf'),bytes,{flag:'wx',mode:0o600});
  const r:RecordData={version:1,operation_id:fingerprint,fingerprint,api,endpoint:adapter.endpoint,phase:'preflight',state:'queued',created_at:new Date(this.now()).toISOString(),updated_at:'',request:{...request,url:undefined},source_sha256:bytes?sha256(bytes):null,output_dir:safeOutput(options.output_dir),remote_id:null,remote_kind:api==='v1'?'job':options.direct_url?'task':'batch',upload_id:null,file_id:null,source_binding:'unknown',outputs:[],missing:[],remote_state:'unknown',error:null,bundle_dir:null,attempts:0,next_attempt_at:null,cancelled:false,events:[],capabilities:caps};this.save(r);
  try{
   if(options.direct_url){this.phase(r,'submit_pending');r.remote_id=await adapter.submit(request);this.phase(r,'poll');}
   else{this.phase(r,'upload_prepare');const upload=await adapter.prepare(request);r.upload_id=upload.id;if(api==='v4')r.remote_id=upload.id;this.phase(r,'upload_transfer');
    if(upload.state!=='completed'){await adapter.transfer(upload,bytes!);r.source_binding='uploaded_exact_bytes';if(api==='v1'){this.phase(r,'upload_complete');const complete=await adapter.complete(upload.id);if(complete.state!=='completed'||!complete.fileId)throw new ProviderError('upload_incomplete',true);r.file_id=complete.fileId;}}
    else {r.file_id=upload.fileId??null;r.source_binding='caller_asserted';}
    if(api==='v1'){if(!r.file_id)throw new ProviderError('file_identity_missing',true);this.phase(r,'submit_pending');r.remote_id=await adapter.submit(request,r.file_id);}
    this.phase(r,'poll');
   }r.state='waiting_external';this.save(r);
  }catch(error){this.failure(r,error,true);}return this.result(r);
 });}
 private failure(r:RecordData,error:unknown,mutation=false){const code=error instanceof ProviderError?error.code:'local_operation_failed';r.error=code;
  if(['authentication_failed','credentials_missing','unsupported_capability'].includes(code)){r.state='needs_input';}else if(mutation){if(r.remote_id){r.phase='poll';r.state='waiting_external';}else if(r.upload_id&&['upload_transfer','upload_complete'].includes(r.phase)){r.state='waiting_external';}else{r.state='reconciliation_required';}}else{r.attempts++;r.state=r.attempts>=3?'needs_input':'retry_scheduled';const delay=error instanceof ProviderError&&error.retryAfter!==null?error.retryAfter:Math.min(60,5*2**(r.attempts-1));r.next_attempt_at=this.now()+delay*1000;}
  r.events.push({phase:r.phase,at:new Date(this.now()).toISOString(),code});this.save(r);
 }
 async status(operationId:string,refresh=false){if(refresh)return this.advance(operationId,true);return this.result(this.read(operationId));}
 async resume(operationId:string){return this.advance(operationId,false);}
 private async advance(operationId:string,pollOnly:boolean){return this.locked(async()=>{const r=this.read(operationId);if(r.cancelled||r.state==='succeeded'||r.state==='failed_terminal'||r.state==='reconciliation_required')return this.result(r);if(r.next_attempt_at&&r.next_attempt_at>this.now())return this.result(r);const a=this.adapter(r.api,r.endpoint);
  try{
   if(!this.config.adapterFactory&&!this.config.apiKey&&r.phase!=='finalize')throw new ProviderError('credentials_missing');
   if(!r.remote_id){if(r.api==='v1'&&r.upload_id&&['upload_transfer','upload_complete'].includes(r.phase)){const upload=await a.inspectUpload(r.upload_id);if(upload.state==='completed'&&upload.fileId){r.file_id=upload.fileId;if(pollOnly){r.state='queued';this.save(r);return this.result(r);}this.phase(r,'submit_pending');r.remote_id=await a.submit(r.request,r.file_id);r.phase='poll';}else{r.state='reconciliation_required';r.error='upload_outcome_uncertain';this.save(r);return this.result(r);}}else{r.state='reconciliation_required';r.error='submission_outcome_uncertain';this.save(r);return this.result(r);}}
   if(r.phase==='submit_pending'&&!r.remote_id){r.state='reconciliation_required';this.save(r);return this.result(r);}
   const snapshot:Snapshot=r.phase==='finalize'?{id:r.remote_id!,state:r.remote_state as Snapshot['state'],outputs:r.outputs.map(o=>({id:o.id,format:o.format})),missing:r.missing}:await a.status(r.remote_id!,r.remote_kind);r.remote_state=snapshot.state;r.next_attempt_at=null;
   if(['pending','running'].includes(snapshot.state)){r.state='waiting_external';r.phase='poll';r.attempts=0;if(this.now()-Date.parse(r.created_at)>86400000){r.state='needs_input';r.error='provider_wait_exceeded';}this.save(r);return this.result(r);}
   if(snapshot.state==='unknown'){r.state='needs_input';r.error='unknown_provider_state';this.save(r);return this.result(r);}
   if(pollOnly){r.state='waiting_external';this.save(r);return this.result(r);}
   if(r.phase!=='finalize')r.missing=[...new Set([...snapshot.missing,...r.request.formats.filter(format=>!snapshot.outputs.some(o=>o.format===format)).map(format=>`${format}:not_returned`)])];if(r.phase!=='finalize')this.phase(r,'download');for(const output of snapshot.outputs){const existing=r.outputs.find(x=>x.id===output.id);if(existing){const saved=readFileSync(join(this.dir(operationId),existing.path));if(sha256(saved)!==existing.sha256)throw new ProviderError('retained_output_changed');continue;}try{const bytes=await a.download(output);const digest=sha256(bytes),path=`output-${digest}`;if(!existsSync(join(this.dir(operationId),path)))writeFileSync(join(this.dir(operationId),path),bytes,{flag:'wx',mode:0o600});else if(sha256(readFileSync(join(this.dir(operationId),path)))!==digest)throw new ProviderError('retained_output_changed');r.outputs.push({id:output.id,format:output.format,path,sha256:digest,size:bytes.length});this.save(r);}catch(error){r.missing.push(`${output.format}:download_failed`);this.failure(r,error);return this.result(r);}}
   if(!r.outputs.length){r.state=snapshot.state==='cancelled'?'cancelled':'failed_terminal';r.error='no_retained_outputs';this.save(r);return this.result(r);}
   this.phase(r,'finalize');if(r.source_sha256){const bundle=await createOperationBundle({source:join(this.dir(operationId),'source.pdf'),outputs:r.outputs.map(o=>({...o,path:join(this.dir(operationId),o.path)})),output:r.output_dir,provider:{api:r.api,endpoint:r.endpoint,kind:r.remote_kind,id:r.remote_id!,binding:r.source_binding,request:r.request,terminal:snapshot.state,missing:r.missing}});r.bundle_dir=bundle.bundle_dir;}else{for(const output of r.outputs)if(output.format==='zip')await retainArchive(readFileSync(join(this.dir(operationId),output.path)),r.output_dir,`operation-${operationId}`);}
   r.state='succeeded';r.error=null;this.save(r);return this.result(r);
  }catch(error){this.failure(r,error,r.phase==='submit_pending');return this.result(r);}
 });}
 async cancel(operationId:string,remote=false){return this.locked(async()=>{const r=this.read(operationId);if(remote)throw new ProviderError('unsupported_capability');r.cancelled=true;r.state='cancelled';this.phase(r,r.phase,'local_cancel_only');return this.result(r);});}
 async bundle(operationId:string){const r=this.read(operationId);if(!r.bundle_dir)throw new ProviderError('bundle_not_ready');const {validateBundle}=await import('./bundle/validation.js');await validateBundle(r.bundle_dir);return this.result(r);}
}
