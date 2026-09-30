#!/usr/bin/env node
import { Operations, executionResult, operationErrorCode } from "./operations.js";
import {pinOutput, type PinnedDirectory} from "./bundle/filesystem.js";
import { ProviderError, Transport } from "./providers/transport.js";
import { sha256 } from "./bundle/archive.js";
import { lifecycle, normalizeState } from "./bundle/lifecycle.js";
import { fetchArchive, retainArchive } from "./bundle/download.js";
import { VERSION } from "./version.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios, { AxiosError } from "axios";
import { readFileSync, createWriteStream, readdirSync, statSync, mkdirSync, existsSync, unlinkSync, rmSync, realpathSync, copyFileSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";

// Configuration schema for Smithery
export const configSchema = z.object({
  mineruStateDir: z.string().optional(),
  mineruV1BaseUrl: z.string().optional(),
  mineruV1Validated: z.boolean().optional(),
  mineruApiKey: z.string().describe("MinerU API key from mineru.net"),
  mineruBaseUrl: z
    .string()
    .optional()
    .default("https://mineru.net/api/v4")
    .describe("API base URL"),
  mineruDefaultModel: z
    .enum(["pipeline", "vlm"])
    .optional()
    .default("pipeline")
    .describe("Default model: pipeline or vlm"),
});

type Config = z.infer<typeof configSchema>;

// Error codes with actionable messages
const ERROR_MESSAGES: Record<string, string> = {
  A0202: "Token error. Check your API key.",
  A0211: "Token expired. Get a new API key.",
  "-60002": "Invalid file format. Use: pdf, doc, docx, ppt, pptx, png, jpg, jpeg",
  "-60005": "File too large. Max 200MB.",
  "-60006": "Too many pages. Max 200 per file. Re-submit with pages (e.g. 1-200, 201-400) — ranges are accepted on files longer than 200 pages.",
  "-60008": "URL timeout. Check the URL is accessible.",
  "-60009": "Queue full. Try again later.",
  "-60012": "Task not found. Check task_id is valid.",
  "-60013": "Access denied. You can only access your own tasks.",
};

// Response types
interface TaskResponse {
  task_id: string;
}

interface TaskStatus {
  task_id: string;
  data_id?: string;
  state: string;
  full_zip_url?: string;
  err_msg?: string;
  extract_progress?: {
    extracted_pages: number;
    total_pages: number;
    start_time: string;
  };
}

interface BatchResponse {
  batch_id: string;
}

interface BatchFileUploadResponse {
  batch_id: string;
  file_urls: string[];
}

interface BatchStatus {
  batch_id: string;
  extract_result: Array<{
    file_name: string;
    state: string;
    full_zip_url?: string;
    err_msg?: string;
    data_id?: string;
    extract_progress?: {
      extracted_pages: number;
      total_pages: number;
      start_time: string;
    };
  }>;
}

// Long-document slicing with a locally bounded slice size.
const MAX_SLICE_PAGES = 200;

function planSlices(totalPages: number, sliceSize: number): Array<[number, number]> {
  if (!Number.isInteger(totalPages) || totalPages < 1) throw new Error("total_pages must be a positive integer");
  const size = Math.min(Math.max(1, Math.floor(sliceSize)), MAX_SLICE_PAGES);
  const slices: Array<[number, number]> = [];
  for (let start = 1; start <= totalPages; start += size) {
    slices.push([start, Math.min(start + size - 1, totalPages)]);
  }
  return slices;
}

// data_id must be [A-Za-z0-9_.-], ≤128 chars. Encode the slice so merge can order it.
function sliceDataId(name: string, start: number, end: number): string {
  const stem = name.replace(/[^a-zA-Z0-9_\-\.]/g, "_").slice(0, 100) || "document";
  return `${stem}__p${String(start).padStart(5, "0")}-${String(end).padStart(5, "0")}`;
}

function parseSliceId(dataId: string | undefined): { name: string; start: number; end: number } | null {
  const m = dataId?.match(/^(.+)__p(\d{5})-(\d{5})$/);
  return m ? { name: m[1], start: Number(m[2]), end: Number(m[3]) } : null;
}

// Depth-limited, symlink-safe finders (zip-slip protection)
function findEntry(dir: string, targetName: string, baseDir: string, wantDir: boolean, depth = 0): string | null {
  if (depth > 5) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = join(dir, entry.name);
    // MinerU prefixes files with the task uuid ("<uuid>_content_list_v2.json"), so match on suffix
    const matches = (entry.name === targetName || entry.name.endsWith(`_${targetName}`)) && (wantDir ? entry.isDirectory() : entry.isFile());
    if (matches && realpathSync(fullPath).startsWith(realpathSync(baseDir))) return fullPath;
    if (entry.isDirectory()) {
      const found = findEntry(fullPath, targetName, baseDir, wantDir, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// Format helpers
function formatConciseStatus(status: TaskStatus): string {
  const parts = [status.state, status.task_id];
  if (status.state === "done" && status.full_zip_url) {
    parts.push(status.full_zip_url);
  } else if (status.state === "running" && status.extract_progress) {
    const p = status.extract_progress;
    parts.push(`${p.extracted_pages}/${p.total_pages} pages`);
  } else if (status.state === "failed" && status.err_msg) {
    parts.push(status.err_msg);
  }
  return parts.join(" | ");
}

function formatDetailedStatus(status: TaskStatus): string {
  return JSON.stringify(status, null, 2);
}

function formatConciseBatch(batch: BatchStatus, limit: number, offset: number): string {
  const results = batch.extract_result.slice(offset, offset + limit);
  const total = batch.extract_result.length;
  const done = batch.extract_result.filter((r) => r.state === "done").length;

  const lines = [`Batch ${batch.batch_id}: ${done}/${total} done`];
  for (const r of results) {
    let line = `- ${r.file_name}: ${r.state}`;
    if (r.state === "done" && r.full_zip_url) {
      line += ` ${r.full_zip_url}`;
    } else if (r.state === "running" && r.extract_progress) {
      line += ` (${r.extract_progress.extracted_pages}/${r.extract_progress.total_pages})`;
    }
    lines.push(line);
  }

  if (offset + limit < total) {
    lines.push(`[+${total - offset - limit} more, use offset=${offset + limit}]`);
  }

  return lines.join("\n");
}

// Create server function for Smithery
export default function createServer({ config }: { config: Config }) {
  const apiKey = config.mineruApiKey;
  const baseUrl = config.mineruBaseUrl || "https://mineru.net/api/v4";
  const defaultModel = config.mineruDefaultModel || "pipeline";
  const legacyGuard=new Transport(baseUrl,apiKey);
  const guardTransfer=(url:string,headers?:Record<string,unknown>)=>{legacyGuard.rejectCredentialEcho(url);if(headers)legacyGuard.rejectResponseEcho(headers);};
  const legacyArchive=(url:string)=>fetchArchive(url,guardTransfer);
  async function legacyUpload(url:string,bytes:Buffer<ArrayBuffer>,timeout:number){
    guardTransfer(url);
    const response=await fetch(url,{method:'PUT',body:bytes,signal:AbortSignal.timeout(timeout),redirect:'manual'});
    if([301,302,303,307,308].includes(response.status)){await response.body?.cancel();legacyGuard.rejectCredentialEcho(response.headers.get('location')??'',true);throw new ProviderError('mutation_redirect',true);}
    if(!response.ok){const body=await response.text();legacyGuard.rejectCredentialEcho(body,true);return{ok:false,status:response.status,body};}
    await response.body?.cancel();return{ok:true,status:response.status,body:''};
  }


  // API client with injected config
  async function mineruRequest<T>(
    endpoint: string,
    method: "GET" | "POST" = "GET",
    data?: unknown
  ): Promise<T> {
    if (!apiKey) {
      throw new Error("MINERU_API_KEY not set. Add it to your environment.");
    }

    try {
      legacyGuard.rejectCredentialEcho(`${baseUrl}${endpoint}`,method!=='GET');
      const response = await axios({
        method,
        url: `${baseUrl}${endpoint}`,
        maxRedirects:0,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        data,
      });

      legacyGuard.rejectResponseEcho(response.data,method!=='GET');
      legacyGuard.rejectResponseEcho(response.headers,method!=='GET');
      const result = response.data;
      if (result.code !== 0) {
        const code = String(result.code);
        const msg = ERROR_MESSAGES[code] || result.msg || "Unknown error";
        throw new Error(`MinerU error ${code}: ${msg}`);
      }

      return result.data as T;
    } catch (error) {
      if (error instanceof AxiosError) {
        legacyGuard.rejectResponseEcho(error.response?.data,method!=='GET');
        legacyGuard.rejectResponseEcho(error.response?.headers,method!=='GET');
        legacyGuard.rejectCredentialEcho(error.message,method!=='GET');
        const code = error.response?.data?.code;
        if (code) {
          const msg = ERROR_MESSAGES[String(code)] || error.response?.data?.msg;
          throw new Error(`MinerU error ${code}: ${msg}`);
        }
        throw new Error(`HTTP ${error.response?.status}: ${error.message}`);
      }
      throw error;
    }
  }

  // Create MCP server
  const server = new McpServer({
    name: "mineru",
    version: VERSION,
  });

  const operations = () => new Operations({stateDir:config.mineruStateDir??process.env.MINERU_STATE_DIR,apiKey, v4Endpoint:baseUrl,v1Endpoint:config.mineruV1BaseUrl??process.env.MINERU_V1_BASE_URL,allowV1Execution:config.mineruV1Validated??false});
  const execution = async (operation:string,call:()=>Promise<any>) => {
    try { const structuredContent=executionResult(await call(),operation);return{...(structuredContent.status==='error'?{isError:true}:{}),structuredContent,content:[{type:'text' as const,text:JSON.stringify(structuredContent,null,2)}]}; }
    catch(error) {const code=operationErrorCode(error);const structuredContent=executionResult({status:'error',state:'failed',error:{code,message:code}},operation);return{isError:true,structuredContent,content:[{type:'text' as const,text:code}]};}
  };
  // Preserve the eight legacy text surfaces and flattened lifecycle aliases,
  // while CLI JSON and MCP share one additive execution envelope.
  const legacyExecution = async (operation:string,call:()=>Promise<any>) => {
    try { const result=await call();legacyGuard.rejectResponseEcho(result);const value=result.structuredContent??{state:'completed'};
      const status=['failed','failed_terminal'].includes(value.state)?'error':['partial','unknown','needs_input','reconciliation_required'].includes(value.state)?'partial':'ok';
      return{...result,structuredContent:executionResult({...value,status},operation)};
    }catch(error){let message=error instanceof Error?error.message:String(error),code=error instanceof ProviderError?error.code:'legacy_operation_failed';try{legacyGuard.rejectCredentialEcho(message);}catch{code='credential_echo_forbidden';message=code;}const structuredContent=executionResult({status:'error',state:'failed',error:{code,message,...(error instanceof ProviderError&&error.uncertain?{suggestion:'Inspect the provider outcome before retrying a possibly accepted request.'}:{})}},operation);return{isError:true,structuredContent,content:[{type:'text' as const,text:message}]};}
  };
  server.tool('mineru_capabilities','Read locally known adapter capabilities; refresh explicitly performs discovery.',{api:z.enum(['v4','v1']).optional().default('v4'),refresh:z.boolean().optional().default(false)},p=>execution('capabilities',()=>operations().capabilities(p.api,p.refresh)));
  server.tool('mineru_submit','Submit once with a durable local journal. A lost remote ID requires reconciliation; it is never automatically resubmitted.',{file:z.string().optional(),url:z.string().optional(),api:z.enum(['v4','v1']).optional().default('v4'),direct_url:z.boolean().optional().default(false),model:z.string().optional(),tier:z.string().optional(),pages:z.string().optional(),output_dir:z.string()},p=>execution('submit',()=>operations().submit(p)));
  server.tool('mineru_operation_status','Read a durable operation snapshot; refresh performs one safe remote status request.',{operation_id:z.string(),refresh:z.boolean().optional().default(false)},p=>execution('operation_status',()=>operations().status(p.operation_id,p.refresh)));
  server.tool('mineru_resume','Continue safe recorded checkpoints without starting a second parse.',{operation_id:z.string()},p=>execution('resume',()=>operations().resume(p.operation_id)));
  server.tool('mineru_cancel','Stop local processing. Remote cancellation is unsupported unless verified.',{operation_id:z.string(),remote:z.boolean().optional().default(false)},p=>execution('cancel',()=>operations().cancel(p.operation_id,p.remote)));
  server.tool('mineru_bundle','Validate a completed local operation bundle without downloading or parsing.',{operation_id:z.string()},p=>execution('bundle',()=>operations().bundle(p.operation_id)));

  // Tool 1: mineru_parse
  server.tool(
    "mineru_parse",
    "Parse a document URL. Returns task_id to check status.",
    {
      url: z.string().describe("Document URL (PDF, DOC, PPT, images)"),
      model: z
        .enum(["pipeline", "vlm"])
        .optional()
        .describe("Model: pipeline or vlm"),
      pages: z.string().optional().describe("Page range: 1-10,15 or 2--2"),
      ocr: z.boolean().optional().describe("Enable OCR (pipeline only)"),
      formula: z.boolean().optional().describe("Formula recognition"),
      table: z.boolean().optional().describe("Table recognition"),
      language: z.string().optional().describe("Language code: ch, en, etc"),
      formats: z
        .array(z.enum(["docx", "html", "latex"]))
        .optional()
        .describe("Extra export formats"),
    },
    async (params) => legacyExecution('parse', async () => {
      const requestData: Record<string, unknown> = {
        url: params.url,
        model_version: params.model || defaultModel,
      };

      if (params.pages) requestData.page_ranges = params.pages;
      if (params.ocr !== undefined) requestData.is_ocr = params.ocr;
      if (params.formula !== undefined) requestData.enable_formula = params.formula;
      if (params.table !== undefined) requestData.enable_table = params.table;
      if (params.language) requestData.language = params.language;
      if (params.formats?.length) requestData.extra_formats = params.formats;

      const result = await mineruRequest<TaskResponse>("/extract/task", "POST", requestData);

      return {
        structuredContent: {operation:{kind:'task',operation_id:result.task_id},state:'submitted',pollable:false},
        content: [
          {
            type: "text",
            text: `Task created: ${result.task_id}\nUse mineru_status to check progress.`,
          },
        ],
      };
    })
  );

  // Tool 2: mineru_status
  server.tool(
    "mineru_status",
    "Check task progress. Returns download URL when done.",
    {
      task_id: z.string().describe("Task ID from mineru_parse"),
      format: z
        .enum(["concise", "detailed"])
        .optional()
        .default("concise")
        .describe("Output format"),
    },
    async (params) => legacyExecution('status', async () => {
      const status = await mineruRequest<TaskStatus>(`/extract/task/${params.task_id}`);

      const text =
        params.format === "detailed"
          ? formatDetailedStatus(status)
          : formatConciseStatus(status);

      return {
        structuredContent: lifecycle(params.task_id, [status], 'task'),
        content: [{ type: "text", text }],
      };
    })
  );

  // Tool 3: mineru_batch
  server.tool(
    "mineru_batch",
    "Parse multiple public URLs in one batch. The local guard allows up to 200 URLs. Returns batch_id for status checks.",
    {
      urls: z.union([z.array(z.string()), z.string()]).describe("Array of document URLs, or a single URL string"),
      model: z
        .enum(["pipeline", "vlm"])
        .optional()
        .describe("Model: pipeline or vlm"),
      ocr: z.boolean().optional().describe("Enable OCR (pipeline only)"),
      formula: z.boolean().optional().describe("Formula recognition"),
      table: z.boolean().optional().describe("Table recognition"),
      language: z.string().optional().describe("Language code: ch, en, etc"),
      formats: z
        .array(z.enum(["docx", "html", "latex"]))
        .optional()
        .describe("Extra export formats"),
    },
    async (params) => legacyExecution('batch', async () => {
      // Normalize urls: accept string (JSON array or single URL) or array
      let urls: string[];
      if (typeof params.urls === "string") {
        try {
          const parsed = JSON.parse(params.urls);
          urls = Array.isArray(parsed) ? parsed : [params.urls];
        } catch {
          urls = [params.urls];
        }
      } else {
        urls = params.urls;
      }

      if (urls.length > 200) {
        throw new Error("Max 200 URLs per batch. Split into smaller batches.");
      }

      const requestData: Record<string, unknown> = {
        files: urls.map((url) => ({ url })),
        model_version: params.model || defaultModel,
      };

      if (params.ocr !== undefined) requestData.is_ocr = params.ocr;
      if (params.formula !== undefined) requestData.enable_formula = params.formula;
      if (params.table !== undefined) requestData.enable_table = params.table;
      if (params.language) requestData.language = params.language;
      if (params.formats?.length) requestData.extra_formats = params.formats;

      const result = await mineruRequest<BatchResponse>("/extract/task/batch", "POST", requestData);

      return {
        structuredContent: {operation:{kind:'batch',operation_id:result.batch_id},state:'submitted',pollable:false},
        content: [
          {
            type: "text",
            text: `Batch created: ${result.batch_id}\n${urls.length} files queued.\nUse mineru_batch_status to check progress.`,
          },
        ],
      };
    })
  );

  // Tool 4: mineru_batch_status
  server.tool(
    "mineru_batch_status",
    "Get batch results. Supports pagination for large batches.",
    {
      batch_id: z.string().describe("Batch ID from mineru_batch"),
      limit: z.number().optional().default(10).describe("Max results to return"),
      offset: z.number().optional().default(0).describe("Skip first N results"),
      format: z
        .enum(["concise", "detailed"])
        .optional()
        .default("concise")
        .describe("Output format"),
    },
    async (params) => legacyExecution('batch_status', async () => {
      const batch = await mineruRequest<BatchStatus>(
        `/extract-results/batch/${params.batch_id}`
      );

      const text =
        params.format === "detailed"
          ? JSON.stringify(batch, null, 2)
          : formatConciseBatch(batch, params.limit ?? 10, params.offset ?? 0);

      return {
        structuredContent: lifecycle(params.batch_id, batch.extract_result),
        content: [{ type: "text", text }],
      };
    })
  );

  // Tool 5: mineru_upload_batch
  server.tool(
    "mineru_upload_batch",
    "Upload local files for batch parsing. Returns batch_id for status checks.",
    {
      directory: z.string().optional().describe("Directory path containing PDF/DOC/PPT files"),
      files: z.union([z.array(z.string()), z.string()]).optional().describe("Array of absolute file paths, or a single path string"),
      model: z
        .enum(["pipeline", "vlm"])
        .optional()
        .describe("Model: pipeline or vlm"),
      formula: z.boolean().optional().describe("Formula recognition"),
      table: z.boolean().optional().describe("Table recognition"),
      language: z.string().optional().describe("Language code: ch, en, etc"),
      formats: z
        .array(z.enum(["docx", "html", "latex"]))
        .optional()
        .describe("Extra export formats"),
    },
    async (params) => legacyExecution('upload_batch', async () => {
      const supportedExts = new Set([".pdf", ".doc", ".docx", ".ppt", ".pptx", ".png", ".jpg", ".jpeg"]);

      // Collect files — normalize string input (JSON array or single path)
      let filePaths: string[] = [];
      if (params.files) {
        if (typeof params.files === "string") {
          try {
            const parsed = JSON.parse(params.files);
            filePaths = Array.isArray(parsed) ? parsed : [params.files];
          } catch {
            filePaths = [params.files];
          }
        } else {
          filePaths = params.files;
        }
      } else if (params.directory) {
        const dir = params.directory;
        if (!existsSync(dir)) {
          throw new Error(`Directory not found: ${dir}`);
        }
        const entries = readdirSync(dir);
        filePaths = entries
          .filter((f) => supportedExts.has(extname(f).toLowerCase()))
          .map((f) => join(dir, f));
      } else {
        throw new Error("Provide either 'directory' or 'files' parameter.");
      }

      if (filePaths.length === 0) {
        throw new Error("No supported files found.");
      }
      if (filePaths.length > 200) {
        throw new Error(`Found ${filePaths.length} files. Max 200 per batch. Filter or split.`);
      }

      // Validate files exist and build request with collision-safe data_ids
      const fileEntries: Array<{ name: string; data_id: string }> = [];
      const fileSizes: number[] = [];
      const usedDataIds = new Set<string>();
      for (const fp of filePaths) {
        if (!existsSync(fp)) {
          throw new Error(`File not found: ${fp}`);
        }
        const stats = statSync(fp);
        fileSizes.push(stats.size);
        if (stats.size > 200 * 1024 * 1024) {
          throw new Error(`File too large (${(stats.size / 1024 / 1024).toFixed(0)}MB): ${basename(fp)}. Max 200MB.`);
        }
        const name = basename(fp);
        let stem = name.replace(extname(name), "").replace(/[^a-zA-Z0-9_\-\.]/g, "_").slice(0, 128);
        // Handle data_id collisions
        let candidate = stem;
        let counter = 1;
        while (usedDataIds.has(candidate)) {
          candidate = `${stem}_${counter++}`;
        }
        usedDataIds.add(candidate);
        fileEntries.push({ name, data_id: candidate });
      }

      // Request upload URLs
      const requestData: Record<string, unknown> = {
        files: fileEntries,
        model_version: params.model || defaultModel,
      };
      if (params.formula !== undefined) requestData.enable_formula = params.formula;
      if (params.table !== undefined) requestData.enable_table = params.table;
      if (params.language) requestData.language = params.language;
      if (params.formats?.length) requestData.extra_formats = params.formats;

      const result = await mineruRequest<BatchFileUploadResponse>("/file-urls/batch", "POST", requestData);

      if (result.file_urls.length !== filePaths.length) {
        throw new Error(`Expected ${filePaths.length} upload URLs, got ${result.file_urls.length}`);
      }

      // Upload each file to presigned OSS URLs using native fetch
      // Presigned URLs are signed WITHOUT Content-Type — axios force-adds it, so use fetch
      // Size-proportional timeout: 60s base + 2s per MB (fail fast for small files, generous for large)
      const uploadResults: string[] = [];
      for (let i = 0; i < filePaths.length; i++) {
        const fp = filePaths[i];
        const uploadUrl = result.file_urls[i];
        const fileName = basename(fp);
        const sizeMB = (fileSizes[i] / 1024 / 1024).toFixed(1);
        const timeoutMs = Math.max(60_000, 60_000 + Math.ceil(fileSizes[i] / (1024 * 1024)) * 2_000);
        try {
          const fileData = readFileSync(fp);
          const resp = await legacyUpload(uploadUrl,fileData,timeoutMs);
          if (!resp.ok) {
            const body = resp.body;
            uploadResults.push(`FAIL: ${fileName} (${sizeMB}MB) - HTTP ${resp.status}: ${body.slice(0, 200)}`);
          } else {
            uploadResults.push(`OK: ${fileName} (${sizeMB}MB)`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
          uploadResults.push(`FAIL: ${fileName} (${sizeMB}MB) - ${isTimeout ? `TIMEOUT after ${Math.round(timeoutMs / 1000)}s` : msg}`);
        }
      }

      const successCount = uploadResults.filter((r) => r.startsWith("OK")).length;
      const failCount = uploadResults.filter((r) => r.startsWith("FAIL")).length;
      const timeoutCount = uploadResults.filter((r) => r.includes("TIMEOUT")).length;

      let text = `Batch ${result.batch_id}: ${successCount} uploaded, ${failCount} failed.\n`;
      if (successCount > 0) {
        text += `Parsing starts automatically. Use mineru_batch_status to track.\n`;
      }
      if (failCount > 0) {
        text += `\nFailed uploads:\n${uploadResults.filter((r) => r.startsWith("FAIL")).join("\n")}`;
      }
      if (timeoutCount > 0) {
        text += `\n\nTIP: Upload timed out. Try mineru_batch with public URLs instead (arXiv, SSRN, publisher sites) — it's faster and more reliable.`;
      }

      return {
        structuredContent: {operation:{kind:'batch',operation_id:result.batch_id},state:failCount?(successCount?'partial':'failed'):'submitted',pollable:false,uploaded:successCount,failed:failCount},
        content: [{ type: "text", text }],
      };
    })
  );

  // Tool 6: mineru_download_results
  server.tool(
    "mineru_download_results",
    "Download batch results and extract named paper folders. Each folder contains {name}.md, {name}_content.json (structured TOC), and images/. Output includes parsed title — verify it matches the expected paper.",
    {
      batch_id: z.string().describe("Batch ID from mineru_upload_batch or mineru_batch"),
      output_dir: z.string().describe("Directory to save markdown files"),
      overwrite: z.boolean().optional().default(false).describe("Overwrite existing files"),
    },
    async (params) => legacyExecution('download_results', async () => {
      const batch = await mineruRequest<BatchStatus>(`/extract-results/batch/${params.batch_id}`);
      const state = lifecycle(params.batch_id, batch.extract_result);
      const downloaded: Array<{name:string; directory:string; skipped:boolean}> = [];
      const errors: Array<{name:string; code:string; message:string}> = [];
      const usedNames = new Set<string>();
      for (const r of batch.extract_result) {
        if (r.state !== 'done' || !r.full_zip_url) continue;
        const raw = r.data_id || r.file_name || 'document';
        const safe = basename(raw).replace(/[^a-zA-Z0-9_.-]/g, '_');
        let stem = (safe.slice(0, safe.length - extname(safe).length) || 'document').slice(0, 128);
        if (!/^[A-Za-z0-9]/.test(stem)) stem = `document_${stem}`.slice(0,128);
        if(usedNames.has(stem.toLowerCase())) { errors.push({name:stem,code:'name_collision',message:'Ambiguous output name in batch; no overwrite performed.'});continue; }
        usedNames.add(stem.toLowerCase());
        try {
          const retained = await retainArchive(await legacyArchive(r.full_zip_url),params.output_dir,stem,params.overwrite);
          downloaded.push({name:stem,directory:retained.directory,skipped:retained.skipped});
        } catch(error) { errors.push({name:stem,code:'download_failed',message:error instanceof Error?error.message:String(error)}); }
      }
      const missing = batch.extract_result.filter(r=>r.state==='done'&&!r.full_zip_url);
      for (const r of missing) errors.push({name:r.data_id||r.file_name,code:'not_returned',message:'Provider marked result done without an archive URL.'});
      const result = {...state, state: errors.length ? (downloaded.length ? 'partial' : 'failed') : state.state, downloaded, errors, source_binding:'unknown', importable_bundle:false};
      const text = `Batch ${params.batch_id}: Done: ${downloaded.filter(d=>!d.skipped).length} | Skipped: ${downloaded.filter(d=>d.skipped).length} | Still processing: ${state.counts.pending} | Errors: ${errors.length}\n` + downloaded.map(d=>`${d.skipped?'SKIP':'OK'}: ${d.name}/ (complete archive retained)`).join('\n') + errors.map(e=>`\n${e.code}: ${e.name} - ${e.message}`).join('');
      return {structuredContent:result, content:[{type:'text',text}]};
    })
  );

  // Tool 7: mineru_parse_long — bounded page-range slices in one batch
  server.tool(
    "mineru_parse_long",
    "Submit a document as one batch of page-range slices, with a local limit of 200 pages per requested slice. Give total_pages (from `mdls -name kMDItemNumberOfPages`, `pdfinfo`, or the viewer) — it is auto-detected only for local files on macOS. Returns a batch_id; poll with mineru_batch_status, then stitch with mineru_merge_slices.",
    {
      url: z.string().optional().describe("Public document URL (preferred)"),
      file: z.string().optional().describe("Absolute local file path (uploaded once per slice)"),
      total_pages: z.number().int().positive().optional().describe("Total page count of the document"),
      slice_size: z.number().int().positive().max(MAX_SLICE_PAGES).optional().default(MAX_SLICE_PAGES).describe("Pages per slice (≤200)"),
      name: z.string().optional().describe("Output name for the merged result (default: from URL/file name)"),
      model: z.enum(["pipeline", "vlm"]).optional().describe("Model: pipeline or vlm"),
      ocr: z.boolean().optional().describe("Enable OCR (pipeline only)"),
      formula: z.boolean().optional().describe("Formula recognition"),
      table: z.boolean().optional().describe("Table recognition"),
      language: z.string().optional().describe("Language code: ch, en, etc"),
    },
    async (params) => legacyExecution('parse_long', async () => {
      if (!params.url === !params.file) throw new Error("Provide exactly one of 'url' or 'file'.");

      let totalPages = params.total_pages;
      if (!totalPages && params.file && process.platform === "darwin") {
        try {
          const out = execFileSync("mdls", ["-raw", "-name", "kMDItemNumberOfPages", params.file], { timeout: 10_000 }).toString().trim();
          if (/^\d+$/.test(out)) totalPages = Number(out);
        } catch { /* fall through to the error below */ }
      }
      if (!totalPages) throw new Error("total_pages is required (could not auto-detect). Get it with `mdls -name kMDItemNumberOfPages <file>` or `pdfinfo`.");

      const source = params.url || params.file!;
      const rawName = params.name || basename(new URL(params.url || `file://${params.file}`).pathname);
      const name = rawName.replace(extname(rawName), "") || "document";
      const slices = planSlices(totalPages, params.slice_size);
      if (slices.length > 200) throw new Error(`${slices.length} slices exceeds the 200-file batch limit; raise slice_size.`);

      const common: Record<string, unknown> = { model_version: params.model || defaultModel };
      if (params.formula !== undefined) common.enable_formula = params.formula;
      if (params.table !== undefined) common.enable_table = params.table;
      if (params.language) common.language = params.language;

      const entries = slices.map(([a, b]) => {
        const e: Record<string, unknown> = { data_id: sliceDataId(name, a, b), page_ranges: `${a}-${b}` };
        if (params.ocr !== undefined) e.is_ocr = params.ocr;
        return e;
      });

      let batchId: string;
      const uploadNotes: string[] = [];
      if (params.url) {
        const result = await mineruRequest<BatchResponse>("/extract/task/batch", "POST", {
          ...common,
          files: entries.map((e) => ({ ...e, url: params.url })),
        });
        batchId = result.batch_id;
      } else {
        if (!existsSync(params.file!)) throw new Error(`File not found: ${params.file}`);
        const size = statSync(params.file!).size;
        if (size > 200 * 1024 * 1024) throw new Error(`File too large (${(size / 1024 / 1024).toFixed(0)}MB). Max 200MB.`);
        const result = await mineruRequest<BatchFileUploadResponse>("/file-urls/batch", "POST", {
          ...common,
          files: entries.map((e) => ({ ...e, name: basename(params.file!) })),
        });
        if (result.file_urls.length !== entries.length) throw new Error(`Expected ${entries.length} upload URLs, got ${result.file_urls.length}`);
        batchId = result.batch_id;
        const data = readFileSync(params.file!);
        const timeoutMs = 60_000 + Math.ceil(size / (1024 * 1024)) * 2_000;
        for (let i = 0; i < result.file_urls.length; i++) {
          try {
            const resp = await legacyUpload(result.file_urls[i],data,timeoutMs);
            if (!resp.ok) uploadNotes.push(`FAIL slice ${slices[i][0]}-${slices[i][1]}: HTTP ${resp.status}`);
          } catch (err) {
            uploadNotes.push(`FAIL slice ${slices[i][0]}-${slices[i][1]}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      let text = `Batch ${batchId}: "${name}" (${totalPages} pages) queued as ${slices.length} slice(s) of ≤${params.slice_size} pages from ${source}.\n`;
      text += slices.map(([a, b]) => `  ${sliceDataId(name, a, b)}  pages ${a}-${b}`).join("\n");
      text += `\nPoll with mineru_batch_status, then mineru_merge_slices(batch_id, output_dir).`;
      if (uploadNotes.length) text += `\n\nUpload problems:\n${uploadNotes.join("\n")}`;
      return { structuredContent:{operation:{kind:'batch',operation_id:batchId},state:uploadNotes.length?'partial':'submitted',pollable:false,requested_slices:slices.map(([start,end])=>({start,end})),warnings:uploadNotes},content: [{ type: "text", text }] };
    })
  );

  // Tool 8: mineru_merge_slices — stitch a sliced batch back into one document
  server.tool(
    "mineru_merge_slices",
    "Stitch the slices of a mineru_parse_long batch into one {name}/{name}.md (+ {name}_content.json with per-slice references and unknown page provenance). Slices are ordered by their page range; each is marked with an HTML comment. Waits for nothing — if any slice is still processing, it reports and you re-run later.",
    {
      batch_id: z.string().describe("Batch ID from mineru_parse_long"),
      output_dir: z.string().describe("Directory to write the merged document folder into"),
      overwrite: z.boolean().optional().default(false).describe("Overwrite an existing merged folder"),
    },
    async (params) => legacyExecution('merge_slices', async () => {
      const batch = await mineruRequest<BatchStatus>(`/extract-results/batch/${params.batch_id}`);
      const slices = batch.extract_result
        .map((r) => ({ r, s: parseSliceId(r.data_id) }))
        .filter((x): x is { r: BatchStatus["extract_result"][number]; s: NonNullable<ReturnType<typeof parseSliceId>> } => x.s !== null)
        .sort((a, b) => a.s.start - b.s.start);
      if (slices.length === 0) throw new Error("No slice entries in this batch (data_id must look like name__p00001-00200). Was it created by mineru_parse_long?");

      const state = lifecycle(params.batch_id, batch.extract_result);
      const pending = slices.filter(x=>['pending','running'].includes(normalizeState(x.r.state)));
      const failed = slices.filter(x=>['failed','cancelled','canceled'].includes(x.r.state));
      if (pending.length) {
        const text = `Batch ${params.batch_id}: ${state.counts.succeeded}/${slices.length} slices done.\nStill processing: ${pending.map(x=>`${x.s.start}-${x.s.end}`).join(', ')}\nFailed: ${failed.map(x=>`${x.s.start}-${x.s.end} (${x.r.err_msg||'no message'})`).join('; ')}`;
        return {structuredContent:{...state,coverage:'unknown',page_provenance:'unknown'},content:[{type:'text',text}]};
      }
      const name = slices[0].s.name;
      if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name) || slices.some(x=>x.s.name!==name || x.s.start<1 || x.s.end<x.s.start)) throw new Error('Invalid or mixed slice identities');
      if(slices.some((x,i)=>i>0&&x.s.start<=slices[i-1].s.end)) throw new Error('Overlapping slice ranges');
      const root=pinOutput(params.output_dir);let output:PinnedDirectory|undefined,slicesRoot:PinnedDirectory|undefined;
      try {
      const outDir=join(root.path,name);
      if(root.exists(name)&&!params.overwrite)throw new Error(`${outDir} exists. Pass overwrite=true to retain a new successor.`);
      // Keep the original directory identities across all download/inspection
      // awaits. Successors retain every earlier receipt and image link.
      output=root.openDirectory(name,true);slicesRoot=output.openDirectory('slices',true);
      const mdParts:string[]=[], sliceRecords:unknown[]=[], missing:unknown[]=[], notes:string[]=[];
      let gapStart=1;
      for(const {r,s} of slices) {
        if(s.start>gapStart) missing.push({start:gapStart,end:s.start-1,reason:'slice_not_returned'});
        gapStart=s.end+1;
        const range={start:s.start,end:s.end};
        if(r.state!=='done'||!r.full_zip_url) {missing.push({...range,reason:r.state});continue;}
        const tag=`p${String(s.start).padStart(5,'0')}-${String(s.end).padStart(5,'0')}`;
        try {
          const archive=await legacyArchive(r.full_zip_url);
          const sliceDir=`${tag}-${sha256(archive)}`;
          root.assertUnchanged();output.assertUnchanged();slicesRoot.assertUnchanged();
          const retained=await retainArchive(archive,slicesRoot.path,sliceDir,false,slicesRoot);
          const markdown=retained.inventory.entries.filter(e=>/(^|\/)(?:[^/]*_)?full\.md$/.test(e.member.path));
          const structured=retained.inventory.entries.filter(e=>e.member.role==='structured_json').map(e=>({member_id:e.member.member_id,path:e.member.path}));
          sliceRecords.push({requested_range:range,archive_sha256:retained.inventory.sha256,client_data_id:r.data_id,archive_directory:`slices/${sliceDir}`,page_provenance:'unknown',original_page_offset:null,structured_members:structured});
          if(markdown.length!==1) {missing.push({...range,reason:markdown.length?'ambiguous_markdown':'missing_markdown'});continue;}
          const md=new TextDecoder('utf-8',{fatal:true}).decode(markdown[0].bytes);
          mdParts.push(`<!-- mineru requested slice: ${s.start}-${s.end}; page provenance unknown -->\n\n${md.replace(/\]\(images\//g, `](slices/${sliceDir}/images/`)}\n`);
        } catch(error) {missing.push({...range,reason:'download_or_content_failed'});notes.push(`${tag}: ${error instanceof Error?error.message:String(error)}`);}
      }
      const suffix=params.overwrite?`-${Date.now()}-${randomBytes(3).toString('hex')}`:'';
      const mdPath=join(outDir,`${name}${suffix}.md`);
      output.writeFile(`${name}${suffix}.md`,mdParts.join('\n'));
      const receipt={schema:'mineru.slice-merge.v1',batch_id:params.batch_id,coverage:missing.length?'partial':'unknown',page_provenance:'unknown',missing_or_unknown_ranges:missing,slices:sliceRecords,notes};
      output.writeFile(`${name}${suffix}_content.json`,JSON.stringify(receipt,null,2));
      output.sync();root.sync();root.assertUnchanged();output.assertUnchanged();
      const text=`Merged ${mdParts.length}/${slices.length} slices -> ${mdPath}\nCoverage: ${receipt.coverage}; page provenance unknown. Original structured JSON and every archive member retained by slice.\n${notes.join('\n')}`;
      return {structuredContent:{...state,state:missing.length?'partial':state.state,...receipt,output:mdPath},content:[{type:'text',text}]};
      } finally {slicesRoot?.close();output?.close();root.close();}
    })
  );

  return server.server;
}

// Sandbox server for Smithery scanning (no real credentials needed)
export function createSandboxServer() {
  return createServer({
    config: {
      mineruApiKey: "sandbox-key",
      mineruBaseUrl: "https://mineru.net/api/v4",
      mineruDefaultModel: "pipeline",
    },
  });
}

// STDIO mode (npx, local dev, Claude Code)
async function main() {
  const config: Config = {
    mineruApiKey: process.env.MINERU_API_KEY || "",
    mineruBaseUrl: process.env.MINERU_BASE_URL || "https://mineru.net/api/v4",
    mineruDefaultModel: (process.env.MINERU_DEFAULT_MODEL as "pipeline" | "vlm") || "pipeline",
  };

  const server = createServer({ config });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MinerU MCP server running (stdio mode)");
}

// Only run stdio when executed directly (not when imported by Smithery CLI)
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('index.js') ||
  process.argv[1].endsWith('index.ts')
);
if (isDirectRun) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
