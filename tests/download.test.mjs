import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {retainArchive} from '../dist/bundle/download.js';
import {lifecycle} from '../dist/bundle/lifecycle.js';
import {zip} from './zip-fixture.mjs';
test('download retention includes unknown members and replay checks archive bytes',async t=>{
 const dir=mkdtempSync('/private/tmp/mineru-retain-');t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const raw=zip([{name:'full.md',body:'# main'},{name:'model.json',body:'{"x":1}'},{name:'unknown.bin',body:'opaque'}]);
 const r=await retainArchive(raw,dir,'paper');assert.deepEqual(readFileSync(join(r.directory,'archives',r.inventory.sha256+'.zip')),raw);assert.equal(r.inventory.members.length,3);assert.equal((await retainArchive(raw,dir,'paper')).skipped,true);
 writeFileSync(join(r.directory,'archives',r.inventory.sha256+'.zip'),'changed');await assert.rejects(()=>retainArchive(raw,dir,'paper'),/different or unverified/);
});
test('ambiguous primary files are retained without selecting first; quarantine invalid ZIP',async t=>{
 const dir=mkdtempSync('/private/tmp/mineru-retain-');t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const r=await retainArchive(zip([{name:'a/full.md',body:'a'},{name:'b/full.md',body:'b'}]),dir,'paper');assert.equal(readdirSync(r.directory).includes('paper.md'),false);assert.equal(r.warnings[0].code,'ambiguous_markdown');
 const bad=zip([{name:'../escape',body:'x'}]);await assert.rejects(()=>retainArchive(bad,dir,'bad'),/quarantined/);assert.equal(readdirSync(dir).includes('bad'),false);
 const q=join(dir,'quarantine',readdirSync(join(dir,'quarantine'))[0]);assert.deepEqual(readFileSync(q),bad);
});
test('output symlinks rejected; no string prefix containment',async t=>{
 const dir=mkdtempSync('/private/tmp/mineru-retain-');t.after(()=>rmSync(dir,{recursive:true,force:true}));symlinkSync(dir,join(dir,'link'));await assert.rejects(()=>retainArchive(zip([]),join(dir,'link'),'paper'),/symlinks/);
});
test('typed lifecycle handles failed plus pending, cancellation, unknown, and all results independently of pagination',()=>{
 const mixed=lifecycle('b',[{state:'failed'},...Array.from({length:20},()=>({state:'pending'}))]);assert.equal(mixed.pollable,true);assert.equal(mixed.counts.pending,20);
 assert.equal(lifecycle('b',[{state:'done'},{state:'cancelled'}]).state,'partial');assert.equal(lifecycle('b',[{state:'new-state'}]).state,'unknown');assert.equal(lifecycle('b',[]).state,'unknown');
});
