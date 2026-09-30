import {temporaryPrefix} from './temp-dir.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createOperationBundle} from '../dist/bundle/operation_writer.js';
import {validateBundle} from '../dist/bundle/validation.js';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function setup(t){const dir=mkdtempSync(temporaryPrefix('mineru-writer-identity-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const bytes=Buffer.from('%PDF-1.7\nidentity fixture\n%%EOF'),source=join(dir,'source.pdf'),md=Buffer.from('# evidence'),mdPath=join(dir,'markdown');writeFileSync(source,bytes);writeFileSync(mdPath,md);return{dir,bytes,input:{source,outputs:[{id:'md-file',format:'markdown',path:mdPath,sha256:sha(md),size:md.length}],output:join(dir,'out'),provider:{api:'v1',endpoint:'https://api.example/api/v1',kind:'job',id:'job',binding:'uploaded_exact_bytes',request:{sha256:sha(bytes),size:bytes.length,filename:'source.pdf',formats:['markdown'],tier:'standard'},terminal:'succeeded',missing:[]}}};}
test('existing deterministic destination must match intended source, provider, request and output identity',async t=>{
 const f=setup(t),created=await createOperationBundle(f.input),path=join(created.bundle_dir,'bundle.json'),original=readFileSync(path);
 const changes=[
  m=>{m.provider.operation.operation_id='foreign-job';},
  m=>{m.source.page_count=1;},
  m=>{m.provider.endpoint_origin='https://foreign.example';},
  m=>{m.provider.request.tier='foreign-tier';},
  m=>{m.provider.source_binding.method='caller_asserted';m.provider.source_binding.evidence='Foreign valid receipt';},
  m=>{m.provider_files[0].file_id='foreign-output';},
  m=>{m.provider_files[0].format_schema='foreign-profile';m.provider_files[0].format_version='2';},
  m=>{const changed=Buffer.from('%PDF-1.7\nforeign source\n%%EOF');writeFileSync(join(created.bundle_dir,'source/source.pdf'),changed);m.source.sha256=sha(changed);m.source.size_bytes=changed.length;m.source.file.sha256=sha(changed);m.source.file.size_bytes=changed.length;},
 ];
 for(const change of changes){writeFileSync(join(created.bundle_dir,'source/source.pdf'),f.bytes);const manifest=JSON.parse(original);change(manifest);writeFileSync(path,JSON.stringify(manifest));await validateBundle(created.bundle_dir);await assert.rejects(createOperationBundle(f.input),{code:'bundle_identity_mismatch'});}
 writeFileSync(join(created.bundle_dir,'source/source.pdf'),f.bytes);writeFileSync(path,original);const replay=await createOperationBundle(f.input);assert.equal(replay.bundle_dir,created.bundle_dir);assert.equal(replay.manifest_sha256,created.manifest_sha256);
});
test('successor lineage rejects a foreign endpoint/request/binding even with a valid predecessor',async t=>{
 const f=setup(t),created=await createOperationBundle(f.input),path=join(created.bundle_dir,'bundle.json'),original=readFileSync(path),successor={...f.input,predecessor:created.bundle_dir,provider:{...f.input.provider,terminal:'partial',missing:['json:not_returned']}};
 for(const change of [m=>{m.provider.endpoint_origin='https://foreign.example';},m=>{m.provider.request.tier='other';},m=>{m.provider.source_binding.method='caller_asserted';},m=>{m.provider_files[0].file_id='foreign-output';}]){
  const manifest=JSON.parse(original);change(manifest);writeFileSync(path,JSON.stringify(manifest));await validateBundle(created.bundle_dir);await assert.rejects(createOperationBundle(successor),{code:'predecessor_identity_mismatch'});
 }
 writeFileSync(path,original);const manifest=JSON.parse(original);manifest.created_at='2020-01-01T00:00:00Z';writeFileSync(path,JSON.stringify(manifest));await validateBundle(created.bundle_dir);
 await assert.rejects(createOperationBundle({...successor,predecessorManifestSha256:created.manifest_sha256}),{code:'predecessor_manifest_changed'});
});

test('existing archive must retain intended member roles, format profiles and locators',async t=>{
 const f=setup(t),{zip}=await import('./zip-fixture.mjs'),bytes=zip([{name:'full.md',body:'# evidence'},{name:'content_list.json',body:'[]'}]),path=join(f.dir,'archive.zip');writeFileSync(path,bytes);
 f.input.outputs=[{id:'archive',format:'zip',path,sha256:sha(bytes),size:bytes.length}];
 const created=await createOperationBundle(f.input),receipt=join(created.bundle_dir,'bundle.json'),original=readFileSync(receipt);
 for(const change of [m=>{m.archives[0].members[0].role='unknown';},m=>{m.archives[0].members[1].format_schema='mineru.content-list';m.archives[0].members[1].format_version='1';},m=>{m.archives[0].members[0].member_id='foreign-member';}]){
  const manifest=JSON.parse(original);change(manifest);writeFileSync(receipt,JSON.stringify(manifest));await validateBundle(created.bundle_dir);await assert.rejects(createOperationBundle(f.input),{code:'bundle_identity_mismatch'});
 }
 writeFileSync(receipt,original);assert.equal((await createOperationBundle(f.input)).manifest_sha256,created.manifest_sha256);
});
