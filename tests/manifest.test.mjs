import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, symlink, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createBundle, validateBundleShape } from '../dist/bundle/manifest.js';
import { crc32, sha256 } from '../dist/bundle/archive.js';

function zip(files) {
  const local = [], central = []; let offset = 0;
  for (const [name, body] of files) {
    const path = Buffer.from(name), bytes = Buffer.from(body), crc = crc32(bytes);
    const a = Buffer.alloc(30); a.writeUInt32LE(0x04034b50); a.writeUInt16LE(20, 4); a.writeUInt32LE(crc, 14); a.writeUInt32LE(bytes.length, 18); a.writeUInt32LE(bytes.length, 22); a.writeUInt16LE(path.length, 26);
    const b = Buffer.alloc(46); b.writeUInt32LE(0x02014b50); b.writeUInt16LE(20, 4); b.writeUInt16LE(20, 6); b.writeUInt32LE(crc, 16); b.writeUInt32LE(bytes.length, 20); b.writeUInt32LE(bytes.length, 24); b.writeUInt16LE(path.length, 28); b.writeUInt32LE(offset, 42);
    local.push(a, path, bytes); central.push(b, path); offset += a.length + path.length + bytes.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}
async function fixture(t, files = [['full.md', '# title'], ['nested/opaque.bin', '\u0000raw']]) {
  const dir = await mkdtemp('/private/tmp/mineru-manifest-test-');
  t.after(() => rm(dir, {recursive:true, force:true}));
  const source = join(dir, 'source.pdf'), archive = join(dir, 'provider.zip'), output = join(dir, 'out');
  const pdf = Buffer.from('%PDF-1.7\nexact original\n%%EOF\n'), raw = zip(files);
  await writeFile(source, pdf); await writeFile(archive, raw);
  return {dir, source, archive, output, pdf, raw};
}

test('offline full-artifact bundle, conservative claims, exact replay and portable paths', async t => {
  const f = await fixture(t), created = await createBundle({...f, batchId:'batch-1', model:'vlm'});
  assert.equal(created.status, 'created');
  const manifest = JSON.parse(await readFile(created.manifest_path, 'utf8'));
  validateBundleShape(manifest);
  assert.equal(manifest.provider.source_binding.method, 'unknown');
  assert.equal(manifest.provider.operation.terminal_state, 'unknown');
  assert.equal(manifest.source.origin, null);
  assert.equal(manifest.provider.endpoint_origin, null);
  assert.equal(manifest.coverage.requested.scope, 'unknown');
  assert.equal(manifest.coverage.source_complete, null);
  assert.equal(manifest.archives[0].members.length, 2);
  assert.deepEqual(await readFile(join(created.bundle_dir, manifest.archives[0].file.path)), f.raw);
  assert.deepEqual(await readFile(join(created.bundle_dir, manifest.source.file.path)), f.pdf);
  assert.equal(created.archive_sha256, sha256(f.raw));
  assert.equal((await createBundle({...f, batchId:'batch-1', model:'vlm'})).manifest_sha256, created.manifest_sha256);
  assert.deepEqual((await readdir(f.output)).filter(n=>n.startsWith('.bundle-staging-')), []);
});

test('caller assertion is qualified and offline upload claims rejected', async t => {
  const f = await fixture(t);
  const made = await createBundle({...f, binding:'caller_asserted'});
  assert.equal(JSON.parse(await readFile(made.manifest_path)).provider.source_binding.method, 'caller_asserted');
  await assert.rejects(createBundle({...f, binding:'uploaded_exact_bytes'}), {code:'invalid_binding'});
});

test('reject malformed ZIP, preserve exact quarantine bytes without publishing', async t => {
  const f = await fixture(t, [['../escape', 'evil']]);
  let error;
  await assert.rejects(createBundle(f), e => {error=e;return e.code === 'archive_rejected';});
  assert.deepEqual(await readFile(error.quarantine_path), f.raw);
  assert.equal((await readdir(f.output)).some(n=>n.startsWith('bundle-')), false);
});

test('reject non-PDF, source symlink, symlink directory and output symlink', async t => {
  const f = await fixture(t);
  await writeFile(f.source, 'not a PDF');
  await assert.rejects(createBundle(f), {code:'source_not_pdf'});
  await writeFile(f.source, f.pdf);
  await symlink(f.source, join(f.dir, 'link.pdf'));
  await assert.rejects(createBundle({...f, source:join(f.dir,'link.pdf')}));
  await symlink(f.dir, join(f.dir,'link-dir'));
  await assert.rejects(createBundle({...f, source:join(f.dir,'link-dir','source.pdf')}), {code:'unsafe_path'});
  await mkdir(join(f.dir, 'real-out'));
  await symlink(join(f.dir,'real-out'), f.output);
  await assert.rejects(createBundle(f), {code:'unsafe_path'});
});

test('replay detects retained byte tampering and duplicate manifest keys', async t => {
  const f = await fixture(t), made = await createBundle(f);
  const original = await readFile(made.manifest_path, 'utf8');
  await writeFile(made.manifest_path, original.replace('"schema":', '"schema":"wrong", "schema":'));
  await assert.rejects(createBundle(f));
  await writeFile(made.manifest_path, original);
  await writeFile(join(made.bundle_dir, 'source/source.pdf'), Buffer.alloc(f.pdf.length));
  await assert.rejects(createBundle(f), {code:'bundle_conflict'});
});

test('shape validator rejects unknown fields and invalid date-time', async t => {
  const f = await fixture(t), made = await createBundle(f), manifest = JSON.parse(await readFile(made.manifest_path));
  assert.throws(()=>validateBundleShape({...manifest, accidental:true}), {code:'invalid_manifest'});
  for (const date of ['yesterday', '2026-02-30T00:00:00Z', '2026-09-29T24:00:00Z']) assert.throws(()=>validateBundleShape({...manifest, created_at:date}), {code:'invalid_manifest'});
  assert.throws(()=>validateBundleShape({...manifest, source:{...manifest.source, sha256:'wrong'}}), {code:'invalid_manifest'});
  const invalidMember = structuredClone(manifest); invalidMember.archives[0].members[0].sha256 = null;
  assert.throws(()=>validateBundleShape(invalidMember), {code:'invalid_manifest'});
});
