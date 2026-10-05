import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mapContentList, validatePageMap, inspectSourcePDF } from '../dist/providers/page_mapping.js';
import { canonicalHash } from '../dist/canonical.js';

const root = new URL('./fixtures/page-mapping/', import.meta.url);
const read = path => readFile(new URL(path, root));
const cases = JSON.parse(await read('prefix-cases.json')).cases;
for (const fixture of cases) test(`shared prefix mapper: ${fixture.name}`, async () => {
  const payload = await read(fixture.payload);
  if (fixture.error) {
    assert.throws(() => mapContentList(payload, fixture.context), error => error.code === fixture.error);
  } else {
    const result = mapContentList(payload, fixture.context);
    assert.deepEqual(result, JSON.parse(await read(fixture.expected)));
    assert.equal(canonicalHash(result), fixture.result_sha256);
    assert.deepEqual(validatePageMap(result.page_map, payload, fixture.context), result);
    assert.deepEqual(result.page_map.adapter, { name: 'mineru-content-list-flat', version: '2' });
    assert.equal(result.coverage.status, 'unknown');
    assert.equal(result.coverage.source_complete, null);
    assert.ok(result.page_map.blocks.every(block => block.source_page_index_base === 0 && block.slice === null));
  }
});

for (const [field, value] of Object.entries({ page_number: 3, source_page_index: 2,
  raw_json_pointer: '/2', source_page_index_base: 1, artifact_id: 'forged', bbox: { x0: 0 } })) {
  test(`prefix claimed page map cannot override raw derivation: ${field}`, async () => {
    const fixture = cases[0], payload = await read(fixture.payload);
    const result = mapContentList(payload, fixture.context);
    result.page_map.blocks[0][field] = value;
    assert.throws(() => validatePageMap(result.page_map, payload, fixture.context), error => error.code === 'page_map_mismatch');
  });
}

test('claimed prefix map cannot authorize a V1 or absent retained request', async () => {
  const fixture = cases[0], payload = await read(fixture.payload);
  const result = mapContentList(payload, fixture.context);
  for (const changed of [{ api_generation: 'v1' }, { provider_request_options: {} },
    { provider_request_options: { page_ranges: '2-3', validated: true } }]) {
    assert.throws(() => validatePageMap(result.page_map, payload, { ...fixture.context, ...changed }),
      error => error.code === 'unsupported_page_scope');
  }
});

let pdfinfoAvailable = true;
try { execFileSync('pdfinfo', ['-v'], { stdio: 'ignore' }); } catch { pdfinfoAvailable = false; }
test('prefix bounds use the exact original PDF rather than a caller count', { skip: !pdfinfoAvailable }, async () => {
  const bytes = await read('source-three-pages.pdf'), sourceHash = createHash('sha256').update(bytes).digest('hex');
  const inspected = await inspectSourcePDF(bytes, sourceHash);
  assert.equal(inspected.page_count, 3);
  const payload = await read('prefix-positive.json'), context = cases[0].context;
  const result = mapContentList(payload, { ...context, source_document_sha256: sourceHash, source_page_count: inspected.page_count });
  assert.deepEqual(result.observed_pages, [1, 2]);
  assert.throws(() => mapContentList(payload, { ...context, source_page_count: inspected.page_count,
    requested_ranges: [{ start: 1, end: 4 }], provider_request_options: { page_ranges: '1-4' } }),
    error => error.code === 'unsupported_page_scope');
});
