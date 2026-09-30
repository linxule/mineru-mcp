import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {Operations} from '../dist/operations.js';
import {Transport} from '../dist/providers/transport.js';
import {V1Adapter} from '../dist/providers/v1.js';
import {V4Adapter} from '../dist/providers/v4.js';

const KEY = 'SYNTHETIC_REVIEW_KEY';
const SOURCE = Buffer.from('%PDF-1.7\nsynthetic provider boundary fixture\n%%EOF');
const REQUEST = {
  sha256: createHash('sha256').update(SOURCE).digest('hex'), size: SOURCE.length,
  filename: 'source.pdf', tier: 'standard', formats: ['markdown'],
};
const V4_REQUEST = {...REQUEST, tier: undefined, formats: ['zip']};
const percent = value => [...Buffer.from(value)].map(byte => `%${byte.toString(16).padStart(2, '0')}`).join('');
const encodings = [KEY, percent(KEY), percent(percent(KEY)), `bad%escape-${percent(KEY)}`];

function fixture(t, api, override = () => undefined) {
  const dir = mkdtempSync('/private/tmp/mineru-provider-security-');
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const source = join(dir, 'source.pdf');
  writeFileSync(source, SOURCE);
  const endpoint = `https://api.example/api/${api}`, calls = [];
  const fetcher = async (url, init) => {
    const call = {
      url: String(url), path: new URL(url).pathname, method: init.method ?? 'GET',
      headers: new Headers(init.headers), body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
    };
    calls.push(call);
    const supplied = await override(call);
    if (supplied !== undefined) return supplied;
    if (call.path.endsWith('/health')) return Response.json({features: {sources: ['file_id', 'url'], output_formats: ['markdown']}});
    if (call.path.endsWith('/tiers')) return Response.json({object: 'list', data: [{id: 'standard'}]});
    if (call.path.endsWith('/file-urls/batch')) return Response.json({code: 0, data: {batch_id: 'batch', file_urls: ['https://storage.example/upload?signature=PRIVATE']}});
    if (call.path.endsWith('/uploads')) return Response.json({id: 'expected-upload', status: 'pending', upload_url: 'https://storage.example/upload?signature=PRIVATE'});
    if (call.path === '/upload') return new Response(null, {status: 204});
    if (call.path.endsWith('/uploads/expected-upload/complete') || call.path.endsWith('/uploads/expected-upload')) {
      return Response.json({id: 'expected-upload', status: 'completed', bytes: SOURCE.length,
        sha256sum: REQUEST.sha256, file: {id: 'source-file', sha256sum: REQUEST.sha256, bytes: SOURCE.length}});
    }
    if (call.path.endsWith('/parse/jobs')) return Response.json({job_id: 'job'});
    if (call.path.endsWith('/parse/jobs/job')) return Response.json({job_id: 'job', status: 'completed',
      files: [{file_id: 'source-file', status: 'completed', output_files: {markdown: {file_id: 'md'}}}]});
    if (call.path.endsWith('/files/md/content')) return new Response('# retained fixture');
    throw new Error('Unexpected synthetic provider path');
  };
  // Construct a fresh adapter each time, as an actual process restart would.
  const adapterFactory = () => api === 'v1' ? new V1Adapter(endpoint, new Transport(endpoint, KEY, fetcher)) :
    new V4Adapter(endpoint, new Transport(endpoint, KEY, fetcher));
  const config = {stateDir: join(dir, 'journal'), adapterFactory};
  const ops = new Operations(config);
  return {dir, source, endpoint, calls, config, ops, adapterFactory,
    options: {file: source, output_dir: join(dir, 'out'), ...(api === 'v1' ? {api, tier: 'standard'} : {})}};
}

function journal(f, operationId) {
  return readFileSync(join(f.config.stateDir, 'operations', operationId, 'operation.json'), 'utf8');
}

