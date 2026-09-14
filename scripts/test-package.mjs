import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const temporary = mkdtempSync(join(tmpdir(), 'mineru-package-test-'));
try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], { encoding: 'utf8' }));
  execFileSync('tar', ['-xzf', join(temporary, packed[0].filename), '-C', temporary]);
  const packageDir = join(temporary, 'package');
  cpSync('tests', join(packageDir, 'tests'), { recursive: true });
  // Consumers install the published manifest, without the repository's bun.lock.
  execFileSync('bun', ['install', '--production', '--ignore-scripts'], { cwd: packageDir, stdio: 'inherit' });
  const fromSdk = createRequire(join(packageDir, 'node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js'));
  const adapter = JSON.parse(readFileSync(join(dirname(fromSdk.resolve('@hono/node-server')), '../package.json'), 'utf8'));
  assert.match(adapter.version, /^1\./, 'The SDK HTTP adapter must retain Node 18 support');
  execFileSync(process.execPath, ['--test', 'tests/mcp.test.mjs'], { cwd: packageDir, stdio: 'inherit' });
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
