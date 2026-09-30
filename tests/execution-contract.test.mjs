import {temporaryPrefix} from './temp-dir.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import createServer from '../dist/index.js';
import {Operations} from '../dist/operations.js';
import {ProviderError} from '../dist/providers/transport.js';
async function clientFor(t,root){const server=createServer({config:{mineruApiKey:'',mineruStateDir:root}}),client=new Client({name:'execution-parity',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);t.after(()=>client.close());return client;}
const run=(root,args)=>spawnSync(process.execPath,['dist/cli.js',...args,'--json'],{encoding:'utf8',env:{PATH:process.env.PATH,MINERU_STATE_DIR:root}});
for(const uncertain of [false,true])test(`CLI/MCP exact Result parity for ${uncertain?'uncertain retained operation':'known pending operation'}`,async t=>{
 const dir=mkdtempSync(temporaryPrefix('mineru-result-parity-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const root=join(dir,'state'),source=join(dir,'source.pdf');writeFileSync(source,'%PDF-1.7\nparity\n%%EOF');
 const adapter={api:'v4',endpoint:'https://api.example/api/v4',capabilities:async()=>({api:'v4',endpoint:'https://api.example/api/v4',observed_at:null,validation:'fixture-only',sources:['file_id'],formats:['zip'],tiers:null,ranges:true,remote_cancel:false,lost_id_lookup:false}),prepare:async()=>{if(uncertain)throw new ProviderError('transport_failed',true);return{id:'batch',state:'pending',url:'https://storage.example'};},transfer:async()=>{}};
 const operation=await new Operations({stateDir:root,adapterFactory:()=>adapter}).submit({file:source,output_dir:join(dir,'out')}),client=await clientFor(t,root);
 const mcp=await client.callTool({name:'mineru_operation_status',arguments:{operation_id:operation.operation_id}}),cli=run(root,['operation-status','--operation-id',operation.operation_id]);
 assert.equal(cli.status,uncertain?1:0,cli.stderr);assert.deepEqual(JSON.parse(cli.stdout),mcp.structuredContent);assert.notEqual(mcp.isError,true);assert.equal(mcp.structuredContent.data.operation_id,operation.operation_id);assert.ok(mcp.structuredContent.data.recovery.known_evidence);
 if(uncertain){assert.equal(mcp.structuredContent.status,'partial');assert.equal(mcp.structuredContent.errors[0].code,'transport_failed');assert.equal(mcp.structuredContent.errors[0].retriable,false);assert.equal(mcp.structuredContent.data.recovery.next_actions[0].action,'inspect_provider');}
});
test('CLI/MCP exact Result parity for local capability read and application error',async t=>{
 const dir=mkdtempSync(temporaryPrefix('mineru-capability-parity-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const client=await clientFor(t,dir);
 for(const [tool,args,cmd,code] of [['mineru_capabilities',{},['capabilities'],0],['mineru_operation_status',{operation_id:'a'.repeat(64)},['operation-status','--operation-id','a'.repeat(64)],1]]){
  const result=await client.callTool({name:tool,arguments:args}),cli=run(dir,cmd);assert.equal(cli.status,code,cli.stderr);assert.deepEqual(JSON.parse(cli.stdout),result.structuredContent);assert.equal(Boolean(result.isError),Boolean(code));
 }
});
