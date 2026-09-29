import {crc32} from '../dist/bundle/archive.js';
import {deflateRawSync} from 'node:zlib';
export function zip(files) {
  const local=[],central=[];let offset=0;
  for(const f of files) {
    const path=Buffer.from(f.name),body=Buffer.from(f.body??''),packed=f.deflate?deflateRawSync(body):body, crc=crc32(body),method=f.deflate?8:0;
    const a=Buffer.alloc(30);a.writeUInt32LE(0x04034b50);a.writeUInt16LE(20,4);a.writeUInt16LE(f.flags??0x800,6);a.writeUInt16LE(method,8);a.writeUInt32LE(crc,14);a.writeUInt32LE(packed.length,18);a.writeUInt32LE(body.length,22);a.writeUInt16LE(path.length,26);
    const b=Buffer.alloc(46);b.writeUInt32LE(0x02014b50);b.writeUInt16LE(0x314,4);b.writeUInt16LE(20,6);b.writeUInt16LE(f.flags??0x800,8);b.writeUInt16LE(method,10);b.writeUInt32LE(crc,16);b.writeUInt32LE(packed.length,20);b.writeUInt32LE(body.length,24);b.writeUInt16LE(path.length,28);b.writeUInt32LE(((f.mode??(f.name.endsWith('/')?0x41ed:0x81a4))<<16)>>>0,38);b.writeUInt32LE(offset,42);
    local.push(a,path,packed);central.push(b,path);offset+=30+path.length+packed.length;
  }
  const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,cd,end]);
}
