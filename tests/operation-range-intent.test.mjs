import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,rmSync,readdirSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {temporaryPrefix} from './temp-dir.mjs';
import {zip} from './zip-fixture.mjs';
import {parsePageRanges,MAX_PAGE_RANGE_TEXT,MAX_PAGE_RANGE_PARTS} from '../dist/providers/page_ranges.js';
import {createOperationBundle} from '../dist/bundle/operation_writer.js';
import {validateBundle} from '../dist/bundle/validation.js';
import {Operations} from '../dist/operations.js';
import {Transport} from '../dist/providers/transport.js';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const oldCoverage={status:'unknown',requested:{scope:'unknown',ranges:[]},completed:{ranges:[],basis:'unknown',evidence:[]},missing:{ranges:[],basis:'unknown',evidence:[]},unknown:{ranges:[],reason:'No validated PDF page coverage is established.'},source_complete:null};
// Run the compiled archived source, changing runtime import locations only. This
// proof works from a source archive without relying on the current Git history.
async function archivedWriter(){
 const source=readFileSync(new URL('./fixtures/legacy-operation-writer/operation_writer.ts',import.meta.url),'utf8');
 assert.equal(sha(source),'d066ebe80b567247eacc263505a90879e08a12c7fd6f42d26a50182a8fb18162');
 let compiled=readFileSync(new URL('./fixtures/legacy-operation-writer/operation_writer.mjs',import.meta.url),'utf8');
 assert.equal(sha(compiled),'7231b3abf95524ea9bd6887c17ab87582dbc218b86653320eb44bd89d46bc917');
 for(const [from,to] of [['../version.js','../dist/version.js'],['../canonical.js','../dist/canonical.js'],['./archive.js','../dist/bundle/archive.js'],['./filesystem.js','../dist/bundle/filesystem.js'],['./validation.js','../dist/bundle/validation.js']])compiled=compiled.replaceAll(`from '${from}'`,`from '${new URL(to,import.meta.url).href}'`);
 return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}
