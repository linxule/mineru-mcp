/**
 * Contained writes on Node 18 without a native openat binding.
 *
 * Each worker inherits the pinned directory descriptor and starts with that
 * directory as its cwd. It checks cwd against the descriptor before mutation.
 * Its relative, single-component operations therefore use the kernel's pinned
 * cwd, even if another process renames the pathname while a ZIP is inspected.
 */
import { constants, openSync, closeSync, fstatSync, lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export class ContainmentError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'ContainmentError'; }
}
export interface FileIdentity { dev: string; ino: string; kind: 'directory' | 'file' | 'symlink' | 'other'; size: number; }
export interface ContainedFile { path: string; bytes: Buffer | string; optional?: boolean; }
const workerPath = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './filesystem_worker.ts' : './filesystem_worker.js', import.meta.url));
// Keep source-mode tsx loaders, without forwarding eval/input-type/debug flags.
const workerLoaders:string[]=[];
const parentRequire=createRequire(join(process.cwd(),'filesystem-loader.cjs'));
function absoluteLoader(argument:string):string {
  if(/^(?:file|data|node):/.test(argument))return argument;
  if(argument.startsWith('/')||argument.startsWith('.'))return resolve(argument);
  try{return parentRequire.resolve(argument);}catch{return argument;}
}
if(import.meta.url.endsWith('.ts'))for(let i=0;i<process.execArgv.length;i++) {
  const argument=process.execArgv[i];
  if(['--require','-r','--loader','--experimental-loader','--import'].includes(argument)) {
    workerLoaders.push(argument,absoluteLoader(process.execArgv[++i]));
  }else if(/^--(?:require|loader|experimental-loader|import)=/.test(argument)) {
    const separator=argument.indexOf('=');workerLoaders.push(argument.slice(0,separator+1)+absoluteLoader(argument.slice(separator+1)));
  }
}
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
function requirePlatform():void {
  if(!['darwin','linux'].includes(process.platform)||!Number.isInteger(constants.O_NOFOLLOW)||!constants.O_NOFOLLOW||!Number.isInteger(constants.O_DIRECTORY)||!constants.O_DIRECTORY)throw new ContainmentError('unsafe_path','Contained output requires macOS or Linux directory and nofollow descriptors');
}
function sameIdentity(fd: number, named: FileIdentity): boolean {
  const stat = fstatSync(fd, { bigint: true });
  return stat.isDirectory() && named.kind === 'directory' && String(stat.dev) === named.dev && String(stat.ino) === named.ino;
}
function invoke(path: string, fd: number, command: Record<string, unknown>, input?: Buffer, rawLimit?: number): any {
  requirePlatform();
  const result = spawnSync(process.execPath, [...workerLoaders,workerPath, JSON.stringify(command)], {
    cwd: path, stdio: ['pipe', 'pipe', 'pipe', fd], input,
    maxBuffer: rawLimit === undefined ? 1024 * 1024 : Math.max(1024 * 1024, rawLimit + 1),
    timeout: 120_000,
  });
  if (result.error) throw new ContainmentError('unsafe_path', `Contained filesystem worker could not run: ${result.error.message}`);
  if (result.status !== 0) {
    let error: { code?: string; message?: string } = {};
    try { error = JSON.parse(result.stderr.toString()); } catch { /* Fail closed on an incomplete worker response. */ }
    throw new ContainmentError(error.code ?? 'unsafe_path', error.message ?? 'Contained filesystem worker failed');
  }
  if (rawLimit !== undefined) return result.stdout;
  try { return JSON.parse(result.stdout.toString()); }
  catch { throw new ContainmentError('unsafe_path', 'Contained filesystem worker returned an invalid response'); }
}

