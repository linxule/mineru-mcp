/** Offline v1.0.1 artifact preservation. This module never contacts a provider. */
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, mkdtemp } from 'node:fs/promises';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { inspectZip, DEFAULT_LIMITS, sha256 } from './archive.js';
import { validateBundleStructure } from './schema.js';
import { bundleSchema } from './schema.js';
import { strictLoads, canonicalBytes } from '../canonical.js';
import { VERSION } from '../version.js';

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

async function checkComponents(path: string, create = false): Promise<void> {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const component of absolute.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, component);
    if (create) { try { await mkdir(current, { mode: 0o700 }); } catch (error: any) { if (error.code !== 'EEXIST') throw error; } }
    const st = await lstat(current);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new BundleError('unsafe_path', 'Path component must be a nonsymlink directory');
  }
}

export async function readRegular(path: string, maxBytes: number): Promise<Buffer> {
  path = resolve(path);
  await checkComponents(dirname(path));
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new BundleError('unsafe_path', 'Input must be a regular file');
    if (before.size > maxBytes) throw new BundleError('limit_exceeded', 'Input exceeds byte limit');
    await checkComponents(dirname(path));
    const named = await lstat(path);
    if (named.dev !== before.dev || named.ino !== before.ino || !named.isFile()) throw new BundleError('unsafe_path', 'Input changed while opening');
    const chunks: Buffer[] = []; let count = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(1024 * 1024, maxBytes - count + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      count += bytesRead;
      if (count > maxBytes) throw new BundleError('limit_exceeded', 'Input exceeds byte limit');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (before.size !== count || after.size !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new BundleError('input_changed', 'Input changed during read');
    return Buffer.concat(chunks, count);
  } finally { await handle.close(); }
}

async function writeSynced(path: string, bytes: Buffer): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Publish under output/bundle-<identity>; repeat inputs verify and reuse exact bytes. */
export async function createBundle(options: CreateBundleOptions) {
  const binding = options.binding ?? 'unknown';
  if (!['unknown', 'caller_asserted'].includes(binding)) throw new BundleError('invalid_binding', 'Offline bundles cannot assert a verified source binding');
  for (const value of [options.batchId, options.model]) if (value !== undefined && (!value.trim() || /[\u0000-\u001f\u007f]/u.test(value))) throw new BundleError('invalid_option', 'Expected nonempty metadata without control characters');
  const source = await readRegular(options.source, DEFAULT_LIMITS.max_archive_bytes);
  if (!/^%PDF-\d\.\d/.test(source.subarray(0, 16).toString('ascii'))) throw new BundleError('source_not_pdf', 'A PDF header is required; other formats are not v1 bundles');
  const archive = await readRegular(options.archive, DEFAULT_LIMITS.max_archive_bytes);
  const output = resolve(options.output);
  await checkComponents(output, true);
  let inventory: Awaited<ReturnType<typeof inspectZip>>;
  try { inventory = await inspectZip(archive); }
  catch (error) {
    const quarantine = await mkdtemp(join(output, '.quarantine-'));
    const raw = join(quarantine, `${sha256(archive)}.zip`);
    await writeSynced(raw, archive); await syncDirectory(quarantine); await syncDirectory(output);
    throw new BundleError('archive_rejected', error instanceof Error ? error.message : 'Archive validation failed', raw);
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
    const bytes = await readRegular(join(destination, 'bundle.json'), DEFAULT_LIMITS.max_manifest_bytes);
    const previous = strictLoads(bytes) as ObjectValue;
    validateBundleShape(previous);
    const comparable: ObjectValue = { ...manifest, created_at: previous.created_at };
    // A local rename of the exact PDF does not change bundle identity.
    comparable.source = { ...manifest.source, original_filename: previous.source.original_filename };
    if (!canonicalBytes(comparable).equals(canonicalBytes(previous))) throw new BundleError('bundle_conflict', 'Existing bundle metadata differs');
    const [pdf, zip] = await Promise.all([readRegular(join(destination, 'source/source.pdf'), source.length), readRegular(join(destination, archivePath), archive.length)]);
    if (!pdf.equals(source) || !zip.equals(archive)) throw new BundleError('bundle_conflict', 'Existing retained bytes differ');
    return result('existing', bytes);
  };
  let destinationExists = false;
  try { await lstat(destination); destinationExists = true; } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  if (destinationExists) return await existing();
  const stage = await mkdtemp(join(output, '.bundle-staging-'));
  try {
    await mkdir(join(stage, 'source')); await mkdir(join(stage, 'archives'));
    await writeSynced(join(stage, 'source/source.pdf'), source); await writeSynced(join(stage, archivePath), archive);
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    if (bytes.length > DEFAULT_LIMITS.max_manifest_bytes) throw new BundleError('limit_exceeded', 'Manifest exceeds byte limit');
    await writeSynced(join(stage, 'bundle.json'), bytes);
    await syncDirectory(join(stage, 'source')); await syncDirectory(join(stage, 'archives')); await syncDirectory(stage);
    await checkComponents(output);
    try { await rename(stage, destination); } catch (error: any) {
      if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
      return await existing();
    }
    await syncDirectory(output);
    return result('created', bytes);
  } finally { await rm(stage, { recursive: true, force: true }); }
}
