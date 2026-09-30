import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
const fixture=new URL('./operation-process-fixture.mjs',import.meta.url);
function run(args){const child=spawn(process.execPath,[fixture.pathname,...args],{stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',value=>out+=value);child.stderr.on('data',value=>err+=value);const done=once(child,'exit').then(([code,signal])=>({code,signal,out,err}));return{child,done};}
for(const boundary of ['source_retained','intent_saved','allocation_inflight','outputs_retained','bundle_adopted'])test(`SIGKILL at ${boundary} restarts from real durable evidence`,{timeout:15000},async t=>{
 const dir=mkdtempSync('/private/tmp/mineru-checkpoint-');t.after(()=>rmSync(dir,{recursive:true,force:true}));const source=join(dir,'source.pdf'),root=join(dir,'journal'),output=join(dir,'output'),signal=join(dir,'checkpoint');writeFileSync(source,'%PDF-1.7\nprocess crash source\n%%EOF');
 const first=run([root,source,output,signal,'crash',boundary]);t.after(()=>{if(first.child.exitCode===null&&!first.child.killed)first.child.kill('SIGKILL');});
 for(let i=0;i<1000&&!existsSync(signal);i++){if(first.child.exitCode!==null)assert.fail(JSON.stringify(await first.done));await new Promise(resolve=>setTimeout(resolve,5));}
 assert.ok(existsSync(signal),'checkpoint reached');const checkpoint=JSON.parse(readFileSync(signal));first.child.kill('SIGKILL');assert.equal((await first.done).signal,'SIGKILL');
 const journal=join(root,'operations',checkpoint.operation_id,'operation.json');const before=existsSync(signal+'.calls')?readFileSync(signal+'.calls','utf8'):'';
 if(boundary==='source_retained')assert.equal(existsSync(journal),false);
 let priorBundle,priorManifest;
 if(boundary==='bundle_adopted'){[priorBundle]=readdirSync(output).filter(name=>name.startsWith('bundle-'));priorManifest=readFileSync(join(output,priorBundle,'bundle.json'));assert.equal(JSON.parse(readFileSync(journal)).bundle_dir,null);}
 const restart=run([root,source,output,signal,boundary==='source_retained'?'submit':'recover']),finished=await restart.done;assert.equal(finished.code,0,finished.err+finished.out);const result=JSON.parse(finished.out);
 if(boundary==='allocation_inflight'){assert.equal(result.state,'reconciliation_required');assert.equal(result.recovery.submission_outcome,'uncertain');assert.equal(readFileSync(signal+'.calls','utf8'),before);}
 else if(['source_retained','intent_saved'].includes(boundary)){assert.equal(result.state,'waiting_external',JSON.stringify(result));assert.deepEqual(readFileSync(signal+'.calls','utf8').trim().split('\n'),['prepare','transfer']);}
 else{assert.equal(result.state,'succeeded',JSON.stringify(result));assert.ok(result.bundle_dir);assert.equal(readFileSync(signal+'.calls','utf8'),before);if(priorBundle){assert.equal(result.bundle_dir,join(output,priorBundle));assert.deepEqual(readFileSync(join(result.bundle_dir,'bundle.json')),priorManifest);}}
});
