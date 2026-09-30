import {Transport,ProviderError,id} from './transport.js';
import {normalizeState} from '../bundle/lifecycle.js';
import type {Adapter,Capabilities,Request,Upload,Snapshot,Output} from './types.js';
export class V4Adapter implements Adapter {
 readonly api='v4' as const;
 constructor(readonly endpoint:string,private transport=new Transport(endpoint)){if(!/\/api\/v4\/?$/.test(new URL(endpoint).pathname))throw new ProviderError('invalid_v4_endpoint');}
 async capabilities(refresh=false):Promise<Capabilities>{if(refresh)throw new ProviderError('unsupported_capability');return{api:'v4',endpoint:this.endpoint,observed_at:null,validation:'fixture-only',sources:['file_id','url'],formats:['zip'],tiers:null,ranges:true,remote_cancel:false,lost_id_lookup:false};}
 private async request(path:string,method='GET',body?:unknown){const r=await this.transport.json(path,method,body);if(r.code!==0)throw new ProviderError('provider_rejected',method!=='GET');return r.data;}
 async prepare(r:Request):Promise<Upload>{if(r.tier||!['pipeline','vlm'].includes(r.model??'pipeline'))throw new ProviderError('unsupported_capability');const data=await this.request('file-urls/batch','POST',{files:[{name:r.filename,data_id:r.sha256,...(r.pages?{page_ranges:r.pages}:{})}],model_version:r.model??'pipeline'});const batch=id(data.batch_id);if(!Array.isArray(data.file_urls)||data.file_urls.length!==1||typeof data.file_urls[0]!=='string')throw new ProviderError('invalid_upload_response',true);return{id:batch,state:'pending',url:data.file_urls[0],method:'PUT',headers:{}};}
 async inspectUpload(_id:string):Promise<Upload>{throw new ProviderError('unsupported_capability');}
 async transfer(u:Upload,bytes:Buffer){if(!u.url)throw new ProviderError('upload_url_missing');await this.transport.bytes(u.url,{method:'PUT',body:bytes as unknown as BodyInit},1024*1024,Math.min(1800000,60000+Math.ceil(bytes.length/1048576)*2000));}
 async complete(_id:string):Promise<Upload>{throw new ProviderError('unsupported_capability');}
 async submit(r:Request){if(!r.url||r.tier)throw new ProviderError('unsupported_capability');const data=await this.request('extract/task','POST',{url:r.url,model_version:r.model??'pipeline',...(r.pages?{page_ranges:r.pages}:{})});return id(data.task_id);}
 async status(operationId:string,kind='batch'):Promise<Snapshot>{const data=await this.request(kind==='task'?`extract/task/${encodeURIComponent(id(operationId))}`:`extract-results/batch/${encodeURIComponent(id(operationId))}`);if(id(kind==='task'?data.task_id:data.batch_id)!==operationId)throw new ProviderError('identity_mismatch');const files=kind==='task'?[data]:data.extract_result;if(!Array.isArray(files)||files.length!==1)throw new ProviderError('unexpected_file_count');const f=files[0],state=normalizeState(f.state);return{id:operationId,state,outputs:state==='succeeded'&&f.full_zip_url?[{id:'archive',format:'zip',url:f.full_zip_url}]:[],missing:state==='succeeded'&&!f.full_zip_url?['zip:not_returned']:[]};}
 async download(output:Output){if(!output.url)throw new ProviderError('output_url_missing');return this.transport.bytes(output.url);}
}
