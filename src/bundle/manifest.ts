/** Offline v1.0.1 artifact preservation. This module never contacts a provider. */
import { basename, dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { inspectZip, DEFAULT_LIMITS, sha256 } from './archive.js';
import { validateBundleStructure } from './schema.js';
import { bundleSchema } from './schema.js';
import { strictLoads, canonicalBytes } from '../canonical.js';
import { VERSION } from '../version.js';
import { ContainmentError, pinOutput } from './filesystem.js';

type ObjectValue = Record<string, any>;
export class BundleError extends Error {
  constructor(public code: string, message: string, public quarantine_path?: string) {
    super(message); this.name = 'BundleError';
  }
}
export interface CreateBundleOptions {
  source: string; archive: string; output: string; batchId?: string; model?: string;
  binding?: 'unknown' | 'caller_asserted';
}

/** Shared normative structure validation; byte/semantic checks remain required. */
export function validateBundleShape(manifest: unknown): void { try { validateBundleStructure(manifest); } catch(error) { throw new BundleError('invalid_manifest', error instanceof Error ? error.message : 'Invalid manifest'); } }

export async function readRegular(path: string, maxBytes: number): Promise<Buffer> {
  path = resolve(path);
  let parent;
  try {
    parent=pinOutput(dirname(path),false);
    const bytes=parent.readFile(basename(path),maxBytes);
    parent.assertUnchanged();return bytes;
  } catch(error) {
    if(error instanceof ContainmentError && ['unsafe_path','ELOOP','ENOTDIR','limit_exceeded','input_changed'].includes(error.code)) throw new BundleError(['ELOOP','ENOTDIR'].includes(error.code)?'unsafe_path':error.code,error.message);
    throw error;
  } finally {parent?.close();}
}

/** Publish under output/bundle-<identity>; repeat inputs verify and reuse exact bytes. */
export async function createBundle(options: CreateBundleOptions) {
  const binding = options.binding ?? 'unknown';
  if (!['unknown', 'caller_asserted'].includes(binding)) throw new BundleError('invalid_binding', 'Offline bundles cannot assert a verified source binding');
  for (const value of [options.batchId, options.model]) if (value !== undefined && (!value.trim() || /[\u0000-\u001f\u007f]/u.test(value))) throw new BundleError('invalid_option', 'Expected nonempty metadata without control characters');
  const source = await readRegular(options.source, DEFAULT_LIMITS.max_archive_bytes);
  if (!/^%PDF-\d\.\d/.test(source.subarray(0, 16).toString('ascii'))) throw new BundleError('source_not_pdf', 'A PDF header is required; other formats are not v1 bundles');
  const archive = await readRegular(options.archive, DEFAULT_LIMITS.max_archive_bytes);
  let root;
  try {root=pinOutput(options.output);} catch(error) {if(error instanceof ContainmentError) throw new BundleError('unsafe_path',error.message);throw error;}
  try {
  const output=root.path;
  let inventory: Awaited<ReturnType<typeof inspectZip>>;
  try { inventory = await inspectZip(archive); }
  catch (error) {
    const name=root.temporaryDirectory('.quarantine-'),quarantine=root.openDirectory(name),raw=`${sha256(archive)}.zip`;
    try {
      quarantine.writeFile(raw,archive);quarantine.sync();root.sync();quarantine.assertUnchanged();root.assertUnchanged();
      throw new BundleError('archive_rejected', error instanceof Error ? error.message : 'Archive validation failed',join(quarantine.path,raw));
    } finally {quarantine.close();}
  }
  const sourceHash = sha256(source);
  const archivePath = `archives/${inventory.sha256}.zip`;
  const file = (path: string, bytes: Buffer, media_type: string) => ({ path, sha256: sha256(bytes), size_bytes: bytes.length, media_type });
  const unknownRanges = () => ({ ranges: [], basis: 'unknown', evidence: [] });
  const manifest: ObjectValue = {
    schema: 'scholia.artifact-bundle', schema_version: '1.0.1', created_at: new Date().toISOString(),
    producer: { name: 'mineru-mcp', version: VERSION },
    source: { sha256: sourceHash, size_bytes: source.length, media_type: 'application/pdf', original_filename: basename(options.source), page_count: null, file: file('source/source.pdf', source, 'application/pdf'), absence_reason: null, origin: null },
    provider: {
      name: 'mineru', api_generation: options.batchId ? 'v4' : 'unknown', endpoint_origin: null,
      operation: { kind: options.batchId ? 'batch' : 'unknown', operation_id: options.batchId ?? null, file_id: null, client_data_id: null, terminal_state: 'unknown' },
      request: { model: options.model ?? null, tier: null, parser_version: null, options: {} },
      reported: { model: null, model_version: null, tier: null, parser_version: null },
      source_binding: { method: binding, evidence: binding === 'caller_asserted' ? 'Caller associates the supplied source PDF with this offline archive; no upload or provider checksum was verified.' : 'Offline preservation does not establish that the provider parsed these exact source bytes.' },
      outputs_unavailable: [],
    },
    coverage: { status: 'unknown', requested: { scope: 'unknown', ranges: [] }, completed: unknownRanges(), missing: unknownRanges(), unknown: { ranges: [], reason: 'Offline archive has no established requested scope or validated page coverage.' }, source_complete: null },
    archives: [{ artifact_id: 'provider-archive', file: file(archivePath, archive, 'application/zip'), inventory_status: 'complete', members: inventory.members, file_id: null }],
    provider_files: [], materializations: [], validation_limits: { ...DEFAULT_LIMITS },
    warnings: [{ code: 'unverified_source_binding', message: 'Source association is qualified; this bundle does not establish verified PDF evidence.' }, { code: 'unknown_page_provenance', message: 'No PDF page locations or complete coverage have been established.' }],
    legacy_receipts: [], predecessor_manifest_sha256: null,
  };
  canonicalBytes(manifest); // Reject invalid Unicode and unsupported numeric values before publication.
  validateBundleShape(manifest);
  // Construction has exactly one archive, no detached/derived references, unknown
  // coverage, and a source whose record is computed from the exact retained bytes.
  if (inventory.sha256 !== sha256(archive) || inventory.size_bytes !== archive.length || !isDeepStrictEqual(manifest.source.file.sha256, sourceHash)) throw new BundleError('invalid_manifest', 'Constructed identity mismatch');
  const identity = sha256(Buffer.from(JSON.stringify([sourceHash, inventory.sha256, options.batchId ?? null, options.model ?? null, binding])));
  const destination = join(output, `bundle-${identity}`);
  const result = (status: 'created' | 'existing', bytes: Buffer) => ({ status, bundle_dir: destination, manifest_path: join(destination, 'bundle.json'), manifest_sha256: sha256(bytes), source_sha256: sourceHash, archive_sha256: inventory.sha256 });
  const existing = async () => {
    const previousDir=root.openDirectory(`bundle-${identity}`);
    try {
    const bytes = previousDir.readFile('bundle.json', DEFAULT_LIMITS.max_manifest_bytes);
    const previous = strictLoads(bytes) as ObjectValue;
    validateBundleShape(previous);
    const comparable: ObjectValue = { ...manifest, created_at: previous.created_at };
    // A local rename of the exact PDF does not change bundle identity.
    comparable.source = { ...manifest.source, original_filename: previous.source.original_filename };
    if (!canonicalBytes(comparable).equals(canonicalBytes(previous))) throw new BundleError('bundle_conflict', 'Existing bundle metadata differs');
    const pdf=previousDir.hashFile('source/source.pdf',source.length),zip=previousDir.hashFile(archivePath,archive.length);
    if (pdf.sha256!==sourceHash || pdf.size_bytes!==source.length || zip.sha256!==inventory.sha256 || zip.size_bytes!==archive.length) throw new BundleError('bundle_conflict', 'Existing retained bytes differ');
    previousDir.assertUnchanged();root.assertUnchanged();
    return result('existing', bytes);
    } finally {previousDir.close();}
  };
  if (root.exists(`bundle-${identity}`)) return await existing();
  const stageName=root.temporaryDirectory('.bundle-staging-'),stage=root.openDirectory(stageName);
  try {
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    if (bytes.length > DEFAULT_LIMITS.max_manifest_bytes) throw new BundleError('limit_exceeded', 'Manifest exceeds byte limit');
    stage.writeFiles([{path:'bundle.json',bytes}],['source','archives']);
    stage.writeFile('source/source.pdf',source);stage.writeFile(archivePath,archive);
    stage.syncDirectories(['source','archives','']);stage.assertUnchanged();
    try { root.rename(stageName,`bundle-${identity}`); } catch (error: any) {
      if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
      return await existing();
    }
    root.sync();root.assertUnchanged();
    return result('created', bytes);
  } finally {
    stage.close();
    try {root.remove(stageName);} catch(error) {if(!(error instanceof ContainmentError && error.code==='unsafe_path'))throw error;}
  }
  } catch(error) {if(error instanceof ContainmentError && ['unsafe_path','ELOOP','ENOTDIR'].includes(error.code))throw new BundleError('unsafe_path',error.message);throw error;}
  finally {root.close();}
}
