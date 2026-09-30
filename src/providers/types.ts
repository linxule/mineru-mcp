export type Api = 'v1' | 'v4';
export interface Request {
  sha256: string; size: number; filename: string; model?: string; tier?: string;
  pages?: string; formats: string[]; url?: string;
}
export interface Upload {
  id: string; state: 'pending' | 'completed'; fileId?: string; url?: string;
  method?: string; headers?: Record<string, string>;
}
export interface Output {id: string; format: string; url?: string; fileId?: string;}
export interface SourceIdentity {fileId?: string; sha256?: string;}
export type UnavailableReason = 'download_failed' | 'expired' | 'limit_exceeded' | 'not_returned' | 'unsupported_format' | 'cancelled' | 'unknown';
export interface OutputUnavailable {
  role: string; format: string; file_id: string | null; reason: UnavailableReason;
  cause: string; retry: 'automatic' | 'explicit' | 'unavailable'; attempts: number;
}
export interface Snapshot {
  id: string;
  state: 'pending' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'unknown';
  outputs: Output[]; missing: string[]; unavailable?: OutputUnavailable[];
}
export interface Capabilities {
  api: Api; endpoint: string; observed_at: string | null; validation: 'fixture-only';
  sources: string[] | null; formats: string[] | null; tiers: string[] | null;
  ranges: boolean; remote_cancel: false; lost_id_lookup: false;
}
export interface Adapter {
  api: Api; endpoint: string; capabilities(refresh?: boolean): Promise<Capabilities>;
  prepare(request: Request): Promise<Upload>; inspectUpload(id: string, request?: Request): Promise<Upload>;
  transfer(upload: Upload, bytes: Buffer): Promise<void>; complete(id: string, request?: Request): Promise<Upload>;
  submit(request: Request, fileId?: string): Promise<string>;
  status(id: string, kind?: string, expected?: SourceIdentity): Promise<Snapshot>; download(output: Output): Promise<Buffer>;
}
