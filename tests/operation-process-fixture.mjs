import {Operations} from '../dist/operations.js';
import {writeFileSync,appendFileSync,readFileSync,existsSync} from 'node:fs';
import {zip} from './zip-fixture.mjs';
const [root,source,output,signal,mode='lock',boundary]=process.argv.slice(2);
const record=call=>appendFileSync(signal+'.calls',call+'\n');
let operationId;
async function stopped(name,id){if(mode==='crash'&&name===boundary){writeFileSync(signal,JSON.stringify({checkpoint:name,operation_id:id}));setInterval(()=>{},1000);await new Promise(()=>{});}}
const adapter={api:'v4',endpoint:'https://service.example/api/v4',capabilities:async()=>({api:'v4',endpoint:'https://service.example/api/v4',observed_at:null,validation:'fixture-only',sources:['file_id'],formats:['zip'],tiers:null,ranges:true,remote_cancel:false,lost_id_lookup:false}),prepare:async()=>{record('prepare');if(mode==='lock'){writeFileSync(signal,'started');for(let i=0;i<1000&&!existsSync(signal+'.release');i++)await new Promise(resolve=>setTimeout(resolve,10));}await stopped('allocation_inflight',operationId);return{id:'batch',state:'pending',url:'mock'};},transfer:async()=>{record('transfer');},status:async()=>{record('status');return{id:'batch',state:'succeeded',outputs:[{id:'archive',format:'zip'}],missing:[]};},download:async()=>{record('download');return zip([{name:'full.md',body:'# process fixture'}]);}};
try{
 const ops=new Operations({stateDir:root,adapterFactory:()=>adapter,checkpoint:async(name,id)=>{operationId=id;await stopped(name,id);}});
 let result;
 if(mode==='recover')result=await ops.resume(JSON.parse(readFileSync(signal,'utf8')).operation_id);
 else{result=await ops.submit({file:source,output_dir:output});if(mode==='crash')result=await ops.resume(result.operation_id);}
 process.stdout.write(JSON.stringify(result));
}catch(error){process.stdout.write(JSON.stringify({error:error.code??error.message}));process.exitCode=1;}
