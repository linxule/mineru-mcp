#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios, { AxiosError } from "axios";

// Configuration schema for Smithery
export const configSchema = z.object({
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
    .describe("Default model: pipeline (fast) or vlm (90% accuracy)"),
});

type Config = z.infer<typeof configSchema>;

// Error codes with actionable messages
const ERROR_MESSAGES: Record<string, string> = {
  A0202: "Token error. Check your API key.",
  A0211: "Token expired. Get a new API key.",
  "-60002": "Invalid file format. Use: pdf, doc, docx, ppt, pptx, png, jpg, jpeg",
  "-60005": "File too large. Max 200MB.",
  "-60006": "Too many pages. Max 600 per file. Split the document.",
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
  state: "pending" | "running" | "done" | "failed" | "converting";
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
      const response = await axios({
        method,
        url: `${baseUrl}${endpoint}`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        data,
      });

      const result = response.data;
      if (result.code !== 0) {
        const code = String(result.code);
        const msg = ERROR_MESSAGES[code] || result.msg || "Unknown error";
        throw new Error(`MinerU error ${code}: ${msg}`);
      }

      return result.data as T;
    } catch (error) {
      if (error instanceof AxiosError) {
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
    version: "1.0.1",
  });

  // Tool 1: mineru_parse
  server.tool(
    "mineru_parse",
    "Parse a document URL. Returns task_id to check status.",
    {
      url: z.string().describe("Document URL (PDF, DOC, PPT, images)"),
      model: z
        .enum(["pipeline", "vlm"])
        .optional()
        .describe("pipeline=fast, vlm=90% accuracy"),
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
    async (params) => {
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
        content: [
          {
            type: "text",
            text: `Task created: ${result.task_id}\nUse mineru_status to check progress.`,
          },
        ],
      };
    }
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
    async (params) => {
      const status = await mineruRequest<TaskStatus>(`/extract/task/${params.task_id}`);

      const text =
        params.format === "detailed"
          ? formatDetailedStatus(status)
          : formatConciseStatus(status);

      return {
        content: [{ type: "text", text }],
      };
    }
  );

  // Tool 3: mineru_batch
  server.tool(
    "mineru_batch",
    "Parse multiple URLs in one batch (max 200).",
    {
      urls: z.array(z.string()).describe("Array of document URLs"),
      model: z
        .enum(["pipeline", "vlm"])
        .optional()
        .describe("pipeline=fast, vlm=90% accuracy"),
      ocr: z.boolean().optional().describe("Enable OCR (pipeline only)"),
      formula: z.boolean().optional().describe("Formula recognition"),
      table: z.boolean().optional().describe("Table recognition"),
      language: z.string().optional().describe("Language code: ch, en, etc"),
      formats: z
        .array(z.enum(["docx", "html", "latex"]))
        .optional()
        .describe("Extra export formats"),
    },
    async (params) => {
      if (params.urls.length > 200) {
        throw new Error("Max 200 URLs per batch. Split into smaller batches.");
      }

      const requestData: Record<string, unknown> = {
        files: params.urls.map((url) => ({ url })),
        model_version: params.model || defaultModel,
      };

      if (params.ocr !== undefined) requestData.is_ocr = params.ocr;
      if (params.formula !== undefined) requestData.enable_formula = params.formula;
      if (params.table !== undefined) requestData.enable_table = params.table;
      if (params.language) requestData.language = params.language;
      if (params.formats?.length) requestData.extra_formats = params.formats;

      const result = await mineruRequest<BatchResponse>("/extract/task/batch", "POST", requestData);

      return {
        content: [
          {
            type: "text",
            text: `Batch created: ${result.batch_id}\n${params.urls.length} files queued.\nUse mineru_batch_status to check progress.`,
          },
        ],
      };
    }
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
    async (params) => {
      const batch = await mineruRequest<BatchStatus>(
        `/extract-results/batch/${params.batch_id}`
      );

      const text =
        params.format === "detailed"
          ? JSON.stringify(batch, null, 2)
          : formatConciseBatch(batch, params.limit ?? 10, params.offset ?? 0);

      return {
        content: [{ type: "text", text }],
      };
    }
  );

  return server.server;
}

// STDIO mode for backward compatibility (npx, local dev)
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

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
