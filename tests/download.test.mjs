import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,renameSync,readFileSync,readdirSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {retainArchive,fetchArchive} from '../dist/bundle/download.js';
import {createServer} from 'node:http';
import axios from 'axios';
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
for(const rejected of [false,true])test(`root replacement during asynchronous ZIP ${rejected?'rejection':'inspection'} cannot redirect retention`,async t=>{
 const base=mkdtempSync('/private/tmp/mineru-retain-race-');t.after(()=>rmSync(base,{recursive:true,force:true}));
 const output=join(base,'output'),outside=join(base,'outside');mkdirSync(outside);
 const raw=zip([{name:rejected?'../escape':'full.md',body:'synthetic bytes',deflate:true}]);
 const pending=retainArchive(raw,output,'paper');
 renameSync(output,join(base,'original-output'));symlinkSync(outside,output);
 await assert.rejects(pending,/replaced|symlinks/);assert.deepEqual(readdirSync(outside),[]);
 assert.deepEqual(readdirSync(join(base,'original-output')),[]);
});
test('ancestor replacement during streamed inspection cannot redirect stage writes',async t=>{
 const base=mkdtempSync('/private/tmp/mineru-retain-parent-race-');t.after(()=>rmSync(base,{recursive:true,force:true}));
 const parent=join(base,'parent'),output=join(parent,'output'),outside=join(base,'outside');mkdirSync(outside);mkdirSync(join(outside,'output'));
 const pending=retainArchive(zip([{name:'full.md',body:'synthetic',deflate:true}]),output,'paper');
 renameSync(parent,join(base,'original-parent'));symlinkSync(outside,parent);
 await assert.rejects(pending,/replaced|symlinks/);assert.deepEqual(readdirSync(join(outside,'output')),[]);
});
test('replay refuses a symlinked archive parent and overwrite preserves prior bytes',async t=>{
 const base=mkdtempSync('/private/tmp/mineru-retain-replay-');t.after(()=>rmSync(base,{recursive:true,force:true}));
 const first=zip([{name:'full.md',body:'old'},{name:'images/x.png',body:'old image'}]),second=zip([{name:'full.md',body:'new'}]);
 const made=await retainArchive(first,base,'paper');assert.equal(readFileSync(join(made.directory,'images/x.png'),'utf8'),'old image');
 await retainArchive(second,base,'paper',true);
 const prior=readdirSync(base).find(n=>n.startsWith('paper.previous-'));assert.ok(prior);assert.equal(readFileSync(join(base,prior,'paper.md'),'utf8'),'old');
 const archives=join(base,'paper','archives'),moved=join(base,'retained-archives');renameSync(archives,moved);symlinkSync(moved,archives);
 await assert.rejects(retainArchive(second,base,'paper'),/symlinks/);
});
test('archive guard rejects initial and redirected credential echoes before dispatch',async t=>{
 const requests=[],observed=[],marker='synthetic-credential-echo',raw=zip([]);
 const server=createServer((request,response)=>{
  requests.push(request.url);
  if(request.url==='/redirect'){response.writeHead(302,{Location:`http://127.0.0.1:${server.address().port}/blocked?token=${marker}`});response.end();}
  else{response.writeHead(200);response.end(raw);}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const previous=axios.defaults.proxy;axios.defaults.proxy=false;t.after(()=>{axios.defaults.proxy=previous;});
 const base=`http://127.0.0.1:${server.address().port}`;
 const guard=(url,headers)=>{observed.push({url,headers});if(url.includes(marker))throw new Error('Blocked credential echo');};
 await assert.rejects(fetchArchive(`${base}/initial?token=${marker}`,guard),/Blocked credential echo/);assert.deepEqual(requests,[]);
 await assert.rejects(fetchArchive(`${base}/redirect`,guard),/Blocked credential echo/);assert.deepEqual(requests,['/redirect']);
 assert.ok(observed.some(item=>item.url===`${base}/blocked?token=${marker}`&&item.headers));
 assert.deepEqual(await fetchArchive(`${base}/download`,guard),raw);assert.deepEqual(requests,['/redirect','/download']);
});
test('typed lifecycle handles failed plus pending, cancellation, unknown, and all results independently of pagination',()=>{
 const mixed=lifecycle('b',[{state:'failed'},...Array.from({length:20},()=>({state:'pending'}))]);assert.equal(mixed.pollable,true);assert.equal(mixed.counts.pending,20);
 assert.equal(lifecycle('b',[{state:'done'},{state:'cancelled'}]).state,'partial');assert.equal(lifecycle('b',[{state:'new-state'}]).state,'unknown');assert.equal(lifecycle('b',[]).state,'unknown');
});
