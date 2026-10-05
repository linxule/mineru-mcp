import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,readFileSync,existsSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {temporaryPrefix} from './temp-dir.mjs';
import {canonicalHash} from '../dist/canonical.js';

const fixture=fileURLToPath(new URL('./fixtures/url-checkpoints/process.mjs',import.meta.url));
const signedUrl='https://source.example/document.pdf?signature=SYNTHETIC_SIGNED_URL_MARKER';
const request={sha256:'',size:0,filename:'source.pdf',formats:['zip'],model:'vlm',pages:'1-2'};
const urlHash=createHash('sha256').update(signedUrl).digest('hex');
const expectedId=canonicalHash({...request,url:urlHash,endpoint:'https://service.example/api/v4',api:'v4'});
function setup(t){
 const dir=mkdtempSync(temporaryPrefix('mineru-url-checkpoint-')),children=[];
 const f={dir,root:join(dir,'journal'),output:join(dir,'output'),signal:join(dir,'checkpoint'),children};
 t.after(async()=>{for(const run of children)if(run.child.exitCode===null&&run.child.signalCode===null)run.child.kill('SIGKILL');await Promise.allSettled(children.map(run=>run.done));rmSync(dir,{recursive:true,force:true});});
 return f;
}
function run(f,mode,url){
 const args=[fixture,f.root,f.output,f.signal,mode,...(url===undefined?[]:[url])];
 // Do not inherit provider credentials, proxy settings or Node preload hooks.
 const child=spawn(process.execPath,args,{stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH??''},timeout:10000,killSignal:'SIGKILL'});
 let out='',err='';child.stdout.on('data',chunk=>out+=chunk);child.stderr.on('data',chunk=>err+=chunk);
 const running={child,done:once(child,'close').then(([code,signal])=>({code,signal,out,err}))};f.children.push(running);return running;
}
async function reachAndKill(f,mode){
 const running=run(f,mode,signedUrl),deadline=Date.now()+8000;
 while(!existsSync(f.signal)&&Date.now()<deadline){
  if(running.child.exitCode!==null||running.child.signalCode!==null)assert.fail(JSON.stringify(await running.done));
  await new Promise(resolve=>setTimeout(resolve,5));
 }
 assert.ok(existsSync(f.signal),'durable checkpoint reached before timeout');
 const checkpoint=JSON.parse(readFileSync(f.signal,'utf8'));running.child.kill('SIGKILL');
 const killed=await running.done;assert.equal(killed.signal,'SIGKILL');assert.equal(killed.err,'');assert.equal(killed.out,'');
 assert.equal(checkpoint.operation_id,expectedId);return checkpoint;
}
async function restart(f,mode,url){
 const finished=await run(f,mode,url).done;
 assert.equal(finished.code,0,finished.err+finished.out);assert.equal(finished.signal,null);assert.equal(finished.err,'');
 const payload=JSON.parse(finished.out);assert.deepEqual(payload.networkAttempts,[],'real network entry points remain unused');
 assert.ok(!finished.out.includes(signedUrl));assert.ok(!finished.out.includes('SYNTHETIC_SIGNED_URL_MARKER'));
 return payload.result;
}
function readJournal(f){return readFileSync(join(f.root,'operations',expectedId,'operation.json'));}
function assertIdentity(f,record){
 assert.equal(record.operation_id,expectedId);assert.equal(record.fingerprint,expectedId);assert.equal(record.version,1);
 assert.equal(record.api,'v4');assert.equal(record.endpoint,'https://service.example/api/v4');assert.equal(record.remote_kind,'task');
 assert.deepEqual(record.request,request);assert.ok(!Object.hasOwn(record.request,'url'));assert.equal(record.source_sha256,null);assert.equal(record.source_binding,'unknown');
 assert.equal(record.upload_id,null);assert.equal(record.file_id,null);assert.deepEqual(record.outputs,[]);assert.deepEqual(record.expected_outputs,[]);assert.deepEqual(record.missing,[]);assert.deepEqual(record.unavailable,[]);
 assert.equal(record.attempts,0);assert.equal(record.next_attempt_at,null);assert.equal(record.cancelled,false);
 assert.equal(record.bundle_dir,null);assert.equal(record.bundle_manifest_sha256,null);assert.deepEqual(record.bundle_history,[]);assert.deepEqual(record.bundle_receipts,[]);
 assert.deepEqual(readdirSync(join(f.root,'operations')),[expectedId]);assert.equal(existsSync(join(f.root,'operations',expectedId,'source.pdf')),false);
 assert.deepEqual(readdirSync(f.output),[]);const bytes=readJournal(f).toString();assert.ok(!bytes.includes(signedUrl));assert.ok(!bytes.includes('SYNTHETIC_SIGNED_URL_MARKER'));assert.ok(!bytes.includes('source.example'));
}
function assertAccounting(result){
 assert.equal(result.operation_id,expectedId);assert.equal(result.source_sha256,null);assert.equal(result.source_binding,'unknown');assert.deepEqual(result.outputs,[]);
 assert.deepEqual(result.recovery.allowance,{tracking:'unsupported'});assert.equal(result.recovery.known_evidence.retained_output_count,0);assert.equal(result.recovery.known_evidence.bundle_count,0);
 assert.equal(result.recovery.known_evidence.source_sha256,null);assert.equal(result.recovery.known_evidence.upload_id,null);assert.equal(result.recovery.known_evidence.file_id,null);
}
function accepted(f){return existsSync(f.signal+'.accepted')?readFileSync(f.signal+'.accepted','utf8').trim().split('\n').map(JSON.parse):[];}

