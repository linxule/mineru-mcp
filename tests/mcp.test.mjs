import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Exercise the built entry points against a local MinerU API double. No real
// credential, document upload, or provider request is needed for these tests.
async function mockApi(t) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ url: req.url, method: req.method, body, auth: req.headers.authorization });
    let data;
    if (req.url === '/extract/task') data = { task_id: 'task-1' };
    else if (req.url === '/extract/task/batch') data = { batch_id: 'batch-1' };
    else if (req.url === '/extract/task/task-1') data = { task_id: 'task-1', state: 'running', extract_progress: { extracted_pages: 2, total_pages: 5 } };
    else if (req.url === '/extract-results/batch/batch-1') data = { batch_id: 'batch-1', extract_result: Array.from({ length: 12 }, (_, i) => ({ file_name: `paper-${i}.pdf`, state: 'pending' })) };
    else if (req.url === '/extract/task/expired') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'A0211', msg: 'expired' }));
      return;
    } else {
      res.writeHead(404); res.end(); return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ code: 0, data }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
}

async function verifyTools(client, requests) {
  assert.equal(client.getServerVersion().version, packageVersion);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['mineru_batch', 'mineru_batch_status', 'mineru_download_results', 'mineru_parse', 'mineru_status', 'mineru_upload_batch']);
  assert.deepEqual(tools.find(tool => tool.name === 'mineru_parse').inputSchema.required, ['url']);
  const call = (name, args) => client.callTool({ name, arguments: args });
  const parsed = await call('mineru_parse', { url: 'https://example.test/paper.pdf', ocr: false, formula: false, table: true, formats: ['html'] });
  assert.match(parsed.content[0].text, /Task created: task-1/);
  assert.deepEqual(requests.at(-1).body, { url: 'https://example.test/paper.pdf', model_version: 'pipeline', is_ocr: false, enable_formula: false, enable_table: true, extra_formats: ['html'] });
  assert.equal(requests.at(-1).auth, 'Bearer test-only');
  const status = await call('mineru_status', { task_id: 'task-1' });
  assert.equal(status.content[0].text, 'running | task-1 | 2/5 pages');
  const detailed = await call('mineru_status', { task_id: 'task-1', format: 'detailed' });
  assert.equal(JSON.parse(detailed.content[0].text).state, 'running');
  for (const urls of [['https://example.test/a.pdf'], 'https://example.test/a.pdf', '["https://example.test/a.pdf"]']) {
    const batch = await call('mineru_batch', { urls, model: 'vlm' });
    assert.match(batch.content[0].text, /1 files queued/);
    assert.deepEqual(requests.at(-1).body, { files: [{ url: 'https://example.test/a.pdf' }], model_version: 'vlm' });
  }
  const batch = await call('mineru_batch_status', { batch_id: 'batch-1' });
  assert.match(batch.content[0].text, /paper-9.pdf/);
  assert.doesNotMatch(batch.content[0].text, /paper-10.pdf/);
  assert.match(batch.content[0].text, /\[\+2 more, use offset=10\]/);
  const page = await call('mineru_batch_status', { batch_id: 'batch-1', offset: 10, limit: 1 });
  assert.match(page.content[0].text, /paper-10.pdf/);
  assert.doesNotMatch(page.content[0].text, /paper-11.pdf/);
  const beforeInvalid = requests.length;
  assert.equal((await call('mineru_parse', {})).isError, true);
  assert.equal((await call('mineru_batch', { urls: ['a'], model: 'invalid' })).isError, true);
  assert.equal(requests.length, beforeInvalid);
  const expired = await call('mineru_status', { task_id: 'expired' });
  assert.equal(expired.isError, true);
  assert.match(expired.content[0].text, /Token expired/);
}

test('stdio preserves tools, request mapping, defaults and errors with Zod 4', { timeout: 30000 }, async t => {
  const api = await mockApi(t);
  const client = new Client({ name: 'mineru-regression', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'], env: { PATH: process.env.PATH, MINERU_API_KEY: 'test-only', MINERU_BASE_URL: api.baseUrl }, stderr: 'pipe' });
  t.after(() => client.close());
  await client.connect(transport);
  await verifyTools(client, api.requests);
});

test('HTTP preserves session lifecycle, malformed request handling and tool behavior with Express 5', { timeout: 30000 }, async t => {
  const api = await mockApi(t);
  const reserve = createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const child = spawn(process.execPath, ['dist/server.js'], { env: { PATH: process.env.PATH, MINERU_API_KEY: 'test-only', MINERU_BASE_URL: api.baseUrl, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => { if (child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; } });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    assert.equal(child.exitCode, null, logs);
    try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { status: 'ok', service: 'mineru-mcp' });
  for (const method of ['GET', 'DELETE']) assert.equal((await fetch(`${base}/mcp`, { method })).status, 400);
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).status, 400);
  const client = new Client({ name: 'mineru-http-regression', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
  t.after(() => client.close());
  await client.connect(transport);
  assert.ok(transport.sessionId);
  const sessionId = transport.sessionId;
  await verifyTools(client, api.requests);
  await transport.terminateSession();
  assert.equal((await fetch(`${base}/mcp`, { headers: { 'mcp-session-id': sessionId } })).status, 400);
});
