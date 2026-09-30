import {lookup} from 'node:dns/promises';
import {request as httpsRequest} from 'node:https';
import {request as httpRequest} from 'node:http';
import {Readable} from 'node:stream';
import {isIP} from 'node:net';
export function publicAddress(address:string):boolean {
 const ip=address.replace(/^\[|\]$/g,'');
 if(isIP(ip)===4){const [a,b,c]=ip.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);}
 return isIP(ip)===6&&/^[23]/.test(ip)&&!/^2001:db8:/i.test(ip);
}
/** Resolve once and pin the checked address at connection time to prevent rebinding. */
export function pinnedLookup(address:{address:string;family:number}) {return (_hostname:any,options:any,callback:any)=>options?.all?callback(null,[address]):callback(null,address.address,address.family);}
const pinnedFetch:typeof fetch=async(input,init={})=>{
 const url=new URL(String(input)),host=url.hostname.replace(/^\[|\]$/g,'');
 const addresses=await lookup(host,{all:true,verbatim:true});if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw new ProviderError('unsafe_network_target');
 const address=addresses[0];
 return new Promise<Response>((resolve,reject)=>{
  const headers=Object.fromEntries(new Headers(init.headers).entries());
  const request=httpsRequest(url,{method:init.method,headers,signal:init.signal??undefined,lookup:pinnedLookup(address) as any},response=>{
   const h=new Headers();for(const [key,value] of Object.entries(response.headers))if(value!==undefined)h.set(key,Array.isArray(value)?value.join(','):value);
   try {const noBody=[204,205,304].includes(response.statusCode??0);if(noBody)response.resume();resolve(new Response(noBody?null:Readable.toWeb(response) as ReadableStream,{status:response.statusCode,headers:h}));}catch(error){response.destroy();reject(error);}
  });request.on('error',reject);request.end(init.body??undefined);
 });
};
/** Bounded, credential-origin-aware transport. No implicit mutation retries. */
export class ProviderError extends Error { constructor(public code:string,public uncertain=false,public retryAfter:number|null=null){super(code);} }
export type Fetcher=typeof fetch;
export class Transport {
 constructor(readonly base:string,private key='',private fetcher:Fetcher=pinnedFetch){const u=new URL(base);if(u.username||u.password||u.search||u.hash||!['https:','http:'].includes(u.protocol))throw new ProviderError('invalid_endpoint');}
 async bytes(path:string,init:RequestInit={},limit=512*1024*1024,timeout=60000,apiAuth=false):Promise<Buffer>{
  let url=new URL(path,this.base.endsWith('/')?this.base:this.base+'/'); const origin=new URL(this.base).origin;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
  try {
   for(let redirects=0;redirects<=5;redirects++) {
    if(url.protocol!=='https:'||url.username||url.password||url.hostname==='localhost'||isIP(url.hostname.replace(/^\[|\]$/g,''))&&!publicAddress(url.hostname))throw new ProviderError('invalid_transport_url');
    const headers=new Headers(init.headers);if(apiAuth&&redirects===0&&url.origin===origin&&this.key)headers.set('Authorization',`Bearer ${this.key}`);else if(redirects>0||headers.get('Authorization')===`Bearer ${this.key}`)headers.delete('Authorization');
    const response=await this.fetcher(url,{...init,headers,redirect:'manual',signal:controller.signal});
    if([301,302,303,307,308].includes(response.status)){await response.body?.cancel();if((init.method??'GET')!=='GET')throw new ProviderError('mutation_redirect',true);const location=response.headers.get('location');if(!location)throw new ProviderError('invalid_redirect');url=new URL(location,url);continue;}
    if(!response.ok) { await response.body?.cancel(); const ra=response.headers.get('retry-after'),n=ra&&/^\d+$/.test(ra)?Number(ra):null;throw new ProviderError(response.status===401||response.status===403?'authentication_failed':response.status===429?'rate_limited':response.status>=500?'provider_unavailable':'provider_rejected',(init.method??'GET')!=='GET',n); }
    const chunks:Buffer[]=[];let size=0;const reader=response.body?.getReader();if(reader)try{for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>limit)throw new ProviderError('limit_exceeded');chunks.push(Buffer.from(r.value));}}finally{await reader.cancel().catch(()=>{});}
    return Buffer.concat(chunks,size);
   }
   throw new ProviderError('redirect_limit');
  }catch(error){if(error instanceof ProviderError)throw error;throw new ProviderError('transport_failed',(init.method??'GET')!=='GET');}finally{clearTimeout(timer);}
 }
 async apiBytes(path:string,limit=512*1024*1024){return this.bytes(path,{},limit,60000,true);}
 async json(path:string,method='GET',body?:unknown):Promise<any>{const bytes=await this.bytes(path,{method,headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)},16*1024*1024,60000,true);try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new ProviderError('invalid_provider_response',method!=='GET');}}
}
export function id(value:unknown):string {if(typeof value!=='string'||!value||value.length>256||/[\x00-\x20\x7f]|https?:|Bearer/i.test(value))throw new ProviderError('invalid_provider_identity');return value;}
export function list(value:unknown):string[]{if(!Array.isArray(value)||value.some(x=>typeof x!=='string'))throw new ProviderError('invalid_capabilities');return value;}
