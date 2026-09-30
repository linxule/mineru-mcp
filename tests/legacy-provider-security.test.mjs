import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import axios,{AxiosError} from 'axios';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import createServer from '../dist/index.js';
const key='SYNTHETIC_LEGACY_GUARD_KEY';
const encoded=[...key].map(c=>'%'+c.charCodeAt(0).toString(16)).join('');
async function setup(t,respond,fetcher=async()=>new Response(null,{status:204})){
 const dir=mkdtempSync('/private/tmp/mineru-legacy-security-');t.after(()=>rmSync(dir,{recursive:true,force:true}));const source=join(dir,'source.pdf');writeFileSync(source,'%PDF-1.7\nlegacy security fixture\n%%EOF');
 const previous=axios.defaults.adapter,previousFetch=globalThis.fetch,calls=[],transfers=[];
 axios.defaults.adapter=async config=>{calls.push(config);assert.equal(config.maxRedirects,config.responseType==='stream'?5:0);const result=await respond(config);return{status:200,statusText:'OK',headers:{},config,...result};};
 globalThis.fetch=async(url,init)=>{transfers.push({url:String(url),init});return fetcher(url,init);};
 t.after(()=>{axios.defaults.adapter=previous;globalThis.fetch=previousFetch;});
 const server=createServer({config:{mineruApiKey:key,mineruBaseUrl:'https://api.example/api/v4',mineruDefaultModel:'pipeline'}}),client=new Client({name:'legacy-security',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);t.after(()=>client.close());
 return{dir,source,calls,transfers,call:(name,args)=>client.callTool({name,arguments:args})};
}
function noEcho(value){const text=JSON.stringify(value);assert.ok(!text.includes(key),text);assert.ok(!text.toLowerCase().includes(encoded.toLowerCase()),text);}
const routes=[
 ['mineru_parse',f=>({url:'https://source.example/paper.pdf'}),{task_id:key}],
 ['mineru_status',f=>({task_id:'task'}),{task_id:'task',state:'running',err_msg:key}],
 ['mineru_batch',f=>({urls:['https://source.example/paper.pdf']}),{batch_id:key}],
 ['mineru_batch_status',f=>({batch_id:'batch'}),{batch_id:'batch',extract_result:[{state:'failed',file_name:key}]}],
 ['mineru_upload_batch',f=>({files:[f.source]}),{batch_id:key,file_urls:['https://storage.example/upload']}],
 ['mineru_parse_long',f=>({file:f.source,total_pages:1}),{batch_id:'batch',file_urls:[`https://storage.example/upload?echo=${encoded}`]}],
 ['mineru_download_results',f=>({batch_id:'batch',output_dir:join(f.dir,'out')}),{batch_id:'batch',extract_result:[{state:'done',file_name:'paper.pdf',full_zip_url:`https://storage.example/result?echo=${key}`}]}],
 ['mineru_merge_slices',f=>({batch_id:'batch',output_dir:join(f.dir,'out')}),{batch_id:'batch',extract_result:[{state:'done',file_name:'paper.pdf',data_id:'book__p00001-00001',full_zip_url:`https://storage.example/result?echo=${key}`}]}],
];
for(const [name,args,data] of routes)test(`${name} rejects echoed provider metadata before legacy output/transfer`,async t=>{const f=await setup(t,async()=>({data:{code:0,data}})),result=await f.call(name,args(f));assert.equal(result.isError,true);assert.equal(result.structuredContent.errors[0].code,'credential_echo_forbidden');assert.equal(f.transfers.length,0);noEcho(result);});
for(const grant of [key,encoded])test(`legacy upload URL guard blocks ${grant===key?'raw':'encoded'} key before dispatch`,async t=>{const f=await setup(t,async()=>({data:{code:0,data:{batch_id:'batch',file_urls:[`https://storage.example/upload?key=${grant}`]}}})),result=await f.call('mineru_upload_batch',{files:[f.source]});assert.equal(result.isError,true);assert.equal(f.transfers.length,0);noEcho(result);});
for(const mode of ['error-body','axios-error-body','axios-error-message','success-header','header-name'])test(`legacy API ${mode} cannot echo key into a public result`,async t=>{
 const f=await setup(t,async config=>{
  if(mode==='axios-error-body')throw new AxiosError('provider failed','ERR_BAD_RESPONSE',config,undefined,{status:500,statusText:'error',headers:{},config,data:{code:'bad',msg:key}});
  if(mode==='axios-error-message')throw new AxiosError(`provider failed ${encoded}`,'ERR_BAD_RESPONSE',config);
  if(mode==='error-body')return{data:{code:'bad',msg:encoded}};
  return{data:{code:0,data:{task_id:'task'}},headers:mode==='header-name'?{[key.toLowerCase()]:'value'}:{'x-echo':key}};
 });
 const result=await f.call('mineru_parse',{url:'https://source.example/paper.pdf'});assert.equal(result.isError,true);assert.equal(result.structuredContent.errors[0].code,'credential_echo_forbidden');noEcho(result);
});
for(const mode of ['redirect','failure-body','thrown-message'])test(`legacy PUT ${mode} is sanitized and cannot follow a credential-bearing redirect`,async t=>{
 const f=await setup(t,async()=>({data:{code:0,data:{batch_id:'batch',file_urls:['https://storage.example/upload']}}}),async(_url,init)=>{assert.equal(init.redirect,'manual');if(mode==='redirect')return new Response(null,{status:307,headers:{location:`https://other.example/?key=${encoded}`}});if(mode==='failure-body')return new Response(key,{status:403});throw Error(`transfer ${key}`);});
 const result=await f.call('mineru_upload_batch',{files:[f.source]});assert.equal(f.transfers.length,1);assert.equal(result.structuredContent.status,'error');noEcho(result);
});
test('legacy download guards reconstructed redirect URL and headers before follow-up dispatch',async t=>{
 let streams=0;const f=await setup(t,async config=>{if(config.responseType==='stream'){streams++;assert.equal(typeof config.beforeRedirect,'function');config.beforeRedirect({protocol:'https:',hostname:'storage.example',path:`/result?key=${encoded}`,headers:{}},{headers:{},statusCode:302});assert.fail('unsafe redirect callback returned');}return{data:{code:0,data:{batch_id:'batch',extract_result:[{state:'done',file_name:'paper.pdf',full_zip_url:'https://storage.example/result'}]}}};});
 const result=await f.call('mineru_download_results',{batch_id:'batch',output_dir:join(f.dir,'out')});assert.equal(streams,1);assert.equal(result.structuredContent.status,'error');assert.equal(f.transfers.length,0);noEcho(result);
});
