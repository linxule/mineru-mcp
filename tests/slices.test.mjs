import {test} from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import {Readable} from 'node:stream';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import createServer from '../dist/index.js';
import {zip} from './zip-fixture.mjs';
async function setup(t) {
 const dir=mkdtempSync('/private/tmp/mineru-slices-');t.after(()=>rmSync(dir,{recursive:true,force:true}));
 let results=[],archives={};const previous=axios.defaults.adapter;
 axios.defaults.adapter=async config=>({status:200,statusText:'OK',headers:{},config,data:config.url.startsWith('https://mock-archive/')?Readable.from([archives[config.url]]):{code:0,data:{batch_id:'b',extract_result:results}}});
 t.after(()=>{axios.defaults.adapter=previous;});
 const server=createServer({config:{mineruApiKey:'mock-only',mineruBaseUrl:'https://mock-api',mineruDefaultModel:'pipeline'}});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);const client=new Client({name:'test',version:'0'});await client.connect(a);t.after(()=>client.close());
 return {dir,set(r,z={}){results=r;archives=z;},call:args=>client.callTool({name:'mineru_merge_slices',arguments:{batch_id:'b',output_dir:dir,...args}})};
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
