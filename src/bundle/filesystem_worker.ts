/** Private subprocess entry point for filesystem.ts; no provider/network access. */
import {
  constants, openSync, closeSync, fstatSync, statSync, lstatSync, mkdirSync,
  writeFileSync, readFileSync, readSync, fsyncSync, renameSync, readdirSync,
  unlinkSync, rmdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, parse, resolve } from 'node:path';
import type { BigIntStats } from 'node:fs';

const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const fail = (message: string): never => { throw Object.assign(new Error(message), { code: 'unsafe_path' }); };
const identity = (st: BigIntStats) => ({ dev: String(st.dev), ino: String(st.ino), kind: st.isDirectory() ? 'directory' : st.isFile() ? 'file' : st.isSymbolicLink() ? 'symlink' : 'other', size: Number(st.size) });
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const parents:number[]=[];
function components(path: string, empty = false): string[] {
  if ((path === '' && empty)) return [];
  if (!path || path.startsWith('/') || /[\\\x00]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) fail('Unsafe relative output path');
  return path.split('/');
}
function namedComponents(path: string): void {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, component);
    const st = lstatSync(current, { bigint: true });
    if (!st.isDirectory() || st.isSymbolicLink()) fail('Output path must use real directories without symlinks');
  }
}
/** chdir pins the opened inode; any redirected chdir is rejected before use. */
function enter(parts: string[], create = false): void {
  for (const component of parts) {
    let created=false;
    if (create) { try { mkdirSync(component, { mode: 0o700 });created=true; } catch (error: any) { if (error.code !== 'EEXIST') throw error; } }
    const named = lstatSync(component, { bigint: true });
    if (!named.isDirectory() || named.isSymbolicLink()) fail('Output path must use real directories without symlinks');
    const parentFd=openSync('.',flags);
    let fd:number;
    try {fd=openSync(component, flags);}catch(error){closeSync(parentFd);throw error;}
    try {
      const expected = fstatSync(fd, { bigint: true });
      if (!expected.isDirectory()) fail('Output path component is not a directory');
      if(created){fsyncSync(fd);fsyncSync(parentFd);}
      process.chdir(component);
      if (!same(expected, statSync('.', { bigint: true }))) fail('Output directory changed while entering');
      parents.push(parentFd);
    } catch(error) {closeSync(parentFd);throw error;
    } finally { closeSync(fd); }
  }
}
function restore():void {
  while(parents.length) {
    const parentFd=parents.pop()!;
    try {
      process.chdir('..');
      if(!same(fstatSync(parentFd,{bigint:true}),statSync('.',{bigint:true})))fail('Output parent directory changed during transaction');
    }finally{closeSync(parentFd);}
  }
}
function parent(path: string): string {
  const parts = components(path), leaf = parts.pop()!;
  enter(parts); return leaf;
}
function regular(path: string, maxBytes: number, hash = false): Buffer | { sha256: string; size_bytes: number } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw Object.assign(new Error('Invalid byte limit'), { code: 'limit_exceeded' });
  const leaf = parent(path), fd = openSync(leaf, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) fail('Input must be a regular file');
    if (before.size > BigInt(maxBytes)) throw Object.assign(new Error('Input exceeds byte limit'), { code: 'limit_exceeded' });
    const digest = createHash('sha256'), chunks: Buffer[] = []; let total = 0;
    const chunk = Buffer.alloc(Math.min(1024 * 1024, maxBytes + 1));
    while (true) {
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count;
      if (total > maxBytes) throw Object.assign(new Error('Input exceeds byte limit'), { code: 'limit_exceeded' });
      if (hash) digest.update(chunk.subarray(0, count)); else chunks.push(Buffer.from(chunk.subarray(0, count)));
    }
    const after = fstatSync(fd, { bigint: true }), named = lstatSync(leaf, { bigint: true });
    if (!same(before, named) || !named.isFile() || before.size !== BigInt(total) || after.size !== before.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw Object.assign(new Error('Input changed during read'), { code: 'input_changed' });
    return hash ? { sha256: digest.digest('hex'), size_bytes: total } : Buffer.concat(chunks, total);
  } finally { closeSync(fd); }
}
/** Recursive cleanup also pins each child; fs.rm's path walk is not used. */
function remove(leaf: string, depth = 0): void {
  let st: BigIntStats;
  try { st = lstatSync(leaf, { bigint: true }); } catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
  if (!st.isDirectory() || st.isSymbolicLink()) { unlinkSync(leaf); return; }
  if (depth > 128) fail('Cleanup depth limit exceeded');
  const parentFd = openSync('.', flags), childFd = openSync(leaf, flags);
  try {
    const expected = fstatSync(childFd, { bigint: true });
    process.chdir(leaf);
    if (!same(expected, statSync('.', { bigint: true }))) fail('Cleanup directory changed while entering');
    for (const child of readdirSync('.')) remove(child, depth + 1);
    process.chdir('..');
    if (!same(fstatSync(parentFd, { bigint: true }), statSync('.', { bigint: true }))) fail('Cleanup parent directory changed');
    if (!same(expected, lstatSync(leaf, { bigint: true }))) fail('Cleanup directory was replaced');
    rmdirSync(leaf);
  } finally { closeSync(childFd); closeSync(parentFd); }
}
function main(command: any, input?:Buffer): unknown {
  const expected = fstatSync(3, { bigint: true });
  if (!expected.isDirectory() || !same(expected, statSync('.', { bigint: true }))) fail('Pinned output directory was replaced');
  if (command.root) {
    namedComponents(command.root);
    if (!same(expected, lstatSync(command.root, { bigint: true }))) fail('Pinned output directory was replaced');
  }
  switch (command.action) {
    case 'initialize': {
      const absolute = resolve(command.path), root = parse(absolute).root;
      enter(absolute.slice(root.length).split('/').filter(Boolean), command.create);
      return identity(statSync('.', { bigint: true }));
    }
    case 'assert': return null;
    case 'directory': enter(components(command.path), command.create); return identity(statSync('.', { bigint: true }));
    case 'stat': {
      const leaf = parent(command.path);
      try { return identity(lstatSync(leaf, { bigint: true })); } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
    }
    case 'mkdir': {
      const leaf=parent(command.path);mkdirSync(leaf,{mode:0o700});
      const childFd=openSync(leaf,flags),parentFd=openSync('.',flags);
      try{fsyncSync(childFd);fsyncSync(parentFd);}finally{closeSync(childFd);closeSync(parentFd);}
      return null;
    }
    case 'write': {
      const leaf = parent(command.path), bytes = input??readFileSync(0);
      const fd = openSync(leaf, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      return null;
    }
    case 'read': return regular(command.path, command.maxBytes);
    case 'hash': return regular(command.path, command.maxBytes, true);
    case 'sync': {
      enter(components(command.path, true));
      const fd = openSync('.', flags); try { fsyncSync(fd); } finally { closeSync(fd); } return null;
    }
    case 'rename': {
      components(command.from); components(command.to);
      if (dirname(command.from) !== dirname(command.to)) fail('Contained rename requires sibling paths');
      const from = parent(command.from), to = basename(command.to), before = lstatSync(from, { bigint: true });
      if (before.isSymbolicLink() || (!before.isDirectory() && !before.isFile())) fail('Unsafe rename source');
      let destination: BigIntStats | null = null;
      try { destination = lstatSync(to, { bigint: true }); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      if (destination?.isSymbolicLink()) fail('Unsafe rename destination');
      if (destination && !command.replace) throw Object.assign(new Error('Rename destination already exists'), { code: 'EEXIST' });
      renameSync(from, to);
      if (!same(before, lstatSync(to, { bigint: true }))) fail('Published output directory was replaced');
      return null;
    }
    case 'remove': remove(parent(command.path)); return null;
    case 'batch': {
      const bytes=readFileSync(0),failures=[];let offset=0;
      for(const action of command.actions) {
        const length=action.action==='write'?action.length:0;
        if(!Number.isSafeInteger(length)||length<0||offset+length>bytes.length)fail('Invalid filesystem transaction data');
        try {main({...action,root:command.root},bytes.subarray(offset,offset+length));}
        catch(error:any) {
          if(!action.optional || ['unsafe_path','ELOOP','ENOTDIR'].includes(error?.code))throw error;
          failures.push({path:action.path,code:error?.code??'write_failed',message:error?.message??'Optional output could not be written'});
        }finally{restore();offset+=length;}
      }
      if(offset!==bytes.length)fail('Unexpected filesystem transaction data');
      return failures;
    }
    default: fail('Unknown contained filesystem action');
  }
}
try {
  const command = JSON.parse(process.argv[2]);
  const result = main(command);
  if (Buffer.isBuffer(result)) writeFileSync(1, result); else writeFileSync(1, JSON.stringify(result));
} catch (error: any) {
  writeFileSync(2, JSON.stringify({ code: error?.code ?? 'unsafe_path', message: error instanceof Error ? error.message : 'Contained filesystem action failed' }));
  process.exitCode = 1;
}
