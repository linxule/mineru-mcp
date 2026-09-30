import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mapContentList, validatePageMap, inspectSourcePDF } from '../dist/providers/page_mapping.js';
import { canonicalHash } from '../dist/canonical.js';
const root = new URL('./fixtures/page-mapping/', import.meta.url);
const read = path => readFile(new URL(path, root));
const cases = JSON.parse(await read('cases.json')).cases;
for (const fixture of cases) test(`shared mapper: ${fixture.name}`, async () => {
  const payload = await read(fixture.payload);
  if (fixture.error) {
    assert.throws(() => mapContentList(payload, fixture.context), error => error.code === fixture.error);
  } else {
    const actual = mapContentList(payload, fixture.context);
    assert.deepEqual(actual, JSON.parse(await read(fixture.expected)));
    assert.equal(canonicalHash(actual), fixture.result_sha256);
    assert.deepEqual(validatePageMap(actual.page_map, payload, fixture.context), actual);
    assert.deepEqual(actual.observed_pages, [1, 3]);
    assert.equal(actual.coverage.status, 'unknown');
    assert.ok(actual.page_map.blocks.every(block => block.bbox === null && block.printed_page_label === null));
  }
});
test('shared fixture bytes match their inventory', async () => {
  for (const file of JSON.parse(await read('manifest.json')).files) {
    const bytes = await read(file.path);
    assert.equal(bytes.length, file.size_bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
  }
});
for (const [field, value] of Object.entries({page_number:2, raw_json_pointer:'/1', source_page_index_base:1, block_id:'blk_forged', bbox:{x0:0}})) test(`forged map: ${field}`, async () => {
  const fixture=cases[0], payload=await read(fixture.payload), result=mapContentList(payload,fixture.context);
  result.page_map.blocks[0][field]=value;
  assert.throws(() => validatePageMap(result.page_map,payload,fixture.context), error => error.code==='page_map_mismatch');
});
let pdfinfoAvailable=true;
try { execFileSync('pdfinfo',['-v'],{stdio:'ignore'}); } catch { pdfinfoAvailable=false; }
test('source pages come from exact hashed PDF bytes', {skip:!pdfinfoAvailable}, async () => {
  const bytes=await read('source-three-pages.pdf');
  assert.equal((await inspectSourcePDF(bytes,createHash('sha256').update(bytes).digest('hex'))).page_count,3);
  await assert.rejects(inspectSourcePDF(bytes,'a'.repeat(64)),error=>error.code==='page_mapping_source_mismatch');
});
