import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectZip,DEFAULT_LIMITS,sha256} from '../dist/bundle/archive.js';
import {zip} from './zip-fixture.mjs';
const one=name=>zip([{name,body:'data'}]);
test('inventory preserves directory order, opaque bytes, deflate and observed hashes',async()=>{
 const raw=zip([{name:'nested/'},{name:'nested/full.md',body:'# title',deflate:true},{name:'raw.bin',body:Buffer.from([0,255])}]);
 const out=await inspectZip(raw);assert.equal(out.sha256,sha256(raw));assert.equal(out.members.length,3);assert.equal(out.members[0].sha256,null);assert.equal(out.members[1].sha256,sha256(Buffer.from('# title')));assert.equal(out.members[2].role,'unknown');
});
for(const name of ['../x','a/../x','/etc/x','C:/x','a\\b','a//b','a/./b','a\u0000b','a\u0080b']) test(`reject unsafe path ${JSON.stringify(name)}`,async()=>assert.rejects(()=>inspectZip(one(name))));
for(const names of [['x','x'],['X','x'],['é','e\u0301'],['ß','ss'],['ß','ẞ'],['a','a/b'],['a/b','a']]) test(`reject collision ${JSON.stringify(names)}`,async()=>assert.rejects(()=>inspectZip(zip(names.map(name=>({name,body:'a'}))))));
test('reject symlinks, devices, encryption and central-local mismatch',async()=>{
 for(const mode of [0xa1ff,0x21a4,0x61a4]) await assert.rejects(()=>inspectZip(zip([{name:'link',body:'target',mode}])));
 await assert.rejects(()=>inspectZip(zip([{name:'secret',body:'x',flags:1}])));
 const bad=one('good');bad[30]=120;await assert.rejects(()=>inspectZip(bad),/Inconsistent local/);
});
test('reject corrupt CRC, truncation, count, expanded and ratio limits',async()=>{
 const bad=one('x');bad[31]^=1;await assert.rejects(()=>inspectZip(bad),/integrity/);
 await assert.rejects(()=>inspectZip(bad.subarray(0,bad.length-1)));
 await assert.rejects(()=>inspectZip(one('x'),{...DEFAULT_LIMITS,max_members:0}));
 await assert.rejects(()=>inspectZip(one('x'),{...DEFAULT_LIMITS,max_member_bytes:3}));
 await assert.rejects(()=>inspectZip(zip([{name:'x',body:'x'.repeat(10000),deflate:true}]),{...DEFAULT_LIMITS,max_compression_ratio:2}));
});
