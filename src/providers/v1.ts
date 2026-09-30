import {Transport, ProviderError, id, list} from './transport.js';
import type {Adapter, Capabilities, Request, Upload, Snapshot, Output, OutputUnavailable, SourceIdentity} from './types.js';

/** Modern uploads/parse/jobs API; deliberately unrelated to agent/parse. */
export class V1Adapter implements Adapter {
  readonly api = 'v1' as const;
  private cached: Capabilities;
  private uploadRequests = new Map<string, Pick<Request, 'sha256' | 'size'>>();
  private completedFiles = new Map<string, string>();
  private jobSources = new Map<string, SourceIdentity>();

  constructor(readonly endpoint: string, private transport = new Transport(endpoint)) {
    if (!/\/(?:api\/)?v1\/?$/.test(new URL(endpoint).pathname)) throw new ProviderError('invalid_v1_endpoint');
    this.cached = {
      api: 'v1', endpoint, observed_at: null, validation: 'fixture-only', sources: null,
      formats: null, tiers: null, ranges: false, remote_cancel: false, lost_id_lookup: false,
    };
  }

  async capabilities(refresh = false) {
    if (refresh) {
      const h = await this.transport.json('health'), tiers = await this.transport.json('tiers');
      if (tiers.object !== 'list' || !Array.isArray(tiers.data)) throw new ProviderError('invalid_capabilities');
      this.cached = {
        ...this.cached, observed_at: new Date().toISOString(),
        sources: list(h.features?.sources).map(id), formats: list(h.features?.output_formats).map(id),
        tiers: tiers.data.map((x: any) => id(x.id)),
      };
    }
    return this.cached;
  }

  private upload(r: any, expectedId?: string, request?: Pick<Request, 'sha256' | 'size'>): Upload {
    const uploadId = id(r.id);
    if (expectedId !== undefined && uploadId !== expectedId) throw new ProviderError('upload_identity_mismatch');
    if (!['pending', 'completed'].includes(r.status)) throw new ProviderError('invalid_upload_state');
    if (request) {
      // Optional evidence can strengthen the binding, never contradict the
      // exact bytes or hide one conflicting checksum behind another field.
      for (const checksum of [r.sha256sum, r.file?.sha256sum]) {
        if (checksum !== undefined && checksum !== null && checksum !== request.sha256) {
          throw new ProviderError('upload_source_mismatch');
        }
      }
      for (const size of [r.bytes, r.file?.bytes, r.file?.size]) {
        if (size !== undefined && size !== null && size !== request.size) throw new ProviderError('upload_source_mismatch');
      }
    }
    if (r.status === 'completed') {
      const fileId = id(r.file?.id), previous = this.completedFiles.get(uploadId);
      if (previous && previous !== fileId) throw new ProviderError('upload_identity_mismatch');
      this.completedFiles.set(uploadId, fileId);
      return {id: uploadId, state: 'completed', fileId};
    }
    if (typeof r.upload_url !== 'string' || (r.upload_method ?? 'PUT') !== 'PUT') {
      throw new ProviderError('unsupported_upload_method');
    }
    const headers = r.upload_headers ?? {};
    if (!headers || typeof headers !== 'object' || Array.isArray(headers) ||
      Object.entries(headers).some(([k, v]) => typeof v !== 'string' || /[\r\n]/.test(k + v))) {
      throw new ProviderError('invalid_upload_headers');
    }
    return {id: uploadId, state: 'pending', url: r.upload_url, method: 'PUT', headers};
  }

  private async uploadResponse(path: string, method: string, uploadId?: string,
    request?: Pick<Request, 'sha256' | 'size'>, body?: unknown) {
    const response = await this.transport.json(path, method, body);
    try {
      return this.upload(response, uploadId, request);
    } catch (error) {
      if (error instanceof ProviderError) throw new ProviderError(error.code, method !== 'GET', error.retryAfter);
      throw new ProviderError('invalid_provider_response', method !== 'GET');
    }
  }