function assertPrivateResult(f, result, forbidden = KEY) {
  assert.equal(result.remote_id, null);
  assert.equal(result.recovery.known_evidence.upload_id, null);
  assert.equal(result.recovery.known_evidence.file_id, null);
  assert.equal(result.error.code, 'credential_echo_forbidden');
  assert.ok(!JSON.stringify(result).includes(forbidden));
  assert.ok(!journal(f, result.operation_id).includes(forbidden));
  assert.doesNotMatch(journal(f, result.operation_id), /signature|PRIVATE/);
}

test('default V4 rejects raw and encoded credential grants before storage or persistence', async t => {
  for (const [index, echo] of encodings.entries()) {
    await t.test(`URL spelling ${index}`, async t => {
      const f = fixture(t, 'v4', call => call.path.endsWith('/file-urls/batch') ?
        Response.json({code: 0, data: {batch_id: 'batch', file_urls: [`https://storage.example/upload?key=${echo}`]}}) : undefined);
      const result = await f.ops.submit(f.options);
      assert.equal(result.state, 'reconciliation_required');
      assertPrivateResult(f, result, echo);
      assert.equal(f.calls.length, 1);
      await f.ops.resume(result.operation_id);
      assert.equal(f.calls.length, 1, 'an uncertain allocation must not be repeated');
    });
  }
});

test('V1 rejects credential echoes in provider-supplied URL, header names, and header values', async t => {
  const grants = [
    {upload_url: `https://storage.example/upload?key=${percent(KEY)}`},
    {upload_headers: {'X-Key-Echo': KEY}},
    {upload_headers: {'X-Key-Echo': percent(KEY)}},
    {upload_headers: {[`X-${KEY}-Echo`]: 'required'}},
    {upload_headers: {[`X-${KEY.toLowerCase()}-Echo`]: 'required'}},
  ];
  for (const [index, grant] of grants.entries()) {
    await t.test(`grant ${index}`, async t => {
      const f = fixture(t, 'v1', call => call.path.endsWith('/uploads') ? Response.json({
        id: 'expected-upload', status: 'pending', upload_url: 'https://storage.example/upload', ...grant,
      }) : undefined);
      const result = await f.ops.submit(f.options);
      assertPrivateResult(f, result);
      assert.equal(result.state, 'reconciliation_required');
      assert.equal(f.calls.some(c => c.path === '/upload' || c.path.endsWith('/parse/jobs')), false);
    });
  }
});

test('credential-shaped V4 and V1 returned identities never enter durable operations', async t => {
  for (const api of ['v4', 'v1']) for (const encoded of [KEY, `prefix-${KEY}`, percent(KEY)]) {
    await t.test(`${api} identity ${encoded === KEY ? 'literal' : encoded.startsWith('prefix') ? 'substring' : 'encoded'}`, async t => {
      const f = fixture(t, api, call => {
        if (api === 'v4' && call.path.endsWith('/file-urls/batch')) return Response.json({code: 0, data: {
          batch_id: encoded, file_urls: ['https://storage.example/upload'],
        }});
        if (api === 'v1' && call.path.endsWith('/uploads')) return Response.json({id: encoded,
          status: 'pending', upload_url: 'https://storage.example/upload'});
      });
      const result = await f.ops.submit(f.options);
      assertPrivateResult(f, result, encoded);
      assert.equal(result.state, 'reconciliation_required');
      await f.ops.resume(result.operation_id);
      assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
    });
  }
});

