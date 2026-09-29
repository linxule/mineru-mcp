#!/usr/bin/env node
// mineru-cloud: the same tools as the MCP server, driven from a shell.
// It runs the MCP server in-process over an in-memory transport and calls its
// tools, so the CLI and the server can never drift apart.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBundle } from "./bundle/manifest.js";
import createServer from "./index.js";

const PREFIX = "mineru_";
const POLL_MS = 10_000;
const WAIT_MAX_MS = 30 * 60_000;

function usage(tools: Array<{ name: string; description?: string }>): string {
  const lines = [
    "mineru-cloud — MinerU cloud API from the shell (same tools as the mineru MCP server)",
    "",
    "usage: mineru-cloud <command> [--option value ...] [--wait]",
    "       mineru-cloud list",
    "       mineru-cloud bundle --source exact.pdf --archive result.zip --output directory [--json]",
    "",
    "commands:",
  ];
  for (const t of tools) {
    const cmd = t.name.replace(PREFIX, "").replace(/_/g, "-");
    lines.push(`  ${cmd.padEnd(18)} ${(t.description || "").split(/\.\s/)[0]}`);
  }
  lines.push(
    "",
    "options mirror the tool's parameters (--url, --pages, --total-pages, --output-dir, ...).",
    "values: numbers and true/false are coerced; JSON arrays/objects are parsed.",
    "--json emits structured lifecycle state (provider errors exit 1; partial/unknown exit 2).",
    "--wait re-runs a status/merge/download command every 10s until nothing is still processing.",
    "env: MINERU_API_KEY (required), MINERU_BASE_URL, MINERU_DEFAULT_MODEL",
  );
  return lines.join("\n");
}

type PropSchema = { type?: string | string[]; anyOf?: PropSchema[]; enum?: unknown[] };

// Coerce by the tool's declared type, so `--name 2026` stays a string and `--total-pages 450` becomes a number.
function coerce(v: string, schema: PropSchema | undefined): unknown {
  const types = new Set<string>();
  const collect = (p?: PropSchema) => {
    if (!p) return;
    for (const t of Array.isArray(p.type) ? p.type : p.type ? [p.type] : []) types.add(t);
    p.anyOf?.forEach(collect);
  };
  collect(schema);
  if (types.has("boolean") && (v === "true" || v === "false")) return v === "true";
  if ((types.has("number") || types.has("integer")) && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if ((types.has("array") || types.has("object")) && /^[\[{]/.test(v)) {
    try { return JSON.parse(v); } catch { /* fall through: the tool will report the schema error */ }
  }
  return v;
}

function parseArgs(argv: string[], props: Record<string, PropSchema>): { command: string | undefined; args: Record<string, unknown>; wait: boolean } {
  const [command, ...rest] = argv;
  const args: Record<string, unknown> = {};
  let wait = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--json") continue;
    if (a === "--wait") { wait = true; continue; }
    if (!a.startsWith("--")) throw new Error(`Unexpected argument: ${a}`);
    let key = a.slice(2);
    let val: string | undefined;
    const eq = key.indexOf("=");
    if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
    else if (i + 1 < rest.length && !rest[i + 1].startsWith("--")) { val = rest[++i]; }
    else { val = "true"; }
    const name = key.replace(/-/g, "_");
    args[name] = coerce(val, props[name]);
  }
  return { command, args, wait };
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const json = argv.includes('--json');
  if(command === 'bundle') {
    const {args} = parseArgs(argv, {});
    if(typeof args.source !== 'string' || typeof args.archive !== 'string' || typeof args.output !== 'string') throw new Error('bundle requires --source exact.pdf --archive result.zip --output directory');
    if(Object.keys(args).some(key=>!['source','archive','output','batch_id','model','binding'].includes(key))) throw new Error('Unknown bundle option');
    if(args.binding !== undefined && !['unknown','caller_asserted'].includes(String(args.binding))) throw new Error('binding must be unknown or caller_asserted');
    const result = await createBundle({source:args.source,archive:args.archive,output:args.output,batchId:args.batch_id as string|undefined,model:args.model as string|undefined,binding:args.binding as 'unknown'|'caller_asserted'|undefined});
    console.log(json?JSON.stringify({ok:true,...result}):`Bundle: ${result.bundle_dir}`);return;
  }

  const server = createServer({
    config: {
      mineruApiKey: process.env.MINERU_API_KEY || "",
      mineruBaseUrl: process.env.MINERU_BASE_URL || "https://mineru.net/api/v4",
      mineruDefaultModel: (process.env.MINERU_DEFAULT_MODEL as "pipeline" | "vlm") || "pipeline",
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "mineru-cloud", version: "1.0.0" });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage(tools));
    return;
  }
  if (command === "list") {
    for (const t of tools) {
      const cmd = t.name.replace(PREFIX, "").replace(/_/g, "-");
      const props = Object.entries((t.inputSchema as { properties?: Record<string, { description?: string }> }).properties || {});
      console.log(`${cmd}\n  ${t.description}\n` + props.map(([k, p]) => `  --${k.replace(/_/g, "-")}  ${p.description || ""}`).join("\n"));
    }
    return;
  }

  const toolName = PREFIX + command.replace(/-/g, "_");
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) {
    throw new Error(`Unknown command '${command}'. Run 'mineru-cloud list'.`);
  }
  const props = ((tool.inputSchema as { properties?: Record<string, PropSchema> }).properties) || {};
  const { args, wait } = parseArgs(argv, props);

  const started = Date.now();
  for (;;) {
    const result = await client.callTool({ name: toolName, arguments: args });
    const text = (result.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text").map((c) => c.text || "").join("\n");
    if (result.isError) throw new Error(text);
    const structured = result.structuredContent as {state?:string;pollable?:boolean}|undefined;
    if (!(wait && structured?.pollable === true)) {
      console.log(json?JSON.stringify({ok:true,...(structured??{state:'completed',text})}):text);
      if(structured?.state === 'failed') process.exitCode=1;
      else if(structured?.state === 'partial' || structured?.state === 'unknown') process.exitCode=2;
      return;
    }
    if (Date.now() - started > WAIT_MAX_MS) throw new Error(`Gave up waiting after 30 min:\n${text}`);
    process.stderr.write(`[wait] ${text.split("\n")[0].slice(0, 100)}\n`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    const message=err instanceof Error ? err.message : String(err);
    if(process.argv.includes('--json')) console.log(JSON.stringify({ok:false,state:'failed',code:'operation_failed',message}));
    else console.error(message);
    process.exit(1);
  });
