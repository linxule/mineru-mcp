import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {zip} from './zip-fixture.mjs';
const run=args=>spawnSync(process.execPath,['dist/cli.js',...args],{encoding:'utf8',env:{PATH:process.env.PATH}});
test('CLI offline bundle and replay work without credentials and print parseable JSON',t=>{
 const dir=mkdtempSync('/private/tmp/mineru-cli-');t.after(()=>rmSync(dir,{recursive:true,force:true}));const source=join(dir,'s.pdf'),archive=join(dir,'r.zip');writeFileSync(source,'%PDF-1.7\nfixture\n%%EOF');writeFileSync(archive,zip([{name:'full.md',body:'# heading'}]));
 const args=['bundle','--source',source,'--archive',archive,'--output',join(dir,'out'),'--json'];
 const result=run(args);assert.equal(result.status,0,result.stderr);const data=JSON.parse(result.stdout);assert.equal(data.ok,true);assert.equal(data.status,'created');assert.equal(JSON.parse(readFileSync(data.manifest_path)).source.sha256,data.source_sha256);assert.equal(JSON.parse(run(args).stdout).status,'existing');
});
test('JSON errors never require regex parsing and legacy commands remain listed',()=>{
 const error=run(['bundle','--json']);assert.equal(error.status,1);assert.equal(JSON.parse(error.stdout).ok,false);const list=run(['list']);assert.equal(list.status,0);for(const cmd of ['parse','status','batch','batch-status','upload-batch','download-results','parse-long','merge-slices']) assert.match(list.stdout,new RegExp(`(^|\\n)${cmd}\\n`));
});

test('new CLI malformed arguments return E01 Result JSON and exit 2 before application invocation',()=>{
 for(const args of [
  ['operation-status','--json'],
  ['resume','--operation-id','--json'],
  ['resume','--operation-id','abc','--unexpected','value','--json'],
  ['submit','--file','source.pdf','--url','https://example.test/s.pdf','--output-dir','out','--json'],
  ['capabilities','--api','future','--json'],
  ['capabilities','--refresh','invalid','--json'],
  ['resume','--operation-id','abc','--wait-timeout-seconds','0','--json'],
 ]){const result=run(args);assert.equal(result.status,2,result.stdout+result.stderr);const value=JSON.parse(result.stdout);assert.equal(value.status,'error');assert.equal(value.errors[0].code,'invalid_arguments');assert.equal(value.meta.extra.contract,'mineru.execution.v1');assert.equal(value.data.state,'failed');}
});
test('new CLI wait timeout preserves same-operation Result data and exits 1',t=>{
 const dir=mkdtempSync('/private/tmp/mineru-cli-wait-');t.after(()=>rmSync(dir,{recursive:true,force:true}));const id='a'.repeat(64);
 const result=spawnSync(process.execPath,['--import','./tests/cli-wait-fixture.mjs','dist/cli.js','operation-status','--operation-id',id,'--wait','--wait-timeout-seconds','1','--json'],{encoding:'utf8',env:{PATH:process.env.PATH,MINERU_STATE_DIR:dir},timeout:5000});
 assert.equal(result.status,1,result.stderr);const value=JSON.parse(result.stdout);assert.equal(value.status,'partial');assert.equal(value.data.operation_id,id);assert.equal(value.data.remote_id,'fixture-remote');assert.equal(value.errors[0].code,'wait_timeout');assert.equal(value.errors[0].retriable,true);assert.match(result.stderr,/\[wait\]/);assert.equal(result.stdout.trim().split('\n').length,1);
});
test('new CLI application failure uses exit 1 with a full Result envelope',t=>{
 const dir=mkdtempSync('/private/tmp/mineru-cli-error-');t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const result=spawnSync(process.execPath,['dist/cli.js','operation-status','--operation-id','a'.repeat(64),'--json'],{encoding:'utf8',env:{PATH:process.env.PATH,MINERU_STATE_DIR:dir}});
 assert.equal(result.status,1);const value=JSON.parse(result.stdout);assert.equal(value.status,'error');assert.equal(value.errors[0].code,'operation_not_found');assert.deepEqual(value.warnings,[]);
});
