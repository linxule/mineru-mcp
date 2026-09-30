/** Generic, offline validation of portable bundles, including detached/derived outputs.
 * No provider calls, filesystem writes, extraction, or credential discovery.
 */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { canonicalHash, strictLoads, ExactDecimal, normalizeHashInput } from '../canonical.js';
import { DEFAULT_LIMITS, inspectZip, sha256, safeMemberPath } from './archive.js';
import { casefold } from './casefold.js';
import { validateBundleStructure } from './schema.js';

type ObjectValue = Record<string, any>;
export type ValidationLimits = typeof DEFAULT_LIMITS;
export class BundleValidationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'BundleValidationError'; }
}
function fail(message: string, code = 'invalid_bundle'): never { throw new BundleValidationError(code, message); }
export function effectiveValidationLimits(limits: Partial<ValidationLimits> = {}): ValidationLimits {
  const result = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(limits)) {
    if (!(key in result) || !Number.isFinite(value) || value <= 0 || key !== 'max_compression_ratio' && !Number.isSafeInteger(value)) fail('Invalid validation limit');
    const k = key as keyof ValidationLimits; result[k] = Math.min(value, result[k]);
  }
  return result;
}
function safePath(path: string, directory = false): string {
  if (typeof path !== 'string' || !directory && path.endsWith('/')) fail('Unsafe artifact path', 'artifact_path_unsafe');
  try { return safeMemberPath(path); } catch { return fail('Unsafe artifact path', 'artifact_path_unsafe'); }
}
function pathsUnique(paths: Array<[string, boolean]>): void {
  const seen = new Map<string, boolean>();
  for (const [path, directory] of paths) {
    const key = casefold(safePath(path, directory).normalize('NFC'));
    if (seen.has(key)) fail('Duplicate or normalized artifact path', 'artifact_path_collision');
    seen.set(key, directory);
  }
  for (const path of seen.keys()) {
    const parts = path.split('/');
    for (let n = 1; n < parts.length; n++) if (seen.get(parts.slice(0, n).join('/')) === false) fail('File/directory prefix collision', 'artifact_path_collision');
  }
}
/** Lossless integral normalization; noninteger options retain exact decimal lexemes. */
function normalizeIntegralNumbers(value: any): any {
  if (value instanceof ExactDecimal) {
    // Preserve arbitrary JSON numeric lexemes in opaque extensions. Canonical
    // resource/precision limits apply when options/configuration are hashed.
    if (!Number.isSafeInteger(Number(value.value))) return value;
    try {
      const normalized = normalizeHashInput(value);
      return typeof normalized === 'number' ? normalized : value;
    } catch { return value; }
  }
  if (Array.isArray(value)) return value.map(normalizeIntegralNumbers);
  if (value !== null && typeof value === 'object') {
    const result = Object.create(null);
    for (const [key, child] of Object.entries(value)) result[key] = normalizeIntegralNumbers(child);
    return result;
  }
  return value;
}
export function manifestFiles(manifest: ObjectValue): ObjectValue[] {
  return [...(manifest.source.file ? [manifest.source.file] : []),
    ...manifest.archives.map((a: ObjectValue) => a.file), ...manifest.provider_files.map((a: ObjectValue) => a.file),
    ...manifest.materializations.flatMap((m: ObjectValue) => m.outputs.map((o: ObjectValue) => o.file)),
    ...manifest.legacy_receipts.map((r: ObjectValue) => r.receipt)];
}
function ranges(values: ObjectValue[], count: number | null): Array<[number, number]> {
  let previous = -1;
  return values.map(({start, end}) => {
    if (end < start || start <= previous + 1 || count !== null && end > count) fail('Ranges must be bounded, sorted, disjoint and coalesced', 'invalid_coverage');
    previous = end; return [start, end];
  });
}
function validateCoverage(manifest: ObjectValue): void {
  const coverage = manifest.coverage, count = manifest.source.page_count, requested = coverage.requested;
  const explicit = ranges(requested.ranges, count);
  if ((requested.scope === 'ranges') !== Boolean(explicit.length)) fail('Requested ranges disagree with scope', 'invalid_coverage');
  const known = requested.scope === 'ranges' ? explicit : requested.scope === 'all' && count !== null ? [[1, count]] : null;
  const completed = ranges(coverage.completed.ranges, count), missing = ranges(coverage.missing.ranges, count), unknown = ranges(coverage.unknown.ranges, count);
  const combined: number[][] = [];
  for (const [start, end] of [...completed, ...missing, ...unknown].sort((a, b) => a[0] - b[0])) {
    const last = combined.at(-1);
    if (last && start <= last[1]) fail('Coverage sets overlap', 'invalid_coverage');
    if (last && start === last[1] + 1) last[1] = end; else combined.push([start, end]);
  }
  if (known === null) {
    if (coverage.status !== 'unknown' || coverage.source_complete !== null || !coverage.unknown.reason) fail('Unknown extent cannot claim completeness', 'invalid_coverage');
  } else {
    if (!isDeepStrictEqual(combined, known)) fail('Coverage does not partition requested pages', 'invalid_coverage');
    const expected = isDeepStrictEqual(completed, known) && coverage.completed.basis === 'validated' ? 'complete' : completed.length && (missing.length || unknown.length) ? 'partial' : 'unknown';
    if (coverage.status !== expected) fail('Coverage status lacks supporting evidence', 'invalid_coverage');
    if (count === null && coverage.source_complete !== null) fail('Unknown page count cannot establish source completeness', 'invalid_coverage');
    if (coverage.source_complete === true && !(expected === 'complete' && isDeepStrictEqual(completed, [[1, count]]))) fail('Source completeness unsupported', 'invalid_coverage');
  }
  if (unknown.length && !coverage.unknown.reason) fail('Unknown ranges require a reason', 'invalid_coverage');
}
/** Shape and semantics only. Hash verification of retained bytes requires validateBundle. */
export function validateManifest(value: unknown): void {
  if (!value || typeof value !== 'object' || (value as ObjectValue).schema_version !== '1.0.1') fail('Unsupported artifact bundle version', 'unsupported_bundle_version');
  const manifest = normalizeIntegralNumbers(value) as ObjectValue;
  validateBundleStructure(manifest);
  const source = manifest.source;
  if ((source.file === null) !== (source.absence_reason !== null)) fail('Source presence/absence reason disagree');
  if (source.file && ['sha256', 'size_bytes', 'media_type'].some(k => source[k] !== source.file[k])) fail('Source record and source file disagree');
  if (manifest.corpus_binding && manifest.corpus_binding.document_sha256 !== source.sha256) fail('Corpus binding names different source');
  if (source.origin?.url) {
    const url = new URL(source.origin.url);
    if (url.username || url.password || url.hash || [...url.searchParams.keys()].some(k => /token|secret|signature|credential|password|api.?key|x-amz|x-goog/i.test(k))) fail('Credential-bearing source URL');
  }
  try { canonicalHash(manifest.provider.request.options); } catch { fail('Invalid provider options', 'invalid_bundle_options'); }
  function transportKeys(value: any): void {
    if (Array.isArray(value)) value.forEach(transportKeys);
    else if (value && typeof value === 'object' && !(value instanceof ExactDecimal)) for (const [key, child] of Object.entries(value)) {
      const forbidden = new Set(['authorization', 'credential', 'credentials', 'password', 'secret', 'apikey', 'headers', 'signedurl', 'localpath', 'filename', 'token', 'accesstoken', 'refreshtoken', 'cookie', 'cookies', 'accountid']);
      if (forbidden.has(key.toLowerCase().replace(/[^a-z0-9]/g, '')) || /(^|[_-])(authorization|credentials?|password|secret|api[_-]?key|headers|signed[_-]?url|local[_-]?path|file[_-]?name|access[_-]?token|refresh[_-]?token|cookies?|account[_-]?id)($|[_-])/i.test(key)) fail('Options include secret or transport fields', 'invalid_bundle_options');
      transportKeys(child);
    }
  }
  transportKeys(manifest.provider.request.options);
  const artifacts = new Map<string, ObjectValue>();
  for (const artifact of [...manifest.archives, ...manifest.provider_files, ...manifest.materializations.flatMap((m: ObjectValue) => m.outputs)]) {
    if (artifacts.has(artifact.artifact_id)) fail('Artifact IDs must be globally unique');
    artifacts.set(artifact.artifact_id, artifact);
  }
  for (const archive of manifest.archives) {
    if (new Set(archive.members.map((m: ObjectValue) => m.member_id)).size !== archive.members.length) fail('Member IDs must be unique');
    if (archive.members.some((m: ObjectValue, i: number) => m.entry_index !== i)) fail('Member indexes must preserve complete archive order');
    pathsUnique(archive.members.map((m: ObjectValue) => [m.path, m.kind === 'directory']));
  }
  const files = new Map<string, ObjectValue>();
  for (const file of manifestFiles(manifest)) {
    if (file.path === 'bundle.json') fail('Manifest cannot also be an artifact');
    if (files.has(file.path) && !isDeepStrictEqual(files.get(file.path), file)) fail('One path has conflicting file identities');
    files.set(file.path, file);
  }
  pathsUnique([...files.keys()].map(path => [path, false]));
  function reference(ref: ObjectValue): void {
    const artifact = artifacts.get(ref.artifact_id);
    if (!artifact) fail('Artifact reference does not resolve');
    if (ref.member_id !== null && !(artifact.members ?? []).some((m: ObjectValue) => m.member_id === ref.member_id)) fail('Member reference does not resolve');
    if (ref.json_pointer !== null && (ref.json_pointer !== '' && !ref.json_pointer.startsWith('/') || /~(?![01])/.test(ref.json_pointer))) fail('Invalid RFC6901 pointer');
  }
  for (const key of ['completed', 'missing']) manifest.coverage[key].evidence.forEach(reference);
  const materializations = new Set<string>();
  for (const materialization of manifest.materializations) {
    const key = JSON.stringify([materialization.materializer_name, materialization.materializer_version, materialization.config_hash]);
    if (materializations.has(key)) fail('Duplicate materialization identity'); materializations.add(key);
    let configHash: string;
    try { configHash = canonicalHash(materialization.config); } catch { return fail('Invalid materializer configuration', 'invalid_bundle_config'); }
    if (configHash !== materialization.config_hash) fail('Materialization config hash mismatch', 'bundle_hash_mismatch');
    if (materialization.page_provenance === 'validated' && materialization.page_map === null) fail('Validated page provenance requires a page map');
    if (materialization.page_map !== null) reference(materialization.page_map);
    for (const output of materialization.outputs) {
      if (output.role === 'page_map' && (output.format_schema !== 'scholia.page-map' || output.format_version !== '1')) fail('Unsupported page map format identity');
      output.inputs.forEach(reference);
    }
  }
  validateCoverage(manifest);
  if (['completed', 'missing'].some(key => manifest.coverage[key].basis === 'validated') || manifest.materializations.some((m: ObjectValue) => m.page_provenance === 'validated')) fail('Validated page evidence needs a supported mapping adapter', 'unsupported_page_validation');
}

