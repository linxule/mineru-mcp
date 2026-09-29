import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { canonicalBytes, canonicalHash, canonicalNormalizedBytes, normalizeHashInput, strictLoads, ExactDecimal, CanonicalJSONError } from '../dist/canonical.js';
const fixtureRoot = process.env.ARTIFACT_CONTRACT_FIXTURES ?? fileURLToPath(new URL('./fixtures/artifact-contract/', import.meta.url));
const vectors = JSON.parse(readFileSync(resolve(fixtureRoot, 'canonical/vectors.json'), 'utf8'));
for (const c of vectors.positive) test(`positive ${c.name}`, () => {
  const value = strictLoads(c.input_json);
  assert.equal(canonicalBytes(value).toString('utf8'), c.canonical_json);
  assert.equal(canonicalHash(value), c.sha256);
  assert.deepEqual(canonicalNormalizedBytes(normalizeHashInput(value)), canonicalBytes(value));
});
for (const c of vectors.negative) test(`negative ${c.name}`, () => {
  assert.throws(() => canonicalBytes(strictLoads(c.input_json)), CanonicalJSONError);
});
test('frozen fixture manifest', () => {
  const manifest = JSON.parse(readFileSync(resolve(fixtureRoot, 'manifest.json'), 'utf8'));
  for (const entry of manifest.files) {
    const bytes = readFileSync(resolve(fixtureRoot, entry.path));
    assert.equal(bytes.length, entry.size_bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
  }
});
test('reject unsafe programmatic values', () => {
  for (const value of [1.1, NaN, Infinity, 9007199254740992, undefined, 1n, new Date(), [,,], '\ud800']) {
    assert.throws(() => canonicalBytes(value), CanonicalJSONError);
  }
});
test('invalid UTF8 and BOM', () => {
  for (const bytes of [Buffer.from([34, 255, 34]), Buffer.from([239,187,191,123,125])]) {
    assert.throws(() => strictLoads(bytes), CanonicalJSONError);
  }
});
test('malformed normalized decimal rejected', () => {
  for (const value of ['1.00', '1e-1', '-0', 'NaN', '+0.1']) {
    assert.throws(() => canonicalNormalizedBytes({'$scholia.type': 'decimal', '$scholia.value': value}), CanonicalJSONError);
  }
  assert.equal(canonicalBytes(new ExactDecimal('1.250')).toString(), '{"$scholia.type":"decimal","$scholia.value":"1.25"}');
});
test('long integer lexeme stays exact', () => {
  const digits = '1234567890'.repeat(500) + '1';
  assert.equal(canonicalBytes(strictLoads(digits)).toString(), '{"$scholia.type":"decimal","$scholia.value":"' + digits + '"}');
});
