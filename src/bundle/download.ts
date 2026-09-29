import { mkdirSync, writeFileSync, existsSync, lstatSync, renameSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve, parse, posix } from 'node:path';
import { randomBytes } from 'node:crypto';
import axios from 'axios';
import { DEFAULT_LIMITS, inspectZip, sha256 } from './archive.js';
export function safeOutput(path: string): string {
  const full=resolve(path),root=parse(full).root;
  let current=root;
  for(const part of full.slice(root.length).split('/').filter(Boolean)) { current=join(current,part); if(existsSync(current) && (lstatSync(current).isSymbolicLink() || !lstatSync(current).isDirectory())) throw new Error('Output path must use real directories without symlinks'); }
  mkdirSync(full,{recursive:true}); return full;
}
export async function fetchArchive(url:string): Promise<Buffer> {
  // Read-only downloads may be explicitly retried by the caller. Never retry silently.
  const response=await axios.get(url,{responseType:'stream',timeout:120000,maxRedirects:5});
  const chunks:Buffer[]=[]; let total=0;
  try { for await(const chunk of response.data) { const data=Buffer.from(chunk);total+=data.length; if(total>DEFAULT_LIMITS.max_archive_bytes) throw new Error('Archive byte limit exceeded'); chunks.push(data); } }
  catch(error) { response.data.destroy();throw error; }
  return Buffer.concat(chunks,total);
}
export async function retainArchive(bytes:Buffer, output:string, stem:string, overwrite=false) {
  const root=safeOutput(output);
  if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(stem)) throw new Error('Unsafe output stem');
  const digest=sha256(bytes), destination=join(root,stem);
  let inventory:Awaited<ReturnType<typeof inspectZip>>;
  try { inventory=await inspectZip(bytes); } catch(error) {
    const quarantine=join(root,'quarantine');safeOutput(quarantine); const raw=join(quarantine,`${digest}.zip`);
    if(!existsSync(raw)) writeFileSync(raw,bytes,{flag:'wx'});
    throw new Error(`Archive quarantined at ${raw}: ${error instanceof Error?error.message:String(error)}`);
  }
  if(existsSync(destination)) {
    if(lstatSync(destination).isSymbolicLink() || !lstatSync(destination).isDirectory()) throw new Error('Unsafe existing result directory');
    const existing=join(destination,'archives',`${digest}.zip`);
    if(existsSync(existing) && !lstatSync(existing).isSymbolicLink() && sha256(readFileSync(existing))===digest) return {directory:destination,inventory,skipped:true};
    if(!overwrite) throw new Error('Existing result has different or unverified archive bytes; use another output directory or overwrite');
  }
  const stage=join(root,`.stage-${randomBytes(12).toString('hex')}`);mkdirSync(stage);
  try {
    mkdirSync(join(stage,'archives'));writeFileSync(join(stage,'archives',`${digest}.zip`),bytes,{flag:'wx'});
    // Diagnostic inventory is deliberately not an importable PDF bundle: source is unbound.
    writeFileSync(join(stage,'inventory.json'),JSON.stringify({schema:'mineru.diagnostic-inventory.v1',source_binding:'unknown',archive:{sha256:digest,size_bytes:bytes.length,members:inventory.members},page_provenance:'unknown'},null,2));
    const files=inventory.entries.filter(e=>e.member.kind==='file');
    const primary=files.filter(e=>/(^|\/)(?:[^/]*_)?full\.md$/.test(e.member.path));
    const content=files.filter(e=>/(^|\/)(?:[^/]*_)?content_list(?:_v2)?\.json$/.test(e.member.path));
    const warnings:Array<{code:string;message:string}>=[];
    const copySelected=(path:string,entry:typeof files[number])=>{
      try { writeFileSync(path,entry.bytes,{flag:'wx'}); }
      catch { warnings.push({code:'compatibility_output_unavailable',message:`Selected member ${entry.member.member_id} exceeds local materialization limits or could not be written; exact bytes retained in archive.`}); }
    };
    if(primary.length===1) copySelected(join(stage,`${stem}.md`),primary[0]);
    if(content.length===1) copySelected(join(stage,`${stem}_content.json`),content[0]);
    // Compatibility image aliases are derived copies relative to the selected
    // Markdown member; no first-basename selection across nested documents.
    const mdDir=primary.length===1?posix.dirname(primary[0].member.path):null;
    const imagePrefix=mdDir==='.'?'images/':`${mdDir}/images/`;
    const images=mdDir===null?[]:files.filter(e=>e.member.path.startsWith(imagePrefix)&&!e.member.path.slice(imagePrefix.length).includes('/'));
    if(images.length) { mkdirSync(join(stage,'images'));for(const image of images) copySelected(join(stage,'images',image.member.path.slice(imagePrefix.length)),image); }
    if(primary.length!==1) warnings.push({code:primary.length?'ambiguous_markdown':'missing_markdown',message:'No unique primary Markdown selected; archive remains complete.'});
    if(content.length>1) warnings.push({code:'ambiguous_structured_json',message:'Multiple candidate content files retained without arbitrary selection.'});
    writeFileSync(join(stage,'warnings.json'),JSON.stringify(warnings,null,2));
    if(existsSync(destination)) { const backup=join(root,`${stem}.previous-${randomBytes(6).toString('hex')}`);renameSync(destination,backup);try {renameSync(stage,destination);} catch(error) {renameSync(backup,destination);throw error;} }
    else renameSync(stage,destination);
    return {directory:destination,inventory,skipped:false,warnings};
  } finally { if(existsSync(stage)) rmSync(stage,{recursive:true,force:true}); }
}