  async prepare(r: Request) {
    if (r.pages || r.model) throw new ProviderError('unsupported_capability');
    const upload = await this.uploadResponse('uploads', 'POST', undefined, r, {
      filename: r.filename, bytes: r.size, mime_type: 'application/pdf', purpose: 'parse', sha256sum: r.sha256,
    });
    this.uploadRequests.set(upload.id, {sha256: r.sha256, size: r.size});
    return upload;
  }

  async inspectUpload(uploadId: string, request?: Request) {
    const expected = id(uploadId);
    return this.uploadResponse(`uploads/${encodeURIComponent(expected)}`, 'GET', expected,
      request ?? this.uploadRequests.get(expected));
  }

  async transfer(u: Upload, bytes: Buffer) {
    if (u.state === 'completed') return;
    if (!u.url) throw new ProviderError('upload_url_missing');
    await this.transport.bytes(u.url, {method: u.method, headers: u.headers, body: bytes as unknown as BodyInit},
      1024 * 1024, Math.min(1800000, 60000 + Math.ceil(bytes.length / 1048576) * 2000));
  }

  async complete(uploadId: string, request?: Request) {
    const expected = id(uploadId), source = request ?? this.uploadRequests.get(expected);
    return this.uploadResponse(`uploads/${encodeURIComponent(expected)}/complete`, 'POST', expected, source,
      source ? {sha256sum: source.sha256} : undefined);
  }

  async submit(r: Request, fileId?: string) {
    if (r.pages || r.model) throw new ProviderError('unsupported_capability');
    const source = fileId ? {type: 'file_id', file_id: id(fileId)} : {type: 'url', url: r.url};
    const result = await this.transport.json('parse/jobs', 'POST', {files: [{source}], tier: r.tier, output_formats: r.formats});
    const jobId = id(result.job_id);
    this.jobSources.set(jobId, {...(fileId ? {fileId} : {}), ...(r.sha256 ? {sha256: r.sha256} : {})});
    return jobId;
  }

  async status(jobId: string, _kind?: string, expected?: SourceIdentity): Promise<Snapshot> {
    const r = await this.transport.json(`parse/jobs/${encodeURIComponent(id(jobId))}`);
    if (id(r.job_id) !== jobId) throw new ProviderError('identity_mismatch');
    const states: Record<string, Snapshot['state']> = {
      queued: 'pending', running: 'running', completed: 'succeeded', partial: 'partial',
      failed: 'failed', canceled: 'cancelled', cancelled: 'cancelled',
    };
    const outputs: Output[] = [], missing: string[] = [], unavailable: OutputUnavailable[] = [];
    const source = expected ?? this.jobSources.get(jobId);
    if (!Array.isArray(r.files) || r.files.length !== 1) throw new ProviderError('invalid_provider_response');
    for (const [index, f] of r.files.entries()) {
      if (source?.fileId && f.file_id !== undefined && id(f.file_id) !== source.fileId ||
        source?.sha256 && f.sha256sum !== undefined && f.sha256sum !== source.sha256) {
        throw new ProviderError('input_identity_mismatch');
      }
      if (f.status !== 'completed') {
        const status = states[f.status] ?? 'unknown', format = `file-${index}`;
        missing.push(`${format}:${status}`);
        unavailable.push({role: 'unknown', format, file_id: f.file_id == null ? null : id(f.file_id),
          reason: status === 'cancelled' ? 'cancelled' : 'unknown', cause: `provider_file_${status}`,
          retry: 'unavailable', attempts: 0});
        continue;
      }
      if (!f.output_files || typeof f.output_files !== 'object' || Array.isArray(f.output_files)) {
        throw new ProviderError('invalid_provider_response');
      }
      for (const [format, ref] of Object.entries(f.output_files)) {
        const fileId = id((ref as any)?.file_id);
        outputs.push({id: fileId, fileId, format: id(format)});
      }
    }
    return {id: jobId, state: states[r.status] ?? 'unknown', outputs, missing, unavailable};
  }

  async download(output: Output) {
    if (!output.fileId) throw new ProviderError('output_identity_missing');
    return this.transport.apiBytes(`files/${encodeURIComponent(id(output.fileId))}/content`);
  }
}