test('SIGKILL after URL acceptance loses the ID without authorizing another submit',{timeout:30000},async t=>{
 const f=setup(t),checkpoint=await reachAndKill(f,'crash-accepted');assert.equal(checkpoint.boundary,'accepted_before_id');assert.equal(checkpoint.remote_id,'synthetic-url-task');
 const before=JSON.parse(readJournal(f));assertIdentity(f,before);assert.equal(before.phase,'submit_pending');assert.equal(before.state,'queued');assert.equal(before.remote_id,null);assert.equal(before.error,null);
 const calls=[{call:'submit',operation_id:expectedId,remote_id:'synthetic-url-task',url_sha256:urlHash,source_sha256:'',size:0}];assert.deepEqual(accepted(f),calls);
 const recovered=await restart(f,'resume');assertAccounting(recovered);assert.equal(recovered.state,'reconciliation_required');assert.equal(recovered.phase,'submit_pending');assert.equal(recovered.remote_id,null);assert.equal(recovered.error.code,'submission_outcome_uncertain');
 assert.equal(recovered.pollable,false);assert.equal(recovered.recovery.retry_safe,false);assert.equal(recovered.recovery.submission_outcome,'uncertain');assert.ok(recovered.recovery.next_actions.some(action=>action.action==='inspect_provider'));assert.ok(!recovered.recovery.next_actions.some(action=>action.action==='resume'));
 const frozen=readJournal(f);assertIdentity(f,JSON.parse(frozen));
 for(const mode of ['resume','status','refresh','resume','submit']){
  const replay=await restart(f,mode,mode==='submit'?signedUrl:undefined);assert.deepEqual(replay,recovered);
  assert.deepEqual(readJournal(f),frozen);assert.deepEqual(accepted(f),calls);
 }
});

test('SIGKILL at URL preflight requires the original explicit URL without recovering it from disk', {timeout:30000},async t=>{
 const f=setup(t),checkpoint=await reachAndKill(f,'crash-preflight');assert.equal(checkpoint.boundary,'durable_preflight');
 const before=JSON.parse(readJournal(f));assertIdentity(f,before);assert.equal(before.phase,'preflight');assert.equal(before.state,'queued');assert.equal(before.remote_id,null);assert.deepEqual(before.events,[]);assert.deepEqual(accepted(f),[]);
 const observed=await restart(f,'status');assertAccounting(observed);assert.equal(observed.recovery.submission_outcome,'not_started');assert.deepEqual(accepted(f),[]);
 const refreshed=await restart(f,'refresh');assert.equal(refreshed.state,'queued');assert.equal(refreshed.phase,'preflight');assert.deepEqual(accepted(f),[]);
 for(const mode of ['resume','status','refresh','resume']){
  const held=await restart(f,mode);assertAccounting(held);assert.equal(held.state,'needs_input');assert.equal(held.phase,'preflight');assert.equal(held.remote_id,null);assert.equal(held.error.code,'source_url_required');
  assert.equal(held.recovery.submission_outcome,'not_started');assertIdentity(f,JSON.parse(readJournal(f)));assert.deepEqual(accepted(f),[]);
 }
 const submitted=await restart(f,'submit',signedUrl);assertAccounting(submitted);assert.equal(submitted.state,'waiting_external');assert.equal(submitted.phase,'poll');assert.equal(submitted.remote_id,'synthetic-url-task');assert.equal(submitted.error,null);
 assert.equal(submitted.recovery.submission_outcome,'known');assertIdentity(f,JSON.parse(readJournal(f)));assert.equal(accepted(f).length,1);assert.equal(accepted(f)[0].url_sha256,urlHash);
 assert.deepEqual(await restart(f,'submit',signedUrl),submitted);assert.deepEqual(await restart(f,'status'),submitted);assert.equal(accepted(f).length,1);
});
