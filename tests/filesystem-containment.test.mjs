import {temporaryPrefix} from './temp-dir.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,renameSync,symlinkSync,readdirSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pinOutput} from '../dist/bundle/filesystem.js';
import {sha256} from '../dist/bundle/archive.js';

function fixture(t){
 const base=mkdtempSync(temporaryPrefix('mineru-filesystem-'));t.after(()=>rmSync(base,{recursive:true,force:true}));
 const root=pinOutput(join(base,'output'));t.after(()=>root.close());return{base,root};
}
test('pinned output creates, syncs, reads and publishes regular artifacts',t=>{
 const {root}=fixture(t),name=root.temporaryDirectory('.stage-'),stage=root.openDirectory(name);
 try{
  assert.deepEqual(stage.writeFiles([{path:'archives/a.zip',bytes:'exact bytes'},{path:'bundle.json',bytes:'{}'}],['archives'],['archives','']),[]);
  assert.equal(stage.readFile('archives/a.zip',20).toString(),'exact bytes');
  assert.deepEqual(stage.hashFile('archives/a.zip',20),{sha256:sha256(Buffer.from('exact bytes')),size_bytes:11});
  assert.throws(()=>stage.readFile('archives/a.zip',3),{code:'limit_exceeded'});
  root.rename(name,'published');root.sync();root.assertUnchanged();
  assert.equal(readFileSync(join(root.path,'published','bundle.json'),'utf8'),'{}');
  assert.throws(()=>root.rename('published','published'),{code:'EEXIST'});
  root.remove('published');assert.deepEqual(readdirSync(root.path),[]);
 }finally{stage.close();}
});
test('a renamed root or nested mutable parent cannot redirect writes or cleanup',async t=>{
 const {base,root}=fixture(t),outside=join(base,'outside');mkdirSync(outside);
 const nested=root.openDirectory('nested',true);
 try{
  nested.writeFile('retained','original');
  renameSync(nested.path,join(root.path,'original-nested'));symlinkSync(outside,nested.path);
  assert.throws(()=>nested.writeFile('escape','x'),{code:'unsafe_path'});
  assert.throws(()=>root.writeFile('nested/escape','x'),{code:'unsafe_path'});
  root.remove('nested');assert.deepEqual(readdirSync(outside),[]);
  await Promise.resolve();
  renameSync(root.path,join(base,'original-output'));symlinkSync(outside,root.path);
  assert.throws(()=>root.writeFile('escape','x'),{code:'unsafe_path'});
  assert.throws(()=>root.remove('original-nested'),{code:'unsafe_path'});
  assert.deepEqual(readdirSync(outside),[]);
 }finally{nested.close();}
});
test('5000 optional long-name aliases are batched below OS command limits',t=>{
 const {root}=fixture(t),files=Array.from({length:5000},(_,i)=>({path:`images/${String(i).padStart(5,'0')}-${'x'.repeat(205)}.png`,bytes:Buffer.from([i%256]),optional:true}));
 assert.deepEqual(root.writeFiles(files,['images'],['images','']),[]);
 assert.equal(readdirSync(join(root.path,'images')).length,5000);
 assert.deepEqual(root.readFile(files.at(-1).path,1),files.at(-1).bytes);
 root.assertUnchanged();
});
