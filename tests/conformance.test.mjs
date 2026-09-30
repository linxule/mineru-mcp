import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdtemp, readFile, realpath, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validateBundle, readManifest, validateManifest } from '../dist/bundle/validation.js';

const fixtures = fileURLToPath(new URL('./fixtures/artifact-contract/', import.meta.url));
const matrix = JSON.parse(await readFile(join(fixtures, 'conformance/cases.json'), 'utf8'));
for (const entry of matrix.cases) {
  test(`generic bundle conformance: ${entry.id}`, async () => {
    const temp = await mkdtemp(join(await realpath(tmpdir()), 'mineru-conformance-'));
    try {
      const root = join(temp, 'bundle');
      await cp(join(fixtures, entry.root), root, { recursive: true });
      const actions = entry.filesystem ?? {};
      if (actions.symlink_file) {
        const path = join(root, actions.symlink_file), outside = join(temp, 'external-file');
        await rename(path, outside); await symlink(outside, path);
      }
      if (actions.symlink_directory) {
        const path = join(root, actions.symlink_directory), outside = join(temp, 'external-directory');
        await rename(path, outside); await symlink(outside, path, 'dir');
      }
      if (entry.valid) {
        const result = await validateBundle(root, entry.reader_limits);
        assert.equal(result.manifest_sha256, createHash('sha256').update(await readFile(join(root, 'bundle.json'))).digest('hex'));
        validateManifest((await readManifest(root)).manifest);
      } else {
        await assert.rejects(validateBundle(root, entry.reader_limits));
      }
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
}
