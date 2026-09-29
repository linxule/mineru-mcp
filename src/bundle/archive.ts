import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { casefold } from './casefold.js';
import { createInflateRaw, inflateRawSync } from 'node:zlib';
export const DEFAULT_LIMITS = { max_archive_bytes: 512 * 1024 * 1024, max_members: 20000, max_member_bytes: 512 * 1024 * 1024, max_total_uncompressed_bytes: 2 * 1024 * 1024 * 1024, max_compression_ratio: 1000, max_manifest_bytes: 16 * 1024 * 1024 };
export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export function crc32(bytes: Uint8Array): number { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
export type InventoryMember = { member_id: string; entry_index: number; path: string; kind: 'file'|'directory'; sha256: string|null; size_bytes: number; compressed_size_bytes: number; role: string; format_schema: null; format_version: null; media_type: string|null };
export function safeMemberPath(name: string): string {
  const path = name.endsWith('/') ? name.slice(0, -1) : name;
  if (!path || name.length > 4096 || /[\\\x00-\x1f\x7f-\x9f]/.test(name) || /^\/|^[A-Za-z]:/.test(name) || path.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Unsafe ZIP member path');
  return path;
}
export function roleFor(name: string): {role:string;media_type:string} {
  if (/\.md$/i.test(name)) return {role:'markdown', media_type:'text/markdown'};
  if (/\.json$/i.test(name)) return {role:'structured_json',media_type:'application/json'};
  const img = /\.(png|jpe?g|webp|gif|svg)$/i.exec(name);
  if (img) return {role:'image',media_type: img[1].toLowerCase() === 'svg' ? 'image/svg+xml' : `image/${img[1].toLowerCase().replace('jpg','jpeg')}`};
  return {role:'unknown',media_type:'application/octet-stream'};
}
/** Fail closed on unsupported ZIP64/multidisk/encryption. Never extract provider paths. */
export async function inspectZip(bytes: Buffer, limits = DEFAULT_LIMITS) {
  if (bytes.length > limits.max_archive_bytes) throw new Error('Archive byte limit exceeded');
  const need = (offset:number,length:number) => { if (offset < 0 || length < 0 || offset + length > bytes.length) throw new Error('Truncated ZIP'); };
  let end = -1;
  for (let p=bytes.length-22; p>=Math.max(0,bytes.length-65557); p--) if (bytes.readUInt32LE(p) === 0x06054b50 && p+22+bytes.readUInt16LE(p+20)===bytes.length) { end=p; break; }
  if (end<0) throw new Error('Missing ZIP central directory');
  const count=bytes.readUInt16LE(end+10), centralSize=bytes.readUInt32LE(end+12), centralStart=bytes.readUInt32LE(end+16);
  if (bytes.readUInt16LE(end+4) || bytes.readUInt16LE(end+6) || bytes.readUInt16LE(end+8)!==count || count===65535 || centralStart===0xffffffff || centralSize===0xffffffff) throw new Error('Unsupported multidisk or ZIP64 archive');
  if (count>limits.max_members || centralStart+centralSize!==end) throw new Error('Invalid ZIP directory bounds or entry limit');
  const entries: Array<{member:InventoryMember;bytes:Buffer}>=[], names=new Map<string,boolean>(), spans:Array<[number,number]>=[];
  let pos=centralStart,total=0;
  for (let index=0;index<count;index++) {
    need(pos,46); if(bytes.readUInt32LE(pos)!==0x02014b50) throw new Error('Invalid central ZIP header');
    const flags=bytes.readUInt16LE(pos+8), method=bytes.readUInt16LE(pos+10), crc=bytes.readUInt32LE(pos+16), compressed=bytes.readUInt32LE(pos+20), size=bytes.readUInt32LE(pos+24), nl=bytes.readUInt16LE(pos+28), el=bytes.readUInt16LE(pos+30), cl=bytes.readUInt16LE(pos+32), external=bytes.readUInt32LE(pos+38), local=bytes.readUInt32LE(pos+42);
    need(pos+46,nl+el+cl); if(pos+46+nl+el+cl>end) throw new Error('Central entry outside directory');
    if(flags & ~0x080e || flags & 1 || ![0,8].includes(method) || bytes.readUInt16LE(pos+34)) throw new Error('Unsupported ZIP flags, compression, or disk');
    const rawName=bytes.subarray(pos+46,pos+46+nl);
    // Legacy ASCII is unambiguous; non-UTF8 names need an explicit supported decoder.
    if(!(flags&0x800) && rawName.some(b=>b>127)) throw new Error('Unsupported ZIP filename encoding');
    const name=new TextDecoder('utf-8',{fatal:true}).decode(rawName), clean=safeMemberPath(name), directory=name.endsWith('/');
    const unixType=(external>>>16)&0xf000;
    if(unixType && unixType!==(directory?0x4000:0x8000)) throw new Error('ZIP special file or inconsistent member type');
    if((external&0x10)!==0 && !directory) throw new Error('Inconsistent ZIP directory type');
    const checkExtra=(start:number,length:number) => { for(let p=start;p<start+length;) { if(p+4>start+length) throw new Error('Invalid ZIP extra'); const id=bytes.readUInt16LE(p),n=bytes.readUInt16LE(p+2); if(p+4+n>start+length || [1,0x000d,0x756e].includes(id)) throw new Error('Unsupported ZIP link or ZIP64 extra'); p+=4+n; } };
    checkExtra(pos+46+nl,el);
    const key=casefold(clean.normalize('NFC'));
    if(names.has(key)) throw new Error('Duplicate or normalized ZIP path collision');
    for(const [other,isDir] of names) if((key.startsWith(other+'/')&&!isDir)||(other.startsWith(key+'/')&&!directory)) throw new Error('ZIP file-directory prefix collision');
    names.set(key,directory);
    if(size>limits.max_member_bytes || total+size>limits.max_total_uncompressed_bytes || size/Math.max(1,compressed)>limits.max_compression_ratio) throw new Error('ZIP expanded byte or ratio limit exceeded');
    need(local,30); if(bytes.readUInt32LE(local)!==0x04034b50) throw new Error('Missing local ZIP header');
    const lnl=bytes.readUInt16LE(local+26),lel=bytes.readUInt16LE(local+28), dataStart=local+30+lnl+lel;
    need(local+30,lnl+lel); need(dataStart,compressed);
    if(local>=centralStart || dataStart+compressed>centralStart || flags!==bytes.readUInt16LE(local+6) || method!==bytes.readUInt16LE(local+8) || !rawName.equals(bytes.subarray(local+30,local+30+lnl))) throw new Error('Inconsistent local ZIP entry');
    checkExtra(local+30+lnl,lel);
    if(!(flags&8) && (crc!==bytes.readUInt32LE(local+14)||compressed!==bytes.readUInt32LE(local+18)||size!==bytes.readUInt32LE(local+22))) throw new Error('Inconsistent local ZIP sizes or CRC');
    if(spans.some(([a,b])=>local<b && dataStart+compressed>a)) throw new Error('Overlapping ZIP entries');
    spans.push([local,dataStart+compressed]);
    const packed=bytes.subarray(dataStart,dataStart+compressed);
    let observed=0, runningCrc=0xffffffff; const digest=createHash('sha256');
    const stream=method===0?Readable.from([packed]):Readable.from([packed]).pipe(createInflateRaw());
    try {
      for await(const chunk of stream) {
        observed+=chunk.length;
        if(observed>size || observed>limits.max_member_bytes || total+observed>limits.max_total_uncompressed_bytes || observed/Math.max(1,compressed)>limits.max_compression_ratio) throw new Error('ZIP observed expanded byte or ratio limit exceeded');
        digest.update(chunk);
        for(const byte of chunk) { runningCrc^=byte;for(let k=0;k<8;k++) runningCrc=(runningCrc>>>1)^(0xedb88320&-(runningCrc&1)); }
      }
    } finally { stream.destroy(); }
    if(observed!==size || ((runningCrc^0xffffffff)>>>0)!==crc || (directory && size!==0)) throw new Error('ZIP observed size or integrity mismatch');
    total+=observed;
    const member:InventoryMember={member_id:`member-${index}`,entry_index:index,path:name,kind:directory?'directory':'file',sha256:directory?null:digest.digest('hex'),size_bytes:observed,compressed_size_bytes:compressed,role:directory?'directory':roleFor(name).role,format_schema:null,format_version:null,media_type:directory?null:roleFor(name).media_type};
    // Inventory retains only archive bytes. Expand selected outputs on demand,
    // with a stricter compatibility-materialization bound than raw inventory.
    const selectedBytes=()=> { if(size>64*1024*1024) throw new Error('Selected compatibility output exceeds 64 MiB');return method===0?packed:inflateRawSync(packed,{maxOutputLength:Math.max(1,size)}); };
    entries.push({member,get bytes(){return selectedBytes();}}); pos+=46+nl+el+cl;
  }
  if(pos!==end) throw new Error('ZIP entry count mismatch');
  return {members:entries.map(e=>e.member),entries,sha256:sha256(bytes),size_bytes:bytes.length};
}