async function directorySnapshot(path: string): Promise<Array<[string, bigint, bigint]>> {
  const absolute = resolve(path), anchor = parse(absolute).root;
  const result: Array<[string, bigint, bigint]> = []; let current = anchor;
  for (const part of absolute.slice(anchor.length).split('/').filter(Boolean)) {
    current = join(current, part); const st = await lstat(current, { bigint: true });
    if (!st.isDirectory() || st.isSymbolicLink()) fail('Symlink or non-directory path component', 'artifact_path_unsafe');
    result.push([current, st.dev, st.ino]);
  }
  return result;
}
/** Verify the opened regular file, plus all ancestor identities before/after opening.
 * No provider-controlled path is ever written or extracted.
 */
async function readFileChecked(root: string, relative: string, maximum: number, retain = false) {
  safePath(relative); const path = join(root, relative);
  try {
    const parents = await directorySnapshot(dirname(path));
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat({ bigint: true }), named = await lstat(path, { bigint: true });
      if (!before.isFile() || !named.isFile() || before.dev !== named.dev || before.ino !== named.ino || before.size > BigInt(maximum)
          || !isDeepStrictEqual(parents, await directorySnapshot(dirname(path)))) fail('Unsafe or oversized artifact', 'artifact_path_unsafe');
      const hash = createHash('sha256'), chunks: Buffer[] = []; let count = 0; let prefix = Buffer.alloc(0);
      for (;;) {
        const chunk = Buffer.alloc(Math.min(1024 * 1024, maximum - count + 1));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null); if (!bytesRead) break;
        count += bytesRead; if (count > maximum) fail('Artifact byte limit exceeded', 'bundle_limit_exceeded');
        const actual = chunk.subarray(0, bytesRead); hash.update(actual); if (retain) chunks.push(actual);
        if (prefix.length < 1024) prefix = Buffer.concat([prefix, actual.subarray(0, 1024 - prefix.length)]);
      }
      const after = await handle.stat({ bigint: true });
      if (BigInt(count) !== before.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
          || !isDeepStrictEqual(parents, await directorySnapshot(dirname(path)))) fail('Artifact changed during read', 'artifact_changed');
      return { sha256: hash.digest('hex'), size_bytes: count, prefix, bytes: retain ? Buffer.concat(chunks, count) : undefined };
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof BundleValidationError) throw error;
    throw new BundleValidationError('artifact_path_unsafe', 'Artifact could not be safely opened');
  }
}
export async function readManifest(root: string, limits: Partial<ValidationLimits> = {}) {
  const bounded = effectiveValidationLimits(limits);
  const file = await readFileChecked(resolve(root), 'bundle.json', bounded.max_manifest_bytes, true);
  let manifest: ObjectValue;
  try { manifest = normalizeIntegralNumbers(strictLoads(file.bytes!)); } catch { return fail('Invalid strict bundle JSON', 'invalid_bundle_json'); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('Manifest must be an object');
  return { manifest, bytes: file.bytes!, manifest_sha256: file.sha256 };
}
export async function validateBundle(root: string, limits: Partial<ValidationLimits> = {}) {
  root = resolve(root);
  const parsed = await readManifest(root, limits), manifest = parsed.manifest;
  validateManifest(manifest);
  const bounded = effectiveValidationLimits(limits);
  for (const key of Object.keys(bounded) as Array<keyof ValidationLimits>) {
    const value = manifest.validation_limits[key];
    bounded[key] = Math.min(bounded[key], value instanceof ExactDecimal ? Number(value.value) : value);
  }
  if (parsed.bytes.length > bounded.max_manifest_bytes) fail('Manifest exceeds recorded production limit', 'bundle_limit_exceeded');
  let total = 0;
  for (const file of manifestFiles(manifest)) {
    // Validate each owning inventory, including repeated physical file paths.
    const archive = manifest.archives.find((a: ObjectValue) => a.file === file);
    const actual = await readFileChecked(root, file.path, archive ? bounded.max_archive_bytes : bounded.max_member_bytes, Boolean(archive));
    if (actual.sha256 !== file.sha256 || actual.size_bytes !== file.size_bytes) fail('Artifact hash or size mismatch', 'bundle_hash_mismatch');
    if (file === manifest.source.file && !/%PDF-[0-9]\.[0-9]/.test(actual.prefix.toString('latin1'))) fail('Source bytes lack a PDF signature', 'source_not_pdf');
    if (archive) {
      let inventory: Awaited<ReturnType<typeof inspectZip>>;
      try { inventory = await inspectZip(actual.bytes!, bounded); } catch { return fail('ZIP integrity validation failed', 'unsafe_archive'); }
      if (inventory.members.length !== archive.members.length) fail('Incomplete ZIP inventory', 'bundle_inventory_mismatch');
      for (let index = 0; index < inventory.members.length; index++) {
        const observed = inventory.members[index], declared = archive.members[index];
        for (const key of ['entry_index', 'path', 'kind', 'sha256', 'size_bytes', 'compressed_size_bytes'] as const) if (observed[key] !== declared[key]) fail('ZIP inventory differs from bytes', 'bundle_inventory_mismatch');
        total += observed.size_bytes;
      }
    } else if (manifest.provider_files.some((p: ObjectValue) => p.file === file)) total += actual.size_bytes;
    if (total > bounded.max_total_uncompressed_bytes) fail('Bundle expanded bytes exceed total limit', 'bundle_limit_exceeded');
  }
  return { root, manifest, manifest_sha256: parsed.manifest_sha256, manifest_bytes: parsed.bytes };
}