test('returned file, job, output, format, and capability identities reject credential echoes', async t => {
  const cases = [
    {name: 'V1 completed file ID', api: 'v1', response: {id: 'u', status: 'completed', file: {id: KEY}}, invoke: a => a.prepare(REQUEST), uncertain: true},
    {name: 'V1 parse job ID', api: 'v1', response: {job_id: KEY}, invoke: a => a.submit(REQUEST, 'f'), uncertain: true},
    {name: 'V4 task ID', api: 'v4', response: {code: 0, data: {task_id: KEY}}, invoke: a => a.submit({...V4_REQUEST, url: 'https://source.example/paper.pdf'}), uncertain: true},
    {name: 'V1 output file ID', api: 'v1', response: {job_id: 'j', status: 'completed', files: [{status: 'completed', output_files: {markdown: {file_id: percent(KEY)}}}]}, invoke: a => a.status('j'), uncertain: false},
    {name: 'V1 output format', api: 'v1', response: {job_id: 'j', status: 'completed', files: [{status: 'completed', output_files: {[KEY]: {file_id: 'output'}}}]}, invoke: a => a.status('j'), uncertain: false},
    {name: 'V1 health format', api: 'v1', response: {features: {sources: ['file_id'], output_formats: [KEY]}}, invoke: a => a.capabilities(true), uncertain: false},
    {name: 'V1 tier ID', api: 'v1', response: {object: 'list', data: [{id: KEY}]}, health: true, invoke: a => a.capabilities(true), uncertain: false},
    {name: 'V4 returned output URL', api: 'v4', response: {code: 0, data: {batch_id: 'b', extract_result: [{state: 'done', full_zip_url: `https://storage.example/result?key=${percent(KEY)}`}] }}, invoke: a => a.status('b'), uncertain: false},
  ];
  for (const c of cases) await t.test(c.name, async () => {
    const endpoint = `https://api.example/api/${c.api}`;
    const transport = new Transport(endpoint, KEY, async url => c.health && String(url).endsWith('/health') ?
      Response.json({features: {sources: ['file_id'], output_formats: ['markdown']}}) : Response.json(c.response));
    const adapter = c.api === 'v1' ? new V1Adapter(endpoint, transport) : new V4Adapter(endpoint, transport);
    await assert.rejects(c.invoke(adapter), error => error.code === 'credential_echo_forbidden' &&
      error.uncertain === c.uncertain && !error.message.includes(KEY));
  });
});

test('transfer dispatch and redirect validation reject echoes while keeping storage credentials separate', async t => {
  let count = 0;
  const transport = new Transport('https://api.example/api/v1', KEY, async () => {
    count++;
    return new Response(null, {status: 204});
  });
  for (const echo of encodings) await assert.rejects(
    transport.bytes(`https://storage.example/upload?key=${echo}`, {method: 'PUT', body: SOURCE}),
    {code: 'credential_echo_forbidden'},
  );
  for (const headers of [{[`x-${KEY}`]: 'required'}, {'X-Echo': percent(KEY)}, {'Authorization': `Bearer ${KEY}`}]) {
    await assert.rejects(transport.bytes('https://storage.example/upload', {method: 'PUT', headers, body: SOURCE}),
      {code: 'credential_echo_forbidden'});
  }
  assert.equal(count, 0);
  const sent = [];
  const safe = new Transport('https://api.example/api/v1', KEY, async (url, init) => {
    sent.push(new Headers(init.headers));
    return new Response(null, {status: 204});
  });
  await safe.bytes('https://storage.example/upload?signature=PRIVATE', {method: 'PUT',
    headers: {Authorization: 'Storage SIGNATURE', 'X-Upload': 'required'}, body: SOURCE});
  assert.equal(sent[0].get('authorization'), 'Storage SIGNATURE');
  assert.equal(sent[0].get('x-upload'), 'required');
  let redirects = 0;
  const redirect = new Transport('https://api.example/api/v1', KEY, async () => {
    redirects++;
    return new Response(null, {status: 302, headers: {location: `https://storage.example/content?echo=${percent(KEY)}`}});
  });
  await assert.rejects(redirect.apiBytes('files/f/content'), {code: 'credential_echo_forbidden'});
  assert.equal(redirects, 1, 'the echoed redirect is rejected before a second dispatch');
});

