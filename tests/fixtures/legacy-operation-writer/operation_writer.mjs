import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION } from '../version.js';
import { canonicalHash } from '../canonical.js';
import { inspectZip, sha256, DEFAULT_LIMITS, roleFor } from './archive.js';
import { pinOutput } from './filesystem.js';
import { validateManifest, validateBundle } from './validation.js';
function mediaFor(format) { return format === 'markdown' || format === 'md' ? { role: 'markdown', media_type: 'text/markdown' } : format === 'json' || format === 'content_list' ? { role: 'structured_json', media_type: 'application/json' } : roleFor(format); }
function outputIdentities(manifest) { return [...manifest.archives.map((o) => ({ artifact_id: o.artifact_id, kind: 'archive', sha256: o.file.sha256, size_bytes: o.file.size_bytes, file_id: o.file_id, role: null, media_type: o.file.media_type, members: o.members })), ...manifest.provider_files.map((o) => ({ artifact_id: o.artifact_id, kind: 'provider_file', sha256: o.file.sha256, size_bytes: o.file.size_bytes, file_id: o.file_id, role: o.role, media_type: o.file.media_type, format_schema: o.format_schema, format_version: o.format_version }))].sort((a, b) => a.artifact_id.localeCompare(b.artifact_id)); }
function stableProvider(provider) { const { outputs_unavailable, ...rest } = provider; const { terminal_state, ...operation } = rest.operation; return { ...rest, operation }; }
function fail(code) { throw Object.assign(new Error(code), { code }); }
/** Internal writer only: provenance comes from the persisted operation, never CLI assertions. */
export async function createOperationBundle(input) {
    const source = readFileSync(input.source), sourceHash = sha256(source), p = input.provider;
    if (sourceHash !== p.request.sha256 || source.length !== p.request.size)
        fail('source_hash_mismatch');
    const unavailable = (p.unavailable ?? p.missing.map(value => { const [format, reason] = value.split(':'); return { role: 'unknown', format, file_id: null, reason: ['download_failed', 'expired', 'limit_exceeded', 'not_returned', 'unsupported_format', 'cancelled', 'unknown'].includes(reason) ? reason : 'unknown' }; })).map(({ role, format, file_id, reason }) => ({ role, format, file_id, reason }));
    // Verify inputs even when an already-published directory can be reused.
    const outputs = input.outputs.map((output, index) => { const bytes = readFileSync(output.path); if (sha256(bytes) !== output.sha256 || bytes.length !== output.size)
        fail('output_hash_mismatch'); const archive = output.format === 'zip' || bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])); return { ...output, index, archive, media: mediaFor(output.format) }; });
    const provider = { name: 'mineru', api_generation: p.api, endpoint_origin: new URL(p.endpoint).protocol === 'https:' ? new URL(p.endpoint).origin : null, operation: { kind: p.kind, operation_id: p.id, file_id: null, client_data_id: p.api === 'v4' ? sourceHash : null, terminal_state: p.terminal }, request: { model: p.request.model ?? null, tier: p.request.tier ?? null, parser_version: null, options: { output_formats: p.request.formats, ...(p.request.pages ? { page_ranges: p.request.pages } : {}) } }, reported: { model: null, model_version: null, tier: null, parser_version: null }, source_binding: { method: p.binding, evidence: p.binding === 'uploaded_exact_bytes' ? 'Exact source bytes were retained and transferred by the durable local operation.' : p.binding === 'caller_asserted' ? 'The provider reported a completed upload; this operation did not transfer its retained source bytes.' : 'Exact source bytes were retained locally; successful transfer was not established.' }, outputs_unavailable: unavailable };
    const expectedOutputs = outputs.map(o => ({ artifact_id: `output-${o.index}`, kind: o.archive ? 'archive' : 'provider_file', sha256: o.sha256, size_bytes: o.size, file_id: o.id, role: o.archive ? null : o.media.role, media_type: o.archive ? 'application/zip' : o.media.media_type, ...(o.archive ? {} : { format_schema: null, format_version: null }) }));
    const sourceRecord = { sha256: sourceHash, size_bytes: source.length, media_type: 'application/pdf', original_filename: null, page_count: null, file: { path: 'source/source.pdf', sha256: sourceHash, size_bytes: source.length, media_type: 'application/pdf' }, absence_reason: null, origin: null };
    const ranges = () => ({ ranges: [], basis: 'unknown', evidence: [] });
    const coverage = { status: 'unknown', requested: { scope: 'unknown', ranges: [] }, completed: ranges(), missing: ranges(), unknown: { ranges: [], reason: 'No validated PDF page coverage is established.' }, source_complete: null };
    const sourceMatches = (manifest) => canonicalHash(manifest.source) === canonicalHash(sourceRecord);
    const identity = canonicalHash({ source: sourceHash, provider: { api: p.api, endpoint: p.endpoint, kind: p.kind, id: p.id, terminal: p.terminal }, binding: p.binding, request: p.request, outputs: input.outputs.map(o => [o.id, o.format, o.sha256]), unavailable });
    const root = pinOutput(input.output), destinationName = `bundle-${identity}`, destination = join(root.path, destinationName);
    let stageName, stage;
    try {
        // Inventory semantics are part of the intended output, not only its bytes.
        for (const output of outputs)
            if (output.archive) {
                const bytes = readFileSync(output.path);
                if (sha256(bytes) !== output.sha256 || bytes.length !== output.size)
                    fail('output_hash_mismatch');
                expectedOutputs[output.index].members = (await inspectZip(bytes)).members;
            }
        let predecessorHash = null;
        if (input.predecessor && input.predecessor !== destination) {
            const predecessor = pinOutput(input.predecessor, false);
            try {
                const prior = await validateBundle(predecessor.path);
                if (input.predecessorManifestSha256 && prior.manifest_sha256 !== input.predecessorManifestSha256)
                    fail('predecessor_manifest_changed');
                if (!sourceMatches(prior.manifest) || canonicalHash(stableProvider(prior.manifest.provider)) !== canonicalHash(stableProvider(provider)) || canonicalHash(prior.manifest.coverage) !== canonicalHash(coverage) || prior.manifest.materializations.length || prior.manifest.legacy_receipts.length || outputIdentities(prior.manifest).some((actual) => !expectedOutputs.some(expected => canonicalHash(actual) === canonicalHash(expected))))
                    fail('predecessor_identity_mismatch');
                predecessor.assertUnchanged();
                predecessorHash = prior.manifest_sha256;
            }
            finally {
                predecessor.close();
            }
        }
        if (root.exists(destinationName)) {
            const existing = root.openDirectory(destinationName);
            try {
                const verified = await validateBundle(existing.path), manifest = verified.manifest;
                const actualOutputs = outputIdentities(manifest);
                const expected = [...expectedOutputs].sort((a, b) => a.artifact_id.localeCompare(b.artifact_id));
                if (!sourceMatches(manifest) || canonicalHash(manifest.provider) !== canonicalHash(provider) || canonicalHash(actualOutputs) !== canonicalHash(expected) || canonicalHash(manifest.coverage) !== canonicalHash(coverage) || manifest.materializations.length || manifest.legacy_receipts.length)
                    fail('bundle_identity_mismatch');
                if (input.predecessor === destination) {
                    if (input.predecessorManifestSha256 && verified.manifest_sha256 !== input.predecessorManifestSha256)
                        fail('retained_bundle_changed');
                }
                else if (manifest.predecessor_manifest_sha256 !== predecessorHash)
                    fail('bundle_lineage_mismatch');
                existing.assertUnchanged();
                root.assertUnchanged();
                return { bundle_dir: destination, manifest_sha256: verified.manifest_sha256 };
            }
            finally {
                existing.close();
            }
        }
        stageName = root.temporaryDirectory('.operation-bundle-');
        stage = root.openDirectory(stageName);
        const file = (path, bytes, media_type) => ({ path, sha256: sha256(bytes), size_bytes: bytes.length, media_type });
        stage.mkdir('source');
        stage.mkdir('archives');
        stage.mkdir('provider-files');
        stage.writeFile('source/source.pdf', source);
        const archives = [], providerFiles = [];
        let total = 0;
        for (const o of outputs) {
            const bytes = readFileSync(o.path);
            if (sha256(bytes) !== o.sha256 || bytes.length !== o.size)
                fail('output_hash_mismatch');
            if (o.archive) {
                const members = expectedOutputs[o.index].members;
                total += members.reduce((n, m) => n + m.size_bytes, 0);
                const path = `archives/${o.sha256}.zip`;
                if (!stage.exists(path))
                    stage.writeFile(path, bytes);
                archives.push({ artifact_id: `output-${o.index}`, file: file(path, bytes, 'application/zip'), inventory_status: 'complete', members, file_id: o.id });
            }
            else {
                total += bytes.length;
                const path = `provider-files/${o.index}-${o.sha256}`;
                if (!stage.exists(path))
                    stage.writeFile(path, bytes);
                providerFiles.push({ artifact_id: `output-${o.index}`, file: file(path, bytes, o.media.media_type), role: o.media.role, format_schema: null, format_version: null, file_id: o.id });
            }
            if (total > DEFAULT_LIMITS.max_total_uncompressed_bytes)
                fail('bundle_limit_exceeded');
        }
        const manifest = { schema: 'scholia.artifact-bundle', schema_version: '1.0.1', created_at: new Date().toISOString(), producer: { name: 'mineru-mcp', version: VERSION }, source: sourceRecord, provider, coverage, archives, provider_files: providerFiles, materializations: [], validation_limits: DEFAULT_LIMITS, warnings: [{ code: 'unknown_page_provenance', message: 'Output retention does not establish PDF page positions or full document coverage.' }], legacy_receipts: [], predecessor_manifest_sha256: predecessorHash };
        validateManifest(manifest);
        stage.writeFile('bundle.json', JSON.stringify(manifest, null, 2) + '\n');
        const verified = await validateBundle(stage.path);
        stage.assertUnchanged();
        for (const path of ['source', 'archives', 'provider-files', ''])
            stage.sync(path);
        root.rename(stageName, destinationName);
        root.sync();
        root.assertUnchanged();
        return { bundle_dir: destination, manifest_sha256: verified.manifest_sha256 };
    }
    finally {
        stage?.close();
        try {
            if (stageName && root.exists(stageName))
                root.remove(stageName);
        }
        catch { /* A replaced path remains untouched, including during cleanup. */ }
        root.close();
    }
}
