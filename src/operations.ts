/** Durable single-writer standalone execution. Provider URLs/headers never enter the journal. */
import {linkSync,readFileSync,writeFileSync,renameSync,existsSync,openSync,closeSync,fsyncSync,unlinkSync,readdirSync,constants,fstatSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {canonicalHash} from './canonical.js';
import {sha256,DEFAULT_LIMITS} from './bundle/archive.js';
import {readRegular} from './bundle/manifest.js';
import {safeOutput,retainArchive} from './bundle/download.js';
import {createOperationBundle} from './bundle/operation_writer.js';
import {Transport,ProviderError} from './providers/transport.js';
import {V1Adapter} from './providers/v1.js';
import {V4Adapter} from './providers/v4.js';
import {parsePageRanges} from './providers/page_ranges.js';
import type {Adapter,Api,Request,Capabilities,Snapshot,Output,OutputUnavailable,UnavailableReason} from './providers/types.js';
export interface SubmitOptions {file?:string;url?:string;api?:Api;direct_url?:boolean;model?:string;tier?:string;pages?:string;output_dir:string;}
type RetainedOutput={id:string;format:string;path:string;sha256:string;size:number};
interface RecordData {version:1;operation_id:string;fingerprint:string;api:Api;endpoint:string;phase:string;state:string;created_at:string;updated_at:string;request:Request;source_sha256:string|null;output_dir:string;remote_id:string|null;remote_kind:string;upload_id:string|null;file_id:string|null;source_binding:string;outputs:RetainedOutput[];missing:string[];unavailable:OutputUnavailable[];expected_outputs:Array<Pick<Output,'id'|'format'|'fileId'>>;remote_state:string;error:string|null;bundle_dir:string|null;bundle_manifest_sha256:string|null;bundle_history:string[];bundle_receipts:Array<{bundle_dir:string;manifest_sha256:string}>;attempts:number;next_attempt_at:number|null;cancelled:boolean;events:Array<{phase:string;at:string;code:string}>;capabilities:Capabilities;}
export type OperationCheckpoint='source_retained'|'intent_saved'|'outputs_retained'|'bundle_adopted';
export interface OperationConfig {stateDir?:string;apiKey?:string;v4Endpoint?:string;v1Endpoint?:string;allowV1Execution?:boolean;adapterFactory?:(api:Api,endpoint:string)=>Adapter;clock?:()=>number;/** Test/embedding hook after a real persisted boundary; never configured from the CLI/environment. */checkpoint?:(name:OperationCheckpoint,operationId:string)=>Promise<void>|void;}
const unavailableReasons=new Set<UnavailableReason>(['download_failed','expired','limit_exceeded','not_returned','unsupported_format','cancelled','unknown']);
function role(format:string){return ['markdown','md'].includes(format)?'markdown':['json','content_list'].includes(format)?'structured_json':format==='images'?'image':'unknown';}
function fromLegacy(value:string):OutputUnavailable {const [format,...tail]=value.split(':'),reason=tail.at(-1) as UnavailableReason;return{role:role(format),format,file_id:null,reason:unavailableReasons.has(reason)?reason:'unknown',cause:unavailableReasons.has(reason)?reason:'provider_output_unavailable',retry:'explicit',attempts:0};}
function missingKey(value:OutputUnavailable){return `${value.format}\0${value.file_id??''}`;}
function uniqueUnavailable(values:OutputUnavailable[]){return [...new Map(values.map(value=>[missingKey(value),value])).values()];}
function syncDirectory(path:string){const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{if(!fstatSync(fd).isDirectory())throw new ProviderError('invalid_state_directory');fsyncSync(fd);}finally{closeSync(fd);}}
function readBytes(path:string){const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const st=fstatSync(fd);if(!st.isFile()||st.size>DEFAULT_LIMITS.max_archive_bytes)throw new ProviderError('invalid_retained_file');return readFileSync(fd);}finally{closeSync(fd);}}
/** File data and its directory entry precede any journal that references them. */
function retainBytes(path:string,bytes:Buffer){
 if(existsSync(path)){const saved=readBytes(path);if(saved.length!==bytes.length||sha256(saved)!==sha256(bytes))throw new ProviderError('retained_output_changed');const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}syncDirectory(dirname(path));return;}
 const tmp=join(dirname(path),`.retained-${randomUUID()}`),fd=openSync(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
 try{linkSync(tmp,path);syncDirectory(dirname(path));}finally{unlinkSync(tmp);syncDirectory(dirname(path));}
}
const localIntegrityCodes=new Set(['source_hash_mismatch','output_hash_mismatch','bundle_identity_mismatch','bundle_lineage_mismatch','predecessor_identity_mismatch','predecessor_manifest_changed','retained_bundle_changed','bundle_limit_exceeded','unsafe_path','input_changed','invalid_bundle','artifact_hash_mismatch']);
export function operationErrorCode(error:unknown):string {if(error instanceof ProviderError)return error.code;const code=(error as {code?:unknown})?.code;return typeof code==='string'&&localIntegrityCodes.has(code)?code:'local_operation_failed';}
export function structuredError(code:string,suggestion:string|null=null,retriable=false){return{code,message:code,field:null,expected:null,actual:null,suggestion,doc_url:null,retriable};}
/** Additive envelope: historical top-level data aliases remain readable. */
export function executionResult(value:any,operation:string){
 const status=value.status==='partial'||value.status==='error'?value.status:'ok';
 const data=value.data??Object.fromEntries(Object.entries(value).filter(([key])=>!['status','ok','errors','warnings','meta','error'].includes(key)));
 const warnings=(value.warnings??[]).map((warning:any)=>typeof warning==='string'?warning:warning.message??String(warning.code));
 const warningCodes=(value.warnings??[]).map((warning:any)=>typeof warning==='string'?'legacy_warning':warning.code??'legacy_warning');
 return{...value,ok:status!=='error',status,data,errors:value.errors??(value.error?[{...structuredError(value.error.code,value.recovery?.next_actions?.[0]?.reason??null,value.recovery?.retry_safe??false),...value.error}]:[]),warnings,meta:{...(value.meta??{}),extra:{...(value.meta?.extra??{}),contract:'mineru.execution.v1',operation,warning_codes:value.meta?.extra?.warning_codes??warningCodes}}};
}
export class Operations {
 readonly root:string;private now:()=>number;
 constructor(private config:OperationConfig={}){this.root=safeOutput(config.stateDir??process.env.MINERU_STATE_DIR??join(homedir(),'.local','share','mineru-cloud'));this.now=config.clock??Date.now;safeOutput(join(this.root,'operations'));syncDirectory(this.root);syncDirectory(dirname(this.root));}
 private adapter(api:Api,endpoint?:string){const base=endpoint??(api==='v1'?(this.config.v1Endpoint??'https://mineru.net/api/v1'):(this.config.v4Endpoint??'https://mineru.net/api/v4'));return this.config.adapterFactory?.(api,base)??(api==='v1'?new V1Adapter(base,new Transport(base,this.config.apiKey)):new V4Adapter(base,new Transport(base,this.config.apiKey)));}
 private dir(operationId:string){if(!/^[a-f0-9]{64}$/.test(operationId))throw new ProviderError('invalid_operation_id');return join(this.root,'operations',operationId);}
 private read(operationId:string):RecordData {
  const path=join(this.dir(operationId),'operation.json');let fd:number;try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(error:any){if(error.code==='ENOENT')throw new ProviderError('operation_not_found');throw error;}
  try{const st=fstatSync(fd);if(!st.isFile()||st.size>16*1024*1024)throw new ProviderError('invalid_journal');const r=JSON.parse(readFileSync(fd,'utf8')) as RecordData;if(r.operation_id!==operationId||r.fingerprint!==operationId||r.version!==1)throw new ProviderError('invalid_journal');r.unavailable??=(r.missing??[]).map(fromLegacy);r.expected_outputs??=[];r.bundle_history??=r.bundle_dir?[r.bundle_dir]:[];r.bundle_manifest_sha256??=null;r.bundle_receipts??=[];return r;}finally{closeSync(fd);}
 }
 private save(r:RecordData){r.updated_at=new Date(this.now()).toISOString();r.missing=r.unavailable.map(value=>`${value.format}:${value.reason}`);const dir=this.dir(r.operation_id),tmp=join(dir,`.journal-${randomUUID()}`);const fd=openSync(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,JSON.stringify(r));fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,join(dir,'operation.json'));syncDirectory(dir);syncDirectory(dirname(dir));}
 private phase(r:RecordData,phase:string,code='checkpoint'){if(r.phase!==phase)r.attempts=0;r.phase=phase;r.events.push({phase,at:new Date(this.now()).toISOString(),code});this.save(r);}
 private checkpoint(name:OperationCheckpoint,r:Pick<RecordData,'operation_id'>){return this.config.checkpoint?.(name,r.operation_id);}
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
    // Serial reapers compare the original token again. An interrupted reaper
    // remains fail-closed for explicit operator inspection.
    const reaper=join(this.root,'recovery.lock');let guard:number;try{guard=openSync(reaper,'wx',0o600);}catch{throw new ProviderError('operation_lock_recovery_required');}
    try{const current=JSON.parse(readFileSync(path,'utf8'));if(current.token===old.token)unlinkSync(path);}catch(error:any){if(error.code!=='ENOENT')throw error;}finally{closeSync(guard);unlinkSync(reaper);}
   }
   if(!acquired)throw new ProviderError('operation_busy');return await fn();
  }finally{if(acquired){try{const current=JSON.parse(readFileSync(path,'utf8'));if(current.token===token)unlinkSync(path);}catch{}}unlinkSync(candidate);}
 }
 result(r:RecordData){
  const uncertain=r.state==='reconciliation_required',attention=uncertain||r.state==='needs_input';
  const next:Array<{action:string;reason:string;command?:string}>=[];
  if(r.bundle_dir)next.push({action:'bundle',reason:'Validate and export the retained immutable bundle.',command:`mineru-cloud bundle --operation-id ${r.operation_id} --json`});
  if(['authentication_failed','credentials_missing'].includes(r.error??''))next.push({action:'configure_credentials',reason:'Configure valid MinerU credentials, then resume this recorded operation.'});
  if(['bundle_identity_mismatch','bundle_lineage_mismatch','predecessor_identity_mismatch','predecessor_manifest_changed','retained_bundle_changed'].includes(r.error??''))next.push({action:'restore_artifacts',reason:'Preserve the conflicting files for inspection and restore the recorded immutable bundle before resuming.'});
  if(r.error==='retained_source_changed')next.push({action:'restore_source',reason:`Restore the managed source bytes matching SHA-256 ${r.source_sha256}; resume verifies them before upload.`});
  if(uncertain)next.push({action:'inspect_provider',reason:'Inspect the provider using the known IDs. The submission outcome is uncertain; no automated resubmission or local ID-association command is available.'});
  else if(!r.cancelled&&(r.state!=='succeeded'||r.unavailable.length))next.push({action:'resume',reason:r.bundle_dir?'Retry unavailable outputs on this operation; successful retained outputs and earlier bundles remain unchanged.':r.upload_id&&!r.remote_id?'Inspect the known upload before proceeding; do not allocate it again.':'Continue this recorded operation without starting another parse.',command:`mineru-cloud resume --operation-id ${r.operation_id} --json`});
  const status=r.state==='failed_terminal'?'error':r.unavailable.length||r.remote_state==='partial'||attention?'partial':'ok';
  return{ok:status!=='error',status,state:r.state,pollable:!r.cancelled&&['waiting_external','retry_scheduled','queued'].includes(r.state),operation_id:r.operation_id,phase:r.phase,remote_id:r.remote_id,remote_state:r.remote_state,source_sha256:r.source_sha256,source_binding:r.source_binding,outputs:r.outputs.map(({path,...output})=>output),missing_outputs:r.missing,outputs_unavailable:r.unavailable,bundle_dir:r.bundle_dir,bundle_manifest_sha256:r.bundle_manifest_sha256,bundle_history:r.bundle_history,bundle_receipts:r.bundle_receipts,error:r.error?{code:r.error,message:r.error}:null,recovery:{attention_required:attention,cause:r.error?{code:r.error,phase:r.phase}:null,retry_safe:!uncertain&&!r.cancelled,submission_outcome:uncertain?'uncertain':r.remote_id?'known':r.phase==='preflight'?'not_started':'known_upload',known_evidence:{output_dir:r.output_dir,bundle_manifest_sha256:r.bundle_manifest_sha256,source_sha256:r.source_sha256,source_binding:r.source_binding,upload_id:r.upload_id,file_id:r.file_id,remote_id:r.remote_id,retained_output_count:r.outputs.length,bundle_count:r.bundle_history.length},allowance:{tracking:'unsupported'},next_attempt_at:r.next_attempt_at,next_actions:next},warnings:[...(!r.source_sha256?[{code:'direct_url_submission_uncertain',message:'No byte-verified source association; uncertain submission will not be repeated.'}]:[]),...(r.unavailable.length?[{code:'output_unavailable',message:'Some requested outputs are unavailable; successful retained outputs remain usable.'}]:[])],meta:{extra:{contract:'mineru.execution.v1',capabilities:r.capabilities}}};
 }
 async capabilities(api:Api='v4',refresh=false){const adapter=this.adapter(api);const cache=join(this.root,`capabilities-${canonicalHash({api,endpoint:adapter.endpoint})}.json`);if(!refresh&&existsSync(cache))return JSON.parse(readFileSync(cache,'utf8'));const value=await adapter.capabilities(refresh);if(refresh)writeFileSync(cache,JSON.stringify(value),{mode:0o600});return value;}
 async submit(options:SubmitOptions){return this.locked(async()=>{
  if(Boolean(options.file)===Boolean(options.url)||options.direct_url&&!options.url)throw new ProviderError('invalid_source');const api=options.api??'v4';if(api==='v1'&&!this.config.allowV1Execution&&!this.config.adapterFactory)throw new ProviderError('hosted_v1_not_validated');
  if(api==='v1'&&(options.pages||options.model)||api==='v4'&&(options.tier||options.model&&!['pipeline','vlm'].includes(options.model)))throw new ProviderError('unsupported_capability');
  parsePageRanges(options.pages);
  const adapter=this.adapter(api);if(!this.config.adapterFactory&&!this.config.apiKey)throw new ProviderError('credentials_missing');
  // Validate the destination before source acquisition, capability discovery,
  // or creation of an operation directory.
  const outputDir=safeOutput(options.output_dir);
  let bytes:Buffer|null=null;if(options.file){bytes=await readRegular(resolve(options.file),DEFAULT_LIMITS.max_archive_bytes);}
  else if(!options.direct_url){const u=new URL(options.url!);bytes=await new Transport(u.origin).bytes(u.href);}
  if(bytes&&!bytes.subarray(0,8).toString('ascii').startsWith('%PDF-'))throw new ProviderError('unsupported_source_format');
  const caps=await adapter.capabilities(api==='v1');if(api==='v1'&&(!caps.sources?.includes(options.direct_url?'url':'file_id')||!options.tier||!caps.tiers?.includes(options.tier)))throw new ProviderError('unsupported_capability');
  const formats=api==='v4'?['zip']:(caps.formats??[]).filter(f=>['zip','markdown','md','json','content_list','images','html','layout','model'].includes(f));if(!formats.length)throw new ProviderError('unsupported_capability');
  const request:Request={sha256:bytes?sha256(bytes):'',size:bytes?.length??0,filename:'source.pdf',formats,...(options.model?{model:options.model}:{}),...(options.tier?{tier:options.tier}:{}),...(options.pages?{pages:options.pages}:{}),...(options.direct_url?{url:options.url}: {})};
  // URLs may contain private transport tokens: retain a digest for dedupe only.
  const fingerprint=canonicalHash({...request,url:options.direct_url?sha256(Buffer.from(options.url!)):null,endpoint:adapter.endpoint,api});const dir=this.dir(fingerprint);
  if(existsSync(join(dir,'operation.json'))){const r=this.read(fingerprint);if(r.phase==='preflight'&&!r.cancelled){await this.start(r,adapter,request,bytes);return this.result(r);}return this.result(r);}
  safeOutput(dir);syncDirectory(dirname(dir));
  // No provider mutation can occur without a synced journal. A pre-journal
  // orphan may contain only the exact source and our unfinished local writes.
  // Foreign evidence is never deleted or silently adopted.
  const entries=readdirSync(dir);if(entries.some(name=>name!=='source.pdf'&&!/^\.(retained|journal)-[a-f0-9-]+$/.test(name)))throw new ProviderError('orphan_recovery_required');
  for(const name of entries.filter(name=>name.startsWith('.'))){
   const retained=readBytes(join(dir,name));
   if(name.startsWith('.retained-')){if(!bytes||retained.length>bytes.length||!retained.equals(bytes.subarray(0,retained.length)))throw new ProviderError('orphan_recovery_required');}
   else{let intent:any;try{intent=JSON.parse(retained.toString('utf8'));}catch{throw new ProviderError('orphan_recovery_required');}if(intent.operation_id!==fingerprint||intent.phase!=='preflight'||intent.remote_id||intent.upload_id||intent.outputs?.length)throw new ProviderError('orphan_recovery_required');}
  }
  if(existsSync(join(dir,'source.pdf'))){if(!bytes||sha256(readBytes(join(dir,'source.pdf')))!==request.sha256)throw new ProviderError('orphan_source_mismatch');}
  if(bytes)retainBytes(join(dir,'source.pdf'),bytes);
  await this.checkpoint('source_retained',{operation_id:fingerprint});
  const r:RecordData={version:1,operation_id:fingerprint,fingerprint,api,endpoint:adapter.endpoint,phase:'preflight',state:'queued',created_at:new Date(this.now()).toISOString(),updated_at:'',request:{...request,url:undefined},source_sha256:bytes?sha256(bytes):null,output_dir:outputDir,remote_id:null,remote_kind:api==='v1'?'job':options.direct_url?'task':'batch',upload_id:null,file_id:null,source_binding:'unknown',outputs:[],missing:[],unavailable:[],expected_outputs:[],remote_state:'unknown',error:null,bundle_dir:null,bundle_manifest_sha256:null,bundle_history:[],bundle_receipts:[],attempts:0,next_attempt_at:null,cancelled:false,events:[],capabilities:caps};this.save(r);await this.checkpoint('intent_saved',r);
  await this.start(r,adapter,request,bytes);return this.result(r);
 });}
 private async start(r:RecordData,adapter:Adapter,request:Request,bytes:Buffer|null){
  try{
   if(r.source_sha256&&(!bytes||sha256(bytes)!==r.source_sha256||bytes.length!==r.request.size))throw new ProviderError('retained_source_changed');
   if(r.remote_kind==='task'||r.source_sha256===null){if(!request.url){r.state='needs_input';r.error='source_url_required';this.save(r);return;}this.phase(r,'submit_pending');r.remote_id=await adapter.submit(request);this.phase(r,'poll');}
   else{this.phase(r,'upload_prepare');const upload=await adapter.prepare(request);r.upload_id=upload.id;if(r.api==='v4')r.remote_id=upload.id;this.phase(r,'upload_transfer');
    if(upload.state!=='completed'){await adapter.transfer(upload,bytes!);r.source_binding='uploaded_exact_bytes';if(r.api==='v1'){this.phase(r,'upload_complete');const complete=await adapter.complete(upload.id,request);if(complete.id!==upload.id)throw new ProviderError('upload_identity_mismatch',true);if(complete.state!=='completed'||!complete.fileId)throw new ProviderError('upload_incomplete',true);r.file_id=complete.fileId;}}
    else{r.file_id=upload.fileId??null;r.source_binding='caller_asserted';}
    if(r.api==='v1'){if(!r.file_id)throw new ProviderError('file_identity_missing',true);this.phase(r,'submit_pending');r.remote_id=await adapter.submit(request,r.file_id);}
    this.phase(r,'poll');
   }r.state='waiting_external';r.error=null;this.save(r);
  }catch(error){this.failure(r,error,true);}
 }
 private failure(r:RecordData,error:unknown,mutation=false){const code=operationErrorCode(error);r.error=code;
  if(['identity_mismatch','input_identity_mismatch','upload_identity_mismatch','upload_source_mismatch'].includes(code)){r.state='reconciliation_required';}
  else if(localIntegrityCodes.has(code)||['authentication_failed','credentials_missing','unsupported_capability','retained_source_changed','invalid_page_ranges'].includes(code)){r.state='needs_input';if(code==='invalid_page_ranges')r.next_attempt_at=null;}
  else if(mutation){if(r.remote_id){r.phase='poll';r.state='waiting_external';}else if(r.upload_id&&['upload_transfer','upload_complete'].includes(r.phase)){r.state='waiting_external';}else{r.state='reconciliation_required';}}
  else{r.attempts++;r.state=r.attempts>=3?'needs_input':'retry_scheduled';const delay=error instanceof ProviderError&&error.retryAfter!==null?error.retryAfter:Math.min(60,5*2**(r.attempts-1));r.next_attempt_at=r.state==='needs_input'?null:this.now()+delay*1000;}
  r.events.push({phase:r.phase,at:new Date(this.now()).toISOString(),code});this.save(r);
 }
 async status(operationId:string,refresh=false){if(refresh)return this.advance(operationId,true);return this.result(this.read(operationId));}
 async resume(operationId:string){return this.advance(operationId,false);}
 private outputReady(r:RecordData){return r.expected_outputs.length>0&&r.expected_outputs.every(expected=>r.outputs.some(output=>output.id===expected.id&&output.format===expected.format)||r.unavailable.some(value=>value.file_id===(expected.fileId??expected.id)&&value.format===expected.format&&value.attempts>=3));}
 private async finalize(r:RecordData){
  if(!r.outputs.length){r.state=r.unavailable.some(value=>value.attempts)?'needs_input':r.remote_state==='cancelled'?'cancelled':'failed_terminal';r.error='no_retained_outputs';this.save(r);return;}
  this.phase(r,'finalize');
  if(r.source_sha256){const bundle=await createOperationBundle({source:join(this.dir(r.operation_id),'source.pdf'),outputs:r.outputs.map(output=>({...output,path:join(this.dir(r.operation_id),output.path)})),output:r.output_dir,predecessor:r.bundle_dir,predecessorManifestSha256:r.bundle_manifest_sha256,provider:{api:r.api,endpoint:r.endpoint,kind:r.remote_kind,id:r.remote_id!,binding:r.source_binding,request:r.request,terminal:r.remote_state,missing:r.missing,unavailable:r.unavailable}});r.bundle_dir=bundle.bundle_dir;r.bundle_manifest_sha256=bundle.manifest_sha256;if(!r.bundle_receipts.some(receipt=>receipt.bundle_dir===bundle.bundle_dir))r.bundle_receipts.push(bundle);if(!r.bundle_history.includes(bundle.bundle_dir))r.bundle_history.push(bundle.bundle_dir);}
  else{for(const output of r.outputs)if(output.format==='zip')await retainArchive(readBytes(join(this.dir(r.operation_id),output.path)),r.output_dir,`operation-${r.operation_id}`);}
  await this.checkpoint('bundle_adopted',r);
  const failures=r.unavailable.filter(value=>value.attempts>0);r.state=failures.length?'needs_input':'succeeded';r.error=failures[0]?.cause??null;r.next_attempt_at=null;this.save(r);
 }
 private async advance(operationId:string,pollOnly:boolean){return this.locked(async()=>{
  const r=this.read(operationId);if(r.cancelled||r.state==='failed_terminal'||r.state==='reconciliation_required'||r.state==='succeeded'&&!r.unavailable.length)return this.result(r);
  if(r.next_attempt_at&&r.next_attempt_at>this.now())return this.result(r);
  try{
   // The complete retained-output plan makes this recovery boundary offline,
   // including death after the last output save but before phase=finalize.
   const legacyAdmissionRecovery=r.state==='needs_input'&&r.error==='invalid_page_ranges';
   if(!pollOnly&&(r.phase==='finalize'||r.phase==='download'&&this.outputReady(r))&&(r.state!=='needs_input'||legacyAdmissionRecovery)&&r.state!=='succeeded'){await this.finalize(r);return this.result(r);}
   // Exact local legacy receipt adoption above may retain a selector no longer
   // admitted for new work. It never authorizes another provider action.
   parsePageRanges(r.request.pages);const a=this.adapter(r.api,r.endpoint);
   if(!this.config.adapterFactory&&!this.config.apiKey)throw new ProviderError('credentials_missing');
   if(r.phase==='preflight'){if(pollOnly)return this.result(r);await this.start(r,a,r.request,r.source_sha256?readBytes(join(this.dir(operationId),'source.pdf')):null);return this.result(r);}
   if(!r.remote_id){
    if(r.api==='v1'&&r.upload_id&&['upload_transfer','upload_complete'].includes(r.phase)){
     const upload=await a.inspectUpload(r.upload_id,r.request);if(upload.id!==r.upload_id)throw new ProviderError('upload_identity_mismatch',true);
     if(upload.state==='completed'&&upload.fileId){r.file_id=upload.fileId;if(pollOnly){r.state='queued';this.save(r);return this.result(r);}this.phase(r,'submit_pending');r.remote_id=await a.submit(r.request,r.file_id);this.phase(r,'poll');}
     else{r.state='reconciliation_required';r.error='upload_outcome_uncertain';this.save(r);return this.result(r);}
    }else{r.state='reconciliation_required';r.error='submission_outcome_uncertain';this.save(r);return this.result(r);}
   }
   const snapshot=await a.status(r.remote_id!,r.remote_kind,{fileId:r.file_id??undefined,sha256:r.source_sha256??undefined});r.remote_state=snapshot.state;r.next_attempt_at=null;
   if(['pending','running'].includes(snapshot.state)){r.state='waiting_external';r.phase='poll';r.attempts=0;if(this.now()-Date.parse(r.created_at)>86400000){r.state='needs_input';r.error='provider_wait_exceeded';}this.save(r);return this.result(r);}
   if(snapshot.state==='unknown'){r.state='needs_input';r.error='unknown_provider_state';this.save(r);return this.result(r);}
   if(pollOnly){if(!r.bundle_dir)r.state='waiting_external';this.save(r);return this.result(r);}
   const previous=r.unavailable,advertised=new Set(snapshot.outputs.map(output=>`${output.format}\0${output.fileId??output.id}`));
   r.unavailable=uniqueUnavailable([...(snapshot.unavailable??snapshot.missing.map(fromLegacy)),...r.request.formats.filter(format=>!snapshot.outputs.some(output=>output.format===format)&&!r.outputs.some(output=>output.format===format)).map(format=>fromLegacy(`${format}:not_returned`)),...previous.filter(value=>advertised.has(missingKey(value))&&!r.outputs.some(output=>output.id===value.file_id&&output.format===value.format))]);
   r.expected_outputs=snapshot.outputs.map(({id,format,fileId})=>({id,format,...(fileId?{fileId}:{})}));r.state='waiting_external';this.phase(r,'download');
   let failures=false;let retryAfter=0;
   for(const output of snapshot.outputs){
    const existing=r.outputs.find(value=>value.id===output.id&&value.format===output.format);
    if(existing){const saved=readBytes(join(this.dir(operationId),existing.path));if(sha256(saved)!==existing.sha256||saved.length!==existing.size)throw new ProviderError('retained_output_changed');continue;}
    const key=`${output.format}\0${output.fileId??output.id}`,prior=previous.find(value=>missingKey(value)===key);
    try{const bytes=await a.download(output),digest=sha256(bytes),path=`output-${digest}`;retainBytes(join(this.dir(operationId),path),bytes);r.outputs.push({id:output.id,format:output.format,path,sha256:digest,size:bytes.length});r.unavailable=r.unavailable.filter(value=>missingKey(value)!==key);this.save(r);}
    catch(error){failures=true;const cause=operationErrorCode(error),attempts=(prior?.attempts??0)+1;const reason:UnavailableReason=cause==='output_expired'?'expired':cause==='limit_exceeded'?'limit_exceeded':'download_failed';r.unavailable=r.unavailable.filter(value=>missingKey(value)!==key);r.unavailable.push({role:role(output.format),format:output.format,file_id:output.fileId??output.id,reason,cause,retry:attempts>=3?'explicit':'automatic',attempts});r.error=cause;retryAfter=Math.max(retryAfter,error instanceof ProviderError?error.retryAfter??0:0);r.events.push({phase:'download',at:new Date(this.now()).toISOString(),code:cause});this.save(r);}
   }
   const retryable=r.unavailable.filter(value=>value.attempts>0&&value.attempts<3);
   if(failures&&retryable.length){r.attempts=Math.max(...retryable.map(value=>value.attempts));r.state='retry_scheduled';r.next_attempt_at=this.now()+Math.max(retryAfter,Math.min(60,5*2**(r.attempts-1)))*1000;this.save(r);return this.result(r);}
   await this.checkpoint('outputs_retained',r);await this.finalize(r);return this.result(r);
  }catch(error){this.failure(r,error,r.phase==='submit_pending');return this.result(r);}
 });}
 async cancel(operationId:string,remote=false){return this.locked(async()=>{const r=this.read(operationId);if(remote)throw new ProviderError('unsupported_capability');r.cancelled=true;r.state='cancelled';this.phase(r,r.phase,'local_cancel_only');return this.result(r);});}
 async bundle(operationId:string){const r=this.read(operationId);if(!r.bundle_dir)throw new ProviderError('bundle_not_ready');const {validateBundle}=await import('./bundle/validation.js');const verified=await validateBundle(r.bundle_dir);if(r.bundle_manifest_sha256&&verified.manifest_sha256!==r.bundle_manifest_sha256)throw new ProviderError('retained_bundle_changed');return this.result(r);}
}