export class PinnedDirectory {
  private closed = false;
  constructor(public readonly path: string, private readonly fd: number) {}
  private run(command: Record<string, unknown>, input?: Buffer, rawLimit?: number): any {
    if (this.closed) throw new ContainmentError('unsafe_path', 'Pinned directory is closed');
    this.assertUnchanged();
    return invoke(this.path, this.fd, { ...command, root: this.path }, input, rawLimit);
  }
  assertUnchanged(): void {
    if(this.closed)throw new ContainmentError('unsafe_path','Pinned directory is closed');
    const root=parse(this.path).root;let current=root;
    try {
      for(const part of this.path.slice(root.length).split('/').filter(Boolean)) {
        current=join(current,part);
        if(!lstatSync(current).isDirectory())throw new ContainmentError('unsafe_path','Output path must use real directories without symlinks');
      }
      const named=lstatSync(this.path,{bigint:true}),pinned=fstatSync(this.fd,{bigint:true});
      if(!named.isDirectory() || named.dev!==pinned.dev || named.ino!==pinned.ino)throw new ContainmentError('unsafe_path','Pinned output directory was replaced');
    }catch(error){if(error instanceof ContainmentError)throw error;throw new ContainmentError('unsafe_path','Pinned output directory was replaced');}
  }
  stat(relative: string): FileIdentity | null { return this.run({ action: 'stat', path: relative }); }
  exists(relative: string): boolean { return this.stat(relative) !== null; }
  mkdir(relative: string): void { this.run({ action: 'mkdir', path: relative }); }
  temporaryDirectory(prefix: string): string {
    if (!/^[A-Za-z0-9_.-]+$/.test(prefix)) throw new ContainmentError('unsafe_path', 'Unsafe temporary directory prefix');
    const relative = `${prefix}${randomUUID()}`;
    this.mkdir(relative); return relative;
  }
  openDirectory(relative: string, create = false): PinnedDirectory {
    const named: FileIdentity = this.run({ action: 'directory', path: relative, create });
    const path = join(this.path, relative);
    const fd = openSync(path, directoryFlags);
    try {
      if (!sameIdentity(fd, named)) throw new ContainmentError('unsafe_path', 'Directory changed while pinning');
      const child = new PinnedDirectory(path, fd);
      child.assertUnchanged(); return child;
    } catch (error) { closeSync(fd); throw error; }
  }
  writeFile(relative: string, bytes: Buffer | string): void {
    this.run({ action: 'write', path: relative }, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  }
  /** One worker transaction avoids per-member process startup for image sets. */
  writeFiles(files: ContainedFile[], directories: string[] = [], sync: string[] = []): Array<{path:string;code:string;message:string}> {
    let actions:Record<string,unknown>[]=[],buffers:Buffer[]=[],byteCount=0,metadataBytes=0;
    const failures:Array<{path:string;code:string;message:string}>=[];
    const flush=()=>{
      if(!actions.length)return;
      failures.push(...this.run({action:'batch',actions},buffers.length===1?buffers[0]:Buffer.concat(buffers)));
      actions=[];buffers=[];byteCount=0;metadataBytes=0;
    };
    const add=(action:Record<string,unknown>,bytes?:Buffer)=>{
      const size=Buffer.byteLength(JSON.stringify(action));
      // Bound the single argv argument below Linux's per-argument limit and
      // bound retained batch buffers independently of the number of aliases.
      if(actions.length && (actions.length>=128 || metadataBytes+size>32*1024 || byteCount+(bytes?.length??0)>8*1024*1024))flush();
      actions.push(action);metadataBytes+=size;
      if(bytes){buffers.push(bytes);byteCount+=bytes.length;}
    };
    for(const path of directories)add({action:'mkdir',path});
    for(const file of files) {
      const bytes=Buffer.isBuffer(file.bytes)?file.bytes:Buffer.from(file.bytes);
      add({action:'write',path:file.path,length:bytes.length,optional:file.optional??false},bytes);
    }
    for(const path of sync)add({action:'sync',path});
    flush();return failures;
  }
  readFile(relative: string, maxBytes: number): Buffer {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new ContainmentError('limit_exceeded', 'Invalid file byte limit');
    return this.run({ action: 'read', path: relative, maxBytes }, undefined, maxBytes);
  }
  hashFile(relative: string, maxBytes: number): { sha256: string; size_bytes: number } {
    return this.run({ action: 'hash', path: relative, maxBytes });
  }
  /** Renames direct siblings. Atomic replacement is explicit for mutable journals. */
  rename(from: string, to: string, options: { replace?: boolean } = {}): void {
    this.run({ action: 'rename', from, to, replace: options.replace ?? false });
  }
  remove(relative: string): void { this.run({ action: 'remove', path: relative }); }
  sync(relative = ''): void { this.run({ action: 'sync', path: relative }); }
  syncDirectories(paths: string[]): void {this.writeFiles([],[],paths);}
  close(): void { if (!this.closed) { this.closed = true; closeSync(this.fd); } }
}

/** Creates components only from pinned cwd, then retains the final inode. */
export function pinOutput(path: string, create = true): PinnedDirectory {
  requirePlatform();
  const absolute = resolve(path), root = parse(absolute).root;
  const rootFd = openSync(root, directoryFlags);
  let named: FileIdentity;
  try { named = invoke(root, rootFd, { action: 'initialize', path: absolute, create }); }
  finally { closeSync(rootFd); }
  const fd = openSync(absolute, directoryFlags);
  try {
    if (!sameIdentity(fd, named)) throw new ContainmentError('unsafe_path', 'Output directory changed while pinning');
    const pinned = new PinnedDirectory(absolute, fd);
    pinned.assertUnchanged(); return pinned;
  } catch (error) { closeSync(fd); throw error; }
}
