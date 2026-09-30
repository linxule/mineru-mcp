import {test} from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import {Readable} from 'node:stream';
import {mkdtempSync,mkdirSync,renameSync,symlinkSync,readdirSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import createServer from '../dist/index.js';
import {zip} from './zip-fixture.mjs';
async function setup(t) {
 const dir=mkdtempSync('/private/tmp/mineru-slices-');t.after(()=>rmSync(dir,{recursive:true,force:true}));
 let results=[],archives={},downloadHook;const previous=axios.defaults.adapter;
 axios.defaults.adapter=async config=>{
  const archive=config.url.startsWith('https://mock-archive/');
  if(archive)downloadHook?.();
  return{status:200,statusText:'OK',headers:{},config,data:archive?Readable.from([archives[config.url]]):{code:0,data:{batch_id:'b',extract_result:results}}};
 };
 t.after(()=>{axios.defaults.adapter=previous;});
 const server=createServer({config:{mineruApiKey:'mock-only',mineruBaseUrl:'https://mock-api',mineruDefaultModel:'pipeline'}});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);const client=new Client({name:'test',version:'0'});await client.connect(a);t.after(()=>client.close());
 return {dir,set(r,z={}){results=r;archives=z;},onDownload(handler){downloadHook=handler;},call:args=>client.callTool({name:'mineru_merge_slices',arguments:{batch_id:'b',output_dir:dir,...args}})};
}
test('every normalized pending state returns typed pollable state without filesystem publication',async t=>{
 const f=await setup(t);
 for(const state of ['queued','processing','waiting-file-upload','running','pending']) {f.set([{state,data_id:'book__p00001-00003',file_name:'book.pdf'}]);const r=await f.call({});assert.equal(r.structuredContent.pollable,true);assert.equal(existsSync(join(f.dir,'book')),false);}
});
test('missing Markdown preserves all slice archives and structured provenance stays unknown',async t=>{
 const f=await setup(t);const z=zip([{name:'content_list.json',body:'[{"page_idx":0}]'},{name:'opaque.bin',body:'x'}]);
 f.set([{state:'done',data_id:'book__p00001-00003',file_name:'book.pdf',full_zip_url:'https://mock-archive/a'}],{'https://mock-archive/a':z});
 const r=await f.call({});assert.equal(r.isError,undefined);assert.equal(r.structuredContent.coverage,'partial');assert.equal(r.structuredContent.page_provenance,'unknown');
 const receipt=JSON.parse(readFileSync(join(f.dir,'book','book_content.json'),'utf8'));assert.equal(receipt.slices.length,1);assert.equal(receipt.slices[0].original_page_offset,null);assert.equal(receipt.missing_or_unknown_ranges[0].reason,'missing_markdown');assert.equal(receipt.slices[0].structured_members.length,1);
});
test('successor merges retain immutable slice image links and never invent original page offsets',async t=>{
 const f=await setup(t),url='https://mock-archive/a';
 const run=async (image,overwrite=false)=>{const z=zip([{name:'full.md',body:'# Chapter\n![img](images/x.png)'},{name:'images/x.png',body:image},{name:'content_list.json',body:'[{"page_idx":0}]'}]);f.set([{state:'done',data_id:'book__p00001-00003',file_name:'book.pdf',full_zip_url:url}],{[url]:z});return f.call({overwrite});};
 const first=await run('old');const md=readFileSync(first.structuredContent.output,'utf8'),relative=/\]\(([^)]+)\)/.exec(md)[1];assert.equal(readFileSync(join(f.dir,'book',relative),'utf8'),'old');
 const second=await run('new',true);assert.equal(second.isError,undefined);assert.equal(readFileSync(join(f.dir,'book',relative),'utf8'),'old');assert.equal(second.structuredContent.coverage,'unknown');
});
for(const nested of [false,true])test(`merge rejects ${nested?'slice parent':'output root'} replacement while archive fetch is pending`,async t=>{
 const f=await setup(t),outside=mkdtempSync('/private/tmp/mineru-slices-outside-'),original=nested?join(f.dir,'original-book'):`${f.dir}-original`;
 t.after(()=>{rmSync(outside,{recursive:true,force:true});if(!nested)rmSync(original,{recursive:true,force:true});});
 if(nested)mkdirSync(join(outside,'slices'));
 const url='https://mock-archive/a',raw=zip([{name:'full.md',body:'# Chapter',deflate:true}]);
 f.set([{state:'done',data_id:'book__p00001-00003',file_name:'book.pdf',full_zip_url:url}],{[url]:raw});
 f.onDownload(()=>{const target=nested?join(f.dir,'book'):f.dir;renameSync(target,original);symlinkSync(outside,target);});
 const result=await f.call({});assert.equal(result.isError,true);assert.match(JSON.stringify(result),/replaced|symlinks/);
 assert.deepEqual(nested?readdirSync(join(outside,'slices')):readdirSync(outside),[]);
});