test('conflicting V1 completion cannot submit a foreign file or produce a bound bundle', async t => {
  const f = fixture(t, 'v1', call => call.path.endsWith('/complete') ?
    Response.json({id: 'different-upload', status: 'completed', file: {id: 'foreign-file', sha256sum: REQUEST.sha256}}) : undefined);
  const result = await f.ops.submit(f.options);
  assert.equal(result.state, 'reconciliation_required');
  assert.equal(result.error.code, 'upload_identity_mismatch');
  assert.equal(result.recovery.known_evidence.upload_id, 'expected-upload');
  assert.equal(result.recovery.known_evidence.file_id, null);
  assert.equal(result.remote_id, null);
  assert.equal(f.calls.some(c => c.path.endsWith('/parse/jobs')), false);
  const transfer = f.calls.find(c => c.path === '/upload');
  assert.deepEqual(Buffer.from(transfer.body), SOURCE);
  assert.equal(transfer.headers.get('authorization'), null);
  await f.ops.resume(result.operation_id);
  assert.equal(f.calls.filter(c => c.path.endsWith('/complete')).length, 1);
  await assert.rejects(f.ops.bundle(result.operation_id), {code: 'bundle_not_ready'});
  assert.ok(!journal(f, result.operation_id).includes('foreign-file'));
});

test('new-process V1 inspection correlates upload ID, all checksums, and exact byte count', async t => {
  const conflicts = [
    {name: 'upload ID', value: {id: 'different-upload'}, code: 'upload_identity_mismatch'},
    {name: 'top checksum', value: {sha256sum: 'b'.repeat(64)}, code: 'upload_source_mismatch'},
    {name: 'file checksum', value: {sha256sum: REQUEST.sha256, file: {id: 'foreign-file', sha256sum: 'b'.repeat(64)}}, code: 'upload_source_mismatch'},
    {name: 'top size', value: {bytes: SOURCE.length + 1}, code: 'upload_source_mismatch'},
    {name: 'file size', value: {file: {id: 'foreign-file', bytes: SOURCE.length + 1}}, code: 'upload_source_mismatch'},
  ];
  for (const conflict of conflicts) await t.test(conflict.name, async t => {
    const f = fixture(t, 'v1', call => {
      if (call.path.endsWith('/complete')) throw new Error('Synthetic lost completion response');
      if (call.path.endsWith('/uploads/expected-upload')) return Response.json({id: 'expected-upload',
        status: 'completed', file: {id: 'source-file'}, ...conflict.value});
    });
    const result = await f.ops.submit(f.options);
    assert.equal(result.state, 'waiting_external');
    const recovered = await new Operations(f.config).resume(result.operation_id);
    assert.equal(recovered.state, 'reconciliation_required');
    assert.equal(recovered.error.code, conflict.code);
    assert.equal(recovered.remote_id, null);
    assert.equal(recovered.recovery.known_evidence.file_id, null);
    assert.equal(f.calls.some(c => c.path.endsWith('/parse/jobs')), false);
    assert.equal(f.calls.filter(c => c.path.endsWith('/complete')).length, 1);
    await assert.rejects(f.ops.bundle(result.operation_id), {code: 'bundle_not_ready'});
  });
});

test('V1 completion checks cached allocation checksum and preserves POST uncertainty', async () => {
  const endpoint = 'https://api.example/api/v1', bodies = [];
  const transport = new Transport(endpoint, KEY, async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return String(url).endsWith('/uploads') ? Response.json({id: 'u', status: 'pending', upload_url: 'https://storage.example/upload'}) :
      Response.json({id: 'u', status: 'completed', file: {id: 'foreign-file', sha256sum: 'b'.repeat(64)}});
  });
  const adapter = new V1Adapter(endpoint, transport);
  await adapter.prepare(REQUEST);
  await assert.rejects(adapter.complete('u'), error => error.code === 'upload_source_mismatch' && error.uncertain);
  assert.equal(bodies[1].sha256sum, REQUEST.sha256);
});

