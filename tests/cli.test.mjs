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
