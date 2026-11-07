import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temporary = mkdtempSync(join(realpathSync(tmpdir()), 'mineru-package-test-'));
try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], { encoding: 'utf8' }));
  execFileSync('tar', ['-xzf', join(temporary, packed[0].filename), '-C', temporary]);
  const packageDir = join(temporary, 'package');
  cpSync('tests', join(packageDir, 'tests'), { recursive: true });
  // Consumers install the published manifest, without the repository's bun.lock.
  execFileSync('bun', ['install', '--production', '--ignore-scripts'], { cwd: packageDir, stdio: 'inherit' });
  const modules = join(packageDir, 'node_modules');
  assert.ok(!existsSync(join(modules, '@modelcontextprotocol/sdk')), 'The v1 MCP SDK must not return transitively');
  // No dependency the consumer resolves may require a newer Node major than our own floor.
  const floor = Number(/^>=(\d+)$/.exec(JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).engines.node)[1]);
  const lowestMajor = range => Math.min(...range.split('||').map(part => Number(/\d+/.exec(part)?.[0] ?? 0)));
  const scan = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = join(directory, entry.name);
      if (entry.name.startsWith('@')) { scan(dir); continue; }
      if (!existsSync(join(dir, 'package.json'))) continue;
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      const range = manifest.engines?.node;
      if (typeof range === 'string') assert.ok(lowestMajor(range) <= floor, `${manifest.name}@${manifest.version} requires Node ${range}, above our >=${floor} floor`);
      if (existsSync(join(dir, 'node_modules'))) scan(join(dir, 'node_modules'));
    }
  };
  scan(modules);
  execFileSync(process.execPath, ['--test', 'tests/mcp.test.mjs', 'tests/filesystem-containment.test.mjs', 'tests/operation-writer-identity.test.mjs'], { cwd: packageDir, stdio: 'inherit' });
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