test('matching V1 inspection safely resumes once and binds the retained exact bytes', async t => {
  const f = fixture(t, 'v1', call => {
    if (call.path.endsWith('/complete')) throw new Error('Synthetic lost completion response');
  });
  const first = await f.ops.submit(f.options);
  assert.equal(first.remote_id, null);
  const done = await new Operations(f.config).resume(first.operation_id);
  assert.equal(done.state, 'succeeded', JSON.stringify(done));
  const manifest = JSON.parse(readFileSync(join(done.bundle_dir, 'bundle.json'), 'utf8'));
  assert.equal(manifest.provider.source_binding.method, 'uploaded_exact_bytes');
  assert.equal(f.calls.filter(c => c.path.endsWith('/uploads')).length, 1);
  assert.equal(f.calls.filter(c => c.path.endsWith('/complete')).length, 1);
  assert.equal(f.calls.filter(c => c.path.endsWith('/parse/jobs')).length, 1);
  assert.equal(f.calls.find(c => c.path.endsWith('/parse/jobs')).body.files[0].source.file_id, 'source-file');
  assert.doesNotMatch(journal(f, done.operation_id), /signature|PRIVATE/);
});

test('V1 foreign input file and V4 foreign data_id cannot enter exact-source finalization', async t => {
  for (const api of ['v1', 'v4']) await t.test(api, async t => {
    const f = fixture(t, api, call => {
      if (api === 'v1' && call.path.endsWith('/parse/jobs/job')) return Response.json({job_id: 'job', status: 'completed',
        files: [{file_id: 'foreign-file', status: 'completed', output_files: {markdown: {file_id: 'md'}}}]});
      if (api === 'v4' && call.path.endsWith('/extract-results/batch/batch')) return Response.json({code: 0, data: {
        batch_id: 'batch', extract_result: [{data_id: 'foreign-hash', state: 'done', full_zip_url: 'https://storage.example/result?signature=PRIVATE'}],
      }});
    });
    const first = await f.ops.submit(f.options);
    const result = await f.ops.resume(first.operation_id);
    assert.equal(result.state, 'reconciliation_required');
    assert.equal(result.error.code, 'input_identity_mismatch');
    assert.equal(result.outputs.length, 0);
    assert.equal(result.bundle_dir, null);
    assert.equal(f.calls.some(c => c.path.endsWith('/files/md/content') || c.path === '/result'), false);
  });
});

test('404/410 output content becomes expired while API status retains its rejection meaning', async () => {
  for (const status of [404, 410]) {
    const endpoint = 'https://api.example/api/v1';
    const transport = new Transport(endpoint, KEY, async () => new Response(null, {status}));
    await assert.rejects(new V1Adapter(endpoint, transport).download({id: 'o', format: 'markdown', fileId: 'o'}), {code: 'output_expired'});
    await assert.rejects(transport.json('parse/jobs/job'), {code: 'provider_rejected'});
    const v4 = new V4Adapter('https://api.example/api/v4', transport);
    await assert.rejects(v4.download({id: 'zip', format: 'zip', url: 'https://storage.example/result'}), {code: 'output_expired'});
  }
});

test('V1 per-file terminal status preserves typed provider file identity without guessing its format', async () => {
  const adapter = new V1Adapter('https://api.example/api/v1', {json: async () => ({job_id: 'j', status: 'partial',
    files: [{file_id: 'source-file', status: 'cancelled'}]})});
  const status = await adapter.status('j', 'job', {fileId: 'source-file'});
  assert.deepEqual(status.unavailable, [{role: 'unknown', format: 'file-0', file_id: 'source-file',
    reason: 'cancelled', cause: 'provider_file_cancelled', retry: 'unavailable', attempts: 0}]);
});

test('hosted V1 is still gated before credentials or provider execution', async t => {
  const dir = mkdtempSync('/private/tmp/mineru-v1-gate-');
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const source = join(dir, 'source.pdf');
  writeFileSync(source, SOURCE);
  const ops = new Operations({stateDir: join(dir, 'journal'), apiKey: KEY});
  await assert.rejects(ops.submit({file: source, api: 'v1', tier: 'standard', output_dir: join(dir, 'out')}),
    {code: 'hosted_v1_not_validated'});
});
