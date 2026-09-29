export type RemoteState = 'pending'|'running'|'succeeded'|'failed'|'cancelled'|'unknown';
export function normalizeState(state: string): RemoteState {
  if (['pending','waiting-file','waiting-file-upload','queued'].includes(state)) return 'pending';
  if (['running','converting','processing'].includes(state)) return 'running';
  if (state === 'done') return 'succeeded';
  if (state === 'failed') return 'failed';
  if (['cancelled','canceled'].includes(state)) return 'cancelled';
  return 'unknown';
}
export function lifecycle(operationId: string, files: Array<{state:string;data_id?:string;file_name?:string}>, kind='batch') {
  const mapped=files.map(file=>({state:normalizeState(file.state),raw_state:file.state,client_data_id:file.data_id??null,file_name:file.file_name??null}));
  const pending=mapped.filter(f=>f.state==='pending'||f.state==='running').length;
  const failed=mapped.filter(f=>f.state==='failed'||f.state==='cancelled').length;
  const unknown=mapped.filter(f=>f.state==='unknown').length;
  const succeeded=mapped.filter(f=>f.state==='succeeded').length;
  const state=pending?'running':unknown||mapped.length===0?'unknown':failed?(succeeded?'partial':'failed'):'succeeded';
  return {operation:{kind,operation_id:operationId},state,pollable:pending>0,counts:{total:mapped.length,pending,failed,unknown,succeeded},files:mapped,warnings:unknown?[{code:'unknown_provider_state',message:'An unsupported provider state requires reconciliation.'}]:[]};
}
