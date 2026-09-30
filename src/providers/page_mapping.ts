/** Pinned official MinerU 2.5.4 flat-list mapper; never infer slice offsets. */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { canonicalHash, strictLoads } from '../canonical.js';

export const UPSTREAM_COMMIT = '61cc6886fe3edda8aa1c5b8bd2b6eaedddb8af99';
export const ADAPTER = { name: 'mineru-content-list-flat', version: '1' };
export const FORMAT_SCHEMA = 'mineru.content-list';
export const FORMAT_VERSION = '2.5.4-flat-v1';
const MAX_CONTENT_BYTES = 64 * 1024 * 1024;
const TEXT_TYPES = new Set(['text', 'ref_text', 'phonetic', 'header', 'footer', 'page_number', 'aside_text', 'page_footnote']);
const KNOWN_TYPES = new Set([...TEXT_TYPES, 'image', 'table', 'equation', 'list', 'code']);
const LIMITATIONS = [
  'Page attribution follows the pinned provider block page_idx; it does not verify OCR accuracy or semantic association.',
  'Bounding boxes and printed page labels are unavailable without independently established geometry and rotation.',
  'Observed block pages do not establish complete coverage or identify missing blank pages.',
];
export class PageMappingError extends Error {
  constructor(message: string, readonly code = 'page_mapping_invalid') { super(message); }
}
function fail(message: string, code?: string): never { throw new PageMappingError(message, code); }
export interface MappingContext {
  source_document_sha256: string; source_page_count: number; extraction_id: string; artifact_id: string;
  member_id?: string | null; source_binding?: string; requested_scope?: string;
  requested_ranges?: unknown[] | null; slice_info?: unknown;
}
/** Same exact bytes are hashed and fed to pdfinfo stdin; no text extraction. */
export async function inspectSourcePDF(source: Uint8Array, expectedHash: string): Promise<Record<string, unknown>> {
  if (!(source instanceof Uint8Array) || !source.length || source.length > 256 * 1024 * 1024) fail('PDF source exceeds the bounded metadata-inspection size.', 'page_mapping_limit_exceeded');
  const digest = createHash('sha256').update(source).digest('hex');
  if (digest !== expectedHash) fail('Source PDF does not match the expected exact hash.', 'page_mapping_source_mismatch');
  if (!/%PDF-\d\.\d/.test(Buffer.from(source.subarray(0, 1024)).toString('latin1'))) fail('The source is not a PDF.', 'page_mapping_source_invalid');
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile('pdfinfo', ['-'], { timeout: 30000, maxBuffer: 65536, encoding: 'utf8' }, (error, output) => {
      if (error) reject(new PageMappingError('Source PDF metadata inspection failed.', (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'page_mapping_tool_unavailable' : 'page_mapping_source_invalid'));
      else resolve(output);
    });
    child.stdin?.on('error', () => { /* Completion callback reports rejected input. */ });
    child.stdin?.end(source);
  });
  const match = /^Pages:\s+([0-9]+)\s*$/m.exec(stdout);
  if (!match || Number(match[1]) < 1) fail('Source PDF page count is unavailable.', 'page_mapping_source_invalid');
  return { sha256: digest, size_bytes: source.length, page_count: Number(match[1]) };
}
function blockId(extraction: string, ordinal: number): string {
  const namespace = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
  const digest = createHash('sha1').update(namespace).update(`scholia:${extraction}:${ordinal}`, 'utf8').digest().subarray(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50; digest[8] = (digest[8] & 0x3f) | 0x80;
  return 'blk_' + digest.toString('hex');
}
function string(item: any, field: string, required = false): string {
  if (!(field in item)) { if (required) fail(`Missing ${field}.`, 'unsupported_content_schema'); return ''; }
  if (typeof item[field] !== 'string') fail(`${field} must be a string.`, 'unsupported_content_schema');
  return item[field];
}
function strings(item: any, field: string): string[] {
  const value = field in item ? item[field] : [];
  if (!Array.isArray(value) || value.some((part: unknown) => typeof part !== 'string')) fail(`${field} must contain only strings.`, 'unsupported_content_schema');
  return value;
}
function blockText(item: any): string {
  const kind = item.type;
  if (TEXT_TYPES.has(kind)) return string(item, 'text', true);
  if (kind === 'equation') {
    const text = string(item, 'text');
    if (!text && !('img_path' in item)) fail('Equation lacks text or image reference.', 'unsupported_content_schema');
    if ('img_path' in item) string(item, 'img_path');
    return text;
  }
  if (kind === 'list') { if (!('list_items' in item)) fail('List lacks list_items.', 'unsupported_content_schema'); return strings(item, 'list_items').join('\n'); }
  if (kind === 'code') return [string(item, 'code_body', true), ...strings(item, 'code_caption')].join('\n');
  string(item, 'img_path', true);
  if (kind === 'image') return [...strings(item, 'image_caption'), ...strings(item, 'image_footnote')].join('\n');
  return [...strings(item, 'table_caption'), string(item, 'table_body'), ...strings(item, 'table_footnote')].join('\n');
}
/** Caller must establish source_page_count against exact PDF bytes independently. */
export function mapContentList(payload: Uint8Array, context: MappingContext): any {
  const { source_document_sha256: sourceHash, source_page_count: pages, extraction_id: extraction,
    artifact_id: artifact, member_id: member = null, source_binding: binding = 'unknown',
    requested_scope: scope = 'all', requested_ranges: ranges = null, slice_info: slice = null } = context;
  if (!(payload instanceof Uint8Array) || payload.length > MAX_CONTENT_BYTES) fail('Content JSON exceeds the byte limit.', 'page_mapping_limit_exceeded');
  if (typeof sourceHash !== 'string' || !/^[0-9a-f]{64}$/.test(sourceHash)) fail('Expected a lowercase exact source SHA-256.');
  if (!Number.isSafeInteger(pages) || pages < 1) fail('An independently verified positive source page count is required.', 'page_mapping_source_invalid');
  for (const [name, value] of [['extraction_id', extraction], ['artifact_id', artifact]]) if (typeof value !== 'string' || !value.trim()) fail(`${name} must be nonempty.`);
  if (member !== null && (typeof member !== 'string' || !member.trim())) fail('member_id must be null or a nonempty string.');
  if (!['uploaded_exact_bytes', 'provider_verified_checksum'].includes(binding)) fail('Qualified or unknown source binding cannot validate PDF page provenance.', 'page_mapping_binding_unverified');
  if (scope !== 'all' || (ranges !== null && (!Array.isArray(ranges) || ranges.length !== 0)) || slice !== null) fail('Page-range and slice index conventions are not validated by this adapter.', 'unsupported_page_scope');
  let content: any;
  try { content = strictLoads(payload); } catch { fail('Invalid strict UTF-8 JSON.', 'unsupported_content_schema'); }
  if (!Array.isArray(content) || !content.length) fail('Expected a nonempty flat content list; empty lists establish no page mapping.', 'unsupported_content_schema');
  if (content.length > 50000) fail('Content list exceeds the block limit.', 'page_mapping_limit_exceeded');
  const digest = createHash('sha256').update(payload).digest('hex');
  const mapped: any[] = [], blocks: any[] = [];
  content.forEach((item: any, ordinal: number) => {
    if (!item || Array.isArray(item) || typeof item !== 'object' || !KNOWN_TYPES.has(item.type)) fail('Unsupported content-list shape or block type.', 'unsupported_content_schema');
    const index = item.page_idx;
    if (!Number.isSafeInteger(index) || index < 0 || index >= pages) fail('Provider page_idx must be a zero-based integer inside the verified source.', 'invalid_page_index');
    if ('text_level' in item && (!Number.isSafeInteger(item.text_level) || item.text_level < 0)) fail('Invalid text_level.', 'unsupported_content_schema');
    const text = blockText(item), identifier = blockId(extraction, ordinal), pointer = '/' + ordinal;
    mapped.push({ block_id: identifier, artifact_id: artifact, member_id: member, raw_json_pointer: pointer,
      source_page_index: index, source_page_index_base: 0, page_number: index + 1,
      printed_page_label: null, slice: null, bbox: null });
    blocks.push({ ordinal, block_id: identifier, text, page_number: index + 1, section_path: null,
      block_type: (item.text_level ?? 0) > 0 ? 'heading' : item.type, locator: `corpus://block/${identifier}`, bbox: null,
      metadata: { page_provenance: 'validated', adapter: { ...ADAPTER }, source_document_sha256: sourceHash,
        extraction_id: extraction, artifact_sha256: digest, artifact_id: artifact, member_id: member,
        raw_json_pointer: pointer, source_page_index: index, source_page_index_base: 0, page_attribution: 'provider_block_page' } });
  });
  return { page_map: { schema_version: 'scholia.page-map.v1', source_document_sha256: sourceHash,
      extraction_id: extraction, adapter: { ...ADAPTER }, blocks: mapped }, blocks,
    format_schema: FORMAT_SCHEMA, format_version: FORMAT_VERSION, content_sha256: digest,
    observed_pages: [...new Set(mapped.map(item => item.page_number))].sort((a, b) => a - b),
    coverage: { status: 'unknown', source_complete: null, reason: 'Content block page attribution does not prove extraction coverage.' },
    limitations: [...LIMITATIONS] };
}
export function validatePageMap(claimedMap: unknown, payload: Uint8Array, context: MappingContext): any {
  const expected = mapContentList(payload, context);
  if (canonicalHash(claimedMap) !== canonicalHash(expected.page_map)) fail('Claimed map differs from the raw-content derivation.', 'page_map_mismatch');
  return expected;
}