let legacy;
function legacyWriter(){return legacy??=archivedWriter();}
function fixture(t,pages='03,1-2,2-4,0006'){
 const dir=mkdtempSync(temporaryPrefix('mineru-range-intent-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const bytes=Buffer.from('%PDF-1.7\nrange intent fixture\n%%EOF'),source=join(dir,'source.pdf'),archive=zip([{name:'full.md',body:'# retained evidence'}]),path=join(dir,'archive.zip');
 writeFileSync(source,bytes);writeFileSync(path,archive);
 return{dir,input:{source,outputs:[{id:'archive',format:'zip',path,sha256:sha(archive),size:archive.length}],output:join(dir,'out'),provider:{api:'v4',endpoint:'https://service.example/api/v4',kind:'batch',id:'batch',binding:'uploaded_exact_bytes',request:{sha256:sha(bytes),size:bytes.length,filename:'source.pdf',formats:['zip'],model:'vlm',...(pages===undefined?{}:{pages})},terminal:'partial',missing:['json:not_returned']}}};
}
function extraOutput(f,id='json'){
 const bytes=Buffer.from('{}'),path=join(f.dir,id);writeFileSync(path,bytes);
 return{id,format:'json',path,sha256:sha(bytes),size:bytes.length};
}
function success(f,predecessor){return{...f.input,outputs:[...f.input.outputs,extraOutput(f)],predecessor:predecessor.bundle_dir,predecessorManifestSha256:predecessor.manifest_sha256,provider:{...f.input.provider,terminal:'succeeded',missing:[]}};}
function manifest(result){return JSON.parse(readFileSync(join(result.bundle_dir,'bundle.json')));}

test('bounded page intent coalesces intervals without expanding their extent',()=>{
 assert.equal(parsePageRanges(undefined),null);
 assert.deepEqual(parsePageRanges('8-10,1,3-4,2,4-6,0008'),[{start:1,end:6},{start:8,end:10}]);
 assert.deepEqual(parsePageRanges('1-9007199254740991'),[{start:1,end:Number.MAX_SAFE_INTEGER}]);
 assert.deepEqual(parsePageRanges(Array.from({length:MAX_PAGE_RANGE_PARTS},()=> '1').join(',')),[{start:1,end:1}]);
 for(const pages of ['', '0','0-1','2-1','1-0','9007199254740992','1-9007199254740992','1--2','1,',' 1','1, 2','1.0','1e2','-1','1-2-3','1'.repeat(MAX_PAGE_RANGE_TEXT+1),Array.from({length:MAX_PAGE_RANGE_PARTS+1},()=> '1').join(',')])assert.throws(()=>parsePageRanges(pages),{code:'invalid_page_ranges'},pages.slice(0,80));
});

test('invalid range requests fail before source acquisition or provider methods',async t=>{
 const f=fixture(t),calls=[];
 t.mock.method(Transport.prototype,'bytes',async()=>{calls.push('source');throw Error('source acquisition reached');});
 const ops=new Operations({stateDir:join(f.dir,'journal'),adapterFactory:()=>{calls.push('adapter');return{api:'v4',endpoint:f.input.provider.endpoint,capabilities:async()=>{calls.push('capabilities');throw Error('capabilities reached');}};}});
 for(const pages of ['0','3-1','9007199254740992','1-9007199254740992','1'.repeat(MAX_PAGE_RANGE_TEXT+1),Array.from({length:MAX_PAGE_RANGE_PARTS+1},()=> '1').join(',')])await assert.rejects(ops.submit({url:'https://source.example/source.pdf',api:'v4',pages,output_dir:join(f.dir,'unused-output')}),{code:'invalid_page_ranges'});
 assert.deepEqual(calls,[]);assert.deepEqual(readdirSync(join(f.dir,'journal','operations')),[]);assert.ok(!readdirSync(f.dir).includes('unused-output'));
});

test('valid textual request retains operation fingerprint and raw provider options',async t=>{
 const f=fixture(t),requests=[],request=f.input.provider.request;
 const adapter={api:'v4',endpoint:f.input.provider.endpoint,capabilities:async()=>({api:'v4',endpoint:f.input.provider.endpoint,observed_at:null,validation:'fixture-only',sources:['file_id'],formats:['zip'],tiers:null,ranges:true,remote_cancel:false,lost_id_lookup:false}),prepare:async value=>{requests.push(value);return{id:'batch',state:'pending'};},transfer:async()=>{}};
 const config={stateDir:join(f.dir,'journal'),adapterFactory:()=>adapter},ops=new Operations(config),options={file:f.input.source,api:'v4',model:request.model,pages:request.pages,output_dir:f.input.output};
 const submitted=await ops.submit(options),replay=await new Operations(config).submit(options);
 const {canonicalHash}=await import('../dist/canonical.js');
 assert.equal(submitted.operation_id,canonicalHash({...request,url:null,endpoint:adapter.endpoint,api:'v4'}));
 assert.equal(replay.operation_id,submitted.operation_id);assert.equal(requests.length,1);assert.equal(requests[0].pages,request.pages);
 const saved=JSON.parse(readFileSync(join(config.stateDir,'operations',submitted.operation_id,'operation.json')));assert.equal(saved.request.pages,request.pages);
});

test('new range bundle records normalized intent and wholly unknown page coverage',async t=>{
 const f=fixture(t),created=await createOperationBundle(f.input),m=manifest(created),requested=[{start:1,end:4},{start:6,end:6}];
 assert.deepEqual(m.coverage,{...oldCoverage,requested:{scope:'ranges',ranges:requested},unknown:{...oldCoverage.unknown,ranges:requested}});
 assert.deepEqual(m.provider.request.options,{output_formats:['zip'],page_ranges:f.input.provider.request.pages});
 assert.equal(m.source.page_count,null);assert.deepEqual(m.materializations,[]);
 assert.equal((await createOperationBundle(f.input)).manifest_sha256,created.manifest_sha256);
 const huge=fixture(t,'1-9007199254740991'),hugeResult=await createOperationBundle(huge.input);assert.deepEqual(manifest(hugeResult).coverage.unknown.ranges,[{start:1,end:Number.MAX_SAFE_INTEGER}]);
 const noPages=fixture(t);delete noPages.input.provider.request.pages;const unchanged=await createOperationBundle(noPages.input);assert.deepEqual(manifest(unchanged).coverage,oldCoverage);
});

test('archived range writer exact replay preserves its original directory and bytes',async t=>{
 const f=fixture(t),old=await (await legacyWriter()).createOperationBundle(f.input),oldPath=join(old.bundle_dir,'bundle.json'),bytes=readFileSync(oldPath);
 assert.deepEqual(manifest(old).coverage,oldCoverage);
 assert.deepEqual(await createOperationBundle(f.input),old);
 assert.deepEqual(await createOperationBundle({...f.input,predecessor:old.bundle_dir,predecessorManifestSha256:old.manifest_sha256}),old);
 assert.deepEqual(readFileSync(oldPath),bytes);assert.equal(readdirSync(f.input.output).length,1);
 const changed=JSON.parse(bytes);changed.created_at='2020-01-01T00:00:00Z';writeFileSync(oldPath,JSON.stringify(changed));await validateBundle(old.bundle_dir);
 await assert.rejects(createOperationBundle({...f.input,predecessor:old.bundle_dir,predecessorManifestSha256:old.manifest_sha256}),{code:'retained_bundle_changed'});
});

test('archived range predecessor supports an immutable enriched successor',async t=>{
 const f=fixture(t),old=await (await legacyWriter()).createOperationBundle(f.input),oldBytes=readFileSync(join(old.bundle_dir,'bundle.json')),nextInput=success(f,old),next=await createOperationBundle(nextInput),m=manifest(next);
 assert.notEqual(next.bundle_dir,old.bundle_dir);assert.equal(m.predecessor_manifest_sha256,old.manifest_sha256);
 assert.deepEqual(m.coverage.requested,{scope:'ranges',ranges:[{start:1,end:4},{start:6,end:6}]});assert.deepEqual(readFileSync(join(old.bundle_dir,'bundle.json')),oldBytes);
 assert.deepEqual(await createOperationBundle(nextInput),next);
 assert.deepEqual(await createOperationBundle({...nextInput,predecessor:next.bundle_dir,predecessorManifestSha256:next.manifest_sha256}),next);
 const recorded=JSON.parse(oldBytes);recorded.provider.request.options.page_ranges='1-6';writeFileSync(join(old.bundle_dir,'bundle.json'),JSON.stringify(recorded));await validateBundle(old.bundle_dir);
 await assert.rejects(createOperationBundle({...nextInput,predecessorManifestSha256:null}),{code:'predecessor_identity_mismatch'});
});

test('current range destination and predecessor cannot masquerade as legacy coverage',async t=>{
 const f=fixture(t),current=await createOperationBundle(f.input),path=join(current.bundle_dir,'bundle.json'),changed=manifest(current);changed.coverage=oldCoverage;writeFileSync(path,JSON.stringify(changed));await validateBundle(current.bundle_dir);
 await assert.rejects(createOperationBundle(f.input),{code:'bundle_identity_mismatch'});
 await assert.rejects(createOperationBundle({...success(f,current),predecessorManifestSha256:null}),{code:'predecessor_identity_mismatch'});
});

test('both occupied writer addresses are validated and a recorded replay keeps its address',async t=>{
 const f=fixture(t),current=await createOperationBundle(f.input),old=await (await legacyWriter()).createOperationBundle(f.input);
 assert.notEqual(current.bundle_dir,old.bundle_dir);
 assert.deepEqual(await createOperationBundle({...f.input,predecessor:current.bundle_dir,predecessorManifestSha256:current.manifest_sha256}),current);
 assert.deepEqual(await createOperationBundle(f.input),old);
 const path=join(old.bundle_dir,'bundle.json'),changed=manifest(old);changed.provider.operation.operation_id='foreign';writeFileSync(path,JSON.stringify(changed));await validateBundle(old.bundle_dir);
 await assert.rejects(createOperationBundle({...f.input,predecessor:current.bundle_dir,predecessorManifestSha256:current.manifest_sha256}),{code:'bundle_identity_mismatch'});
});

test('a missing recorded range bundle is not regenerated at its historical address',async t=>{
 const f=fixture(t),created=await createOperationBundle(f.input),oldBytes=readFileSync(join(created.bundle_dir,'bundle.json')),kept=join(f.input.output,'retained-original');renameSync(created.bundle_dir,kept);
 await assert.rejects(createOperationBundle({...f.input,predecessor:created.bundle_dir,predecessorManifestSha256:created.manifest_sha256}),{code:'retained_bundle_changed'});
 assert.deepEqual(readdirSync(f.input.output),['retained-original']);assert.deepEqual(readFileSync(join(kept,'bundle.json')),oldBytes);
});

const historicalSelectors=[['too many intervals',Array.from({length:MAX_PAGE_RANGE_PARTS+1},()=> '1').join(',')],['too much text','0'.repeat(MAX_PAGE_RANGE_TEXT)+'1'],['zero page','0'],['descending range','3-1'],['unsafe integer','9007199254740992']];
for(const [name,pages] of historicalSelectors)test(`archived ${name} selector replays only existing legacy bytes`,async t=>{
 const f=fixture(t,pages);
 await assert.rejects(createOperationBundle(f.input),{code:'invalid_page_ranges'});assert.ok(!readdirSync(f.dir).includes('out'));
 const old=await (await legacyWriter()).createOperationBundle(f.input),path=join(old.bundle_dir,'bundle.json'),bytes=readFileSync(path);await validateBundle(old.bundle_dir);
 assert.deepEqual(await createOperationBundle(f.input),old);
 assert.deepEqual(await createOperationBundle({...f.input,predecessor:old.bundle_dir,predecessorManifestSha256:old.manifest_sha256}),old);
 await assert.rejects(createOperationBundle(success(f,old)),{code:'invalid_page_ranges'});
 assert.equal(readdirSync(f.input.output).length,1);assert.deepEqual(readFileSync(path),bytes);assert.deepEqual(manifest(old).coverage,oldCoverage);
 const changed=JSON.parse(bytes);changed.created_at='2020-01-01T00:00:00Z';writeFileSync(path,JSON.stringify(changed));await validateBundle(old.bundle_dir);
 await assert.rejects(createOperationBundle({...f.input,predecessor:old.bundle_dir,predecessorManifestSha256:old.manifest_sha256}),{code:'retained_bundle_changed'});
});

test('an already published historical successor can replay without new admission',async t=>{
 const f=fixture(t,historicalSelectors[0][1]),old=await (await legacyWriter()).createOperationBundle(f.input),input=success(f,old),next=await (await legacyWriter()).createOperationBundle(input),bytes=readFileSync(join(next.bundle_dir,'bundle.json'));
 assert.deepEqual(await createOperationBundle(input),next);assert.deepEqual(await createOperationBundle({...input,predecessor:next.bundle_dir,predecessorManifestSha256:next.manifest_sha256}),next);
 assert.deepEqual(readFileSync(join(next.bundle_dir,'bundle.json')),bytes);assert.deepEqual(manifest(next).coverage,oldCoverage);
});

test('legacy orphan bundle adoption stays offline and inadmissible recovery cannot reach providers',async t=>{
 const f=fixture(t,historicalSelectors[0][1]);f.input.provider.terminal='succeeded';f.input.provider.missing=[];
 const old=await (await legacyWriter()).createOperationBundle(f.input),bytes=readFileSync(join(old.bundle_dir,'bundle.json')),calls=[];
 const config={stateDir:join(f.dir,'journal'),adapterFactory:()=>{calls.push('adapter');throw Error('provider access reached');}},ops=new Operations(config),{canonicalHash}=await import('../dist/canonical.js'),request=f.input.provider.request;
 const operationId=canonicalHash({...request,url:null,endpoint:f.input.provider.endpoint,api:'v4'}),dir=join(config.stateDir,'operations',operationId);mkdirSync(dir);
 writeFileSync(join(dir,'source.pdf'),readFileSync(f.input.source));writeFileSync(join(dir,'retained.zip'),readFileSync(f.input.outputs[0].path));
 const record={version:1,operation_id:operationId,fingerprint:operationId,api:'v4',endpoint:f.input.provider.endpoint,phase:'finalize',state:'waiting_external',created_at:new Date().toISOString(),updated_at:'',request,source_sha256:request.sha256,output_dir:f.input.output,remote_id:'batch',remote_kind:'batch',upload_id:'batch',file_id:null,source_binding:'uploaded_exact_bytes',outputs:f.input.outputs.map(output=>({...output,path:'retained.zip'})),missing:[],unavailable:[],expected_outputs:[{id:'archive',format:'zip'}],remote_state:'succeeded',error:null,bundle_dir:null,bundle_manifest_sha256:null,bundle_history:[],bundle_receipts:[],attempts:0,next_attempt_at:null,cancelled:false,events:[],capabilities:null};
 const path=join(dir,'operation.json');writeFileSync(path,JSON.stringify(record));
 const adopted=await ops.resume(operationId);assert.equal(adopted.state,'succeeded',JSON.stringify(adopted));assert.equal(adopted.bundle_dir,old.bundle_dir);assert.equal(adopted.bundle_manifest_sha256,old.manifest_sha256);assert.deepEqual(calls,[]);
 const stranded=JSON.parse(readFileSync(path));stranded.phase='finalize';stranded.state='needs_input';stranded.error='invalid_page_ranges';stranded.bundle_dir=null;stranded.bundle_manifest_sha256=null;writeFileSync(path,JSON.stringify(stranded));
 const recovered=await ops.resume(operationId);assert.equal(recovered.state,'succeeded',JSON.stringify(recovered));assert.equal(recovered.bundle_dir,old.bundle_dir);assert.equal(recovered.bundle_manifest_sha256,old.manifest_sha256);
 for(const phase of ['poll','preflight']){
  const pending=JSON.parse(readFileSync(path));pending.phase=phase;pending.state='waiting_external';writeFileSync(path,JSON.stringify(pending));
  const held=await ops.resume(operationId);assert.equal(held.state,'needs_input');assert.equal(held.error.code,'invalid_page_ranges');assert.equal(held.pollable,false);
  const refreshed=await ops.status(operationId,true);assert.equal(refreshed.state,'needs_input');assert.equal(refreshed.error.code,'invalid_page_ranges');
 }
 assert.deepEqual(calls,[]);assert.deepEqual(readFileSync(join(old.bundle_dir,'bundle.json')),bytes);
});
