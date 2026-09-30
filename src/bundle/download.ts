import { join, posix, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import axios from 'axios';
import { DEFAULT_LIMITS, inspectZip, sha256 } from './archive.js';
import { ContainmentError, pinOutput, type ContainedFile, type PinnedDirectory } from './filesystem.js';
export function safeOutput(path: string): string {
  const directory=pinOutput(path);
  try { return directory.path; } finally { directory.close(); }
}
export async function fetchArchive(url:string,guard?:(url:string,headers?:Record<string,unknown>)=>void): Promise<Buffer> {
  // Read-only downloads may be explicitly retried by the caller. Never retry silently.
  guard?.(url);
  const response=await axios.get(url,{responseType:'stream',timeout:120000,maxRedirects:5,beforeRedirect:options=>{
    const hostname=options.hostname.includes(':')&&!options.hostname.startsWith('[')?`[${options.hostname}]`:options.hostname;
    const target=new URL(`${options.protocol}//${hostname}${options.port?`:${options.port}`:''}${options.path??'/'}`);
    if(options.auth){const separator=options.auth.indexOf(':');target.username=separator<0?options.auth:options.auth.slice(0,separator);if(separator>=0)target.password=options.auth.slice(separator+1);}
    guard?.(target.href,options.headers);
  }});
  const chunks:Buffer[]=[]; let total=0;
  try { for await(const chunk of response.data) { const data=Buffer.from(chunk);total+=data.length; if(total>DEFAULT_LIMITS.max_archive_bytes) throw new Error('Archive byte limit exceeded'); chunks.push(data); } }
  catch(error) { response.data.destroy();throw error; }
  return Buffer.concat(chunks,total);
}
export async function retainArchive(bytes:Buffer, output:string, stem:string, overwrite=false, providedRoot?:PinnedDirectory) {
  if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(stem)) throw new Error('Unsafe output stem');
  if(providedRoot && providedRoot.path!==resolve(output)) throw new ContainmentError('unsafe_path','Pinned output does not match requested output');
  const root=providedRoot??pinOutput(output);
  try {
  root.assertUnchanged();
  const digest=sha256(bytes), destination=join(root.path,stem);
  let inventory:Awaited<ReturnType<typeof inspectZip>>;
  try { inventory=await inspectZip(bytes); } catch(error) {
    const quarantine=root.openDirectory('quarantine',true), name=`${digest}.zip`;
    try {
      if(!quarantine.exists(name)) quarantine.writeFile(name,bytes);
      const retained=quarantine.hashFile(name,DEFAULT_LIMITS.max_archive_bytes);
      if(retained.sha256!==digest || retained.size_bytes!==bytes.length) throw new Error('Existing quarantine archive differs');
      quarantine.sync();root.sync();quarantine.assertUnchanged();root.assertUnchanged();
      throw new Error(`Archive quarantined at ${join(quarantine.path,name)}: ${error instanceof Error?error.message:String(error)}`);
    } finally { quarantine.close(); }
  }
  const replay=()=>{
    const named=root.stat(stem);
    if(!named) return false;
    if(named.kind!=='directory') throw new Error('Unsafe existing result directory');
    const existing=root.openDirectory(stem);
    try {
      let retained;
      try { retained=existing.hashFile(`archives/${digest}.zip`,DEFAULT_LIMITS.max_archive_bytes); }
      catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; return false; }
      existing.assertUnchanged();root.assertUnchanged();
      return retained.sha256===digest && retained.size_bytes===bytes.length;
    } finally { existing.close(); }
  };
  if(root.exists(stem)) {
    if(replay()) return {directory:destination,inventory,skipped:true};
    if(!overwrite) throw new Error('Existing result has different or unverified archive bytes; use another output directory or overwrite');
  }
  const stageName=root.temporaryDirectory('.stage-'),stage=root.openDirectory(stageName);
  try {
    stage.mkdir('archives');stage.writeFile(`archives/${digest}.zip`,bytes);
    // Diagnostic inventory is deliberately not an importable PDF bundle: source is unbound.
    const selected:ContainedFile[]=[{path:'inventory.json',bytes:JSON.stringify({schema:'mineru.diagnostic-inventory.v1',source_binding:'unknown',archive:{sha256:digest,size_bytes:bytes.length,members:inventory.members},page_provenance:'unknown'},null,2)}];
    const files=inventory.entries.filter(e=>e.member.kind==='file');
    const primary=files.filter(e=>/(^|\/)(?:[^/]*_)?full\.md$/.test(e.member.path));
    const content=files.filter(e=>/(^|\/)(?:[^/]*_)?content_list(?:_v2)?\.json$/.test(e.member.path));
    const warnings:Array<{code:string;message:string}>=[];
    const selectedMembers=new Map<string,string>();
    let selectedBytes=Buffer.byteLength(selected[0].bytes),selectedNames=0;
    const flushSelected=()=>{
      for(const failure of stage.writeFiles(selected))warnings.push({code:'compatibility_output_unavailable',message:`Selected member ${selectedMembers.get(failure.path)} could not be written; exact bytes retained in archive.`});
      selected.length=0;selectedMembers.clear();selectedBytes=0;selectedNames=0;
    };
    const copySelected=(path:string,entry:typeof files[number])=>{
      let bytes:Buffer;
      try { bytes=entry.bytes; }
      catch(error) {
        if(error instanceof ContainmentError && error.code==='unsafe_path') throw error;
        warnings.push({code:'compatibility_output_unavailable',message:`Selected member ${entry.member.member_id} exceeds local materialization limits or could not be written; exact bytes retained in archive.`});
        return;
      }
      selected.push({path,bytes,optional:true});selectedMembers.set(path,entry.member.member_id);
      selectedBytes+=bytes.length;selectedNames+=Buffer.byteLength(path)+100;
      if(selectedBytes>=8*1024*1024 || selected.length>=128 || selectedNames>=32*1024)flushSelected();
    };
    if(primary.length===1) copySelected(`${stem}.md`,primary[0]);
    if(content.length===1) copySelected(`${stem}_content.json`,content[0]);
    // Compatibility image aliases are derived copies relative to the selected
    // Markdown member; no first-basename selection across nested documents.
    const mdDir=primary.length===1?posix.dirname(primary[0].member.path):null;
    const imagePrefix=mdDir==='.'?'images/':`${mdDir}/images/`;
    const images=mdDir===null?[]:files.filter(e=>e.member.path.startsWith(imagePrefix)&&!e.member.path.slice(imagePrefix.length).includes('/'));
    if(images.length) { stage.mkdir('images');for(const image of images) copySelected(`images/${image.member.path.slice(imagePrefix.length)}`,image); }
    if(selected.length)flushSelected();
    if(primary.length!==1) warnings.push({code:primary.length?'ambiguous_markdown':'missing_markdown',message:'No unique primary Markdown selected; archive remains complete.'});
    if(content.length>1) warnings.push({code:'ambiguous_structured_json',message:'Multiple candidate content files retained without arbitrary selection.'});
    stage.writeFile('warnings.json',JSON.stringify(warnings,null,2));
    stage.syncDirectories(['archives',...(images.length?['images']:[]),'']);stage.assertUnchanged();
    if(root.exists(stem)) {
      if(!overwrite) {
        if(replay()) return {directory:destination,inventory,skipped:true};
        throw new Error('Existing result has different or unverified archive bytes; use another output directory or overwrite');
      }
      const backup=`${stem}.previous-${randomBytes(6).toString('hex')}`;
      root.rename(stem,backup);
      try {root.rename(stageName,stem);} catch(error) {root.rename(backup,stem);throw error;}
    } else root.rename(stageName,stem);
    root.sync();root.assertUnchanged();
    return {directory:destination,inventory,skipped:false,warnings};
  } finally {
    stage.close();
    try {root.remove(stageName);} catch(error) { if(!(error instanceof ContainmentError && error.code==='unsafe_path')) throw error; }
  }
  } finally {if(!providedRoot)root.close();}
}
