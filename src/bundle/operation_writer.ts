import {readFileSync,writeFileSync,mkdirSync,renameSync,existsSync,rmSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {VERSION} from '../version.js';
import {canonicalHash} from '../canonical.js';
import {inspectZip,sha256,DEFAULT_LIMITS,roleFor} from './archive.js';
import {safeOutput} from './download.js';
import {validateManifest,validateBundle} from './validation.js';
import type {Request} from '../providers/types.js';
interface Input {source:string;outputs:Array<{id:string;format:string;path:string;sha256:string;size:number}>;output:string;provider:{api:'v1'|'v4';endpoint:string;kind:string;id:string;binding:string;request:Request;terminal:string;missing:string[]};}
/** Internal writer only: provenance comes from the persisted operation, never CLI assertions. */
export async function createOperationBundle(input:Input){
 const source=readFileSync(input.source),sourceHash=sha256(source),p=input.provider;
 if(sourceHash!==p.request.sha256)throw new Error('source_hash_mismatch');
 const root=safeOutput(input.output),identity=canonicalHash({source:sourceHash,provider:{api:p.api,endpoint:p.endpoint,kind:p.kind,id:p.id},outputs:input.outputs.map(o=>[o.id,o.sha256]),missing:p.missing}),destination=join(root,`bundle-${identity}`);
 if(existsSync(destination)){await validateBundle(destination);return{bundle_dir:destination};}
 const stage=join(root,`.operation-bundle-${randomUUID()}`);mkdirSync(stage,{mode:0o700});
 const file=(path:string,bytes:Buffer,media_type:string)=>({path,sha256:sha256(bytes),size_bytes:bytes.length,media_type});
 try{mkdirSync(join(stage,'source'));mkdirSync(join(stage,'archives'));mkdirSync(join(stage,'provider-files'));writeFileSync(join(stage,'source/source.pdf'),source,{flag:'wx',mode:0o600});
  const archives:any[]=[],providerFiles:any[]=[];let total=0;
  for(const [index,o] of input.outputs.entries()){const bytes=readFileSync(o.path);if(sha256(bytes)!==o.sha256||bytes.length!==o.size)throw new Error('output_hash_mismatch');const archive=o.format==='zip'||bytes.subarray(0,4).equals(Buffer.from([80,75,3,4]));
   if(archive){const inventory=await inspectZip(bytes);total+=inventory.members.reduce((n,m)=>n+m.size_bytes,0);const path=`archives/${o.sha256}.zip`;if(!existsSync(join(stage,path)))writeFileSync(join(stage,path),bytes,{flag:'wx',mode:0o600});archives.push({artifact_id:`output-${index}`,file:file(path,bytes,'application/zip'),inventory_status:'complete',members:inventory.members,file_id:o.id});}
   else{total+=bytes.length;const path=`provider-files/${index}-${o.sha256}`;if(!existsSync(join(stage,path)))writeFileSync(join(stage,path),bytes,{flag:'wx',mode:0o600});const media=o.format==='markdown'||o.format==='md'?{role:'markdown',media_type:'text/markdown'}:o.format==='json'||o.format==='content_list'?{role:'structured_json',media_type:'application/json'}:roleFor(o.format);providerFiles.push({artifact_id:`output-${index}`,file:file(path,bytes,media.media_type),role:media.role,format_schema:null,format_version:null,file_id:o.id});}
   if(total>DEFAULT_LIMITS.max_total_uncompressed_bytes)throw new Error('bundle_limit_exceeded');
  }
  const ranges=()=>({ranges:[],basis:'unknown',evidence:[]});
  const manifest={schema:'scholia.artifact-bundle',schema_version:'1.0.1',created_at:new Date().toISOString(),producer:{name:'mineru-mcp',version:VERSION},source:{sha256:sourceHash,size_bytes:source.length,media_type:'application/pdf',original_filename:null,page_count:null,file:file('source/source.pdf',source,'application/pdf'),absence_reason:null,origin:null},provider:{name:'mineru',api_generation:p.api,endpoint_origin:new URL(p.endpoint).protocol==='https:'?new URL(p.endpoint).origin:null,operation:{kind:p.kind,operation_id:p.id,file_id:null,client_data_id:p.api==='v4'?sourceHash:null,terminal_state:p.terminal},request:{model:p.request.model??null,tier:p.request.tier??null,parser_version:null,options:{output_formats:p.request.formats,...(p.request.pages?{page_ranges:p.request.pages}:{})}},reported:{model:null,model_version:null,tier:null,parser_version:null},source_binding:{method:p.binding,evidence:'Exact source bytes were retained and transferred by the durable local operation.'},outputs_unavailable:p.missing.map(format=>({role:'unknown',format:format.split(':')[0],file_id:null,reason:'not_returned'}))},coverage:{status:'unknown',requested:{scope:'unknown',ranges:[]},completed:ranges(),missing:ranges(),unknown:{ranges:[],reason:'No validated PDF page coverage is established.'},source_complete:null},archives,provider_files:providerFiles,materializations:[],validation_limits:DEFAULT_LIMITS,warnings:[{code:'unknown_page_provenance',message:'Output retention does not establish PDF page positions or full document coverage.'}],legacy_receipts:[],predecessor_manifest_sha256:null};
  validateManifest(manifest);writeFileSync(join(stage,'bundle.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});await validateBundle(stage);
  for(const path of ['source/source.pdf',...archives.map(a=>a.file.path),...providerFiles.map(a=>a.file.path),'bundle.json']){const fd=openSync(join(stage,path),'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
  renameSync(stage,destination);return{bundle_dir:destination};
 }finally{if(existsSync(stage))rmSync(stage,{recursive:true,force:true});}
}
