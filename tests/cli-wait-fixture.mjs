// Process-local synthetic adapter: no credential lookup or network dispatch.
import {Operations} from '../dist/operations.js';
Operations.prototype.status=async operationId=>({ok:true,status:'ok',state:'waiting_external',pollable:true,operation_id:operationId,phase:'poll',remote_id:'fixture-remote',remote_state:'running',outputs:[],missing_outputs:[],outputs_unavailable:[],bundle_dir:null,error:null,warnings:[],meta:{extra:{contract:'mineru.execution.v1'}}});
