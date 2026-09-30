# mineru-mcp

MCP server for [MinerU](https://mineru.net) document parsing API — extract text, tables, and formulas from PDFs, DOCs, and images.

## Features

- **VLM model** — 90%+ accuracy for complex documents
- **Pipeline model** — Fast processing for simple documents
- **Local file upload** — Upload files from disk for batch parsing
- **Batch processing** — Parse up to 200 documents at once
- **Download & rename** — Extract markdown with original filenames
- **Page ranges** — Extract specific pages only
- **Long documents** — MinerU caps files at 200 pages; `mineru_parse_long` slices and `mineru_merge_slices` stitches
- **CLI twin** — `mineru-cloud` runs the same tools from a shell (no MCP context cost)
- **109 language OCR** support
- **Optimized for Claude Code** — 73% token reduction vs alternatives

## Tools

| Tool | Description |
|------|-------------|
| `mineru_parse` | Parse a document URL |
| `mineru_status` | Check task progress, get download URL |
| `mineru_batch` | Parse multiple URLs (max 200) |
| `mineru_batch_status` | Get batch results with pagination |
| `mineru_upload_batch` | Upload local files for batch parsing |
| `mineru_download_results` | Retain complete archives, inventory all members, and create named compatibility copies |
| `mineru_parse_long` | Document >200 pages: one batch of ≤200-page `page_ranges` slices |
| `mineru_merge_slices` | Join available Markdown and retain immutable slice archives with explicit unknown page provenance |

## Installation

Requires [Node.js](https://nodejs.org/) 18+ and a [MinerU API key](https://mineru.net).

Local output retention, bundles, and durable operations require macOS or Linux.
These paths use directory-bound filesystem operations and fail closed on Windows;
the Windows client configuration below does not imply local retention support.

### CLI Install (one-liner)

```bash
# Claude Code
claude mcp add mineru-mcp -e MINERU_API_KEY=your-api-key -- npx -y mineru-mcp

# Codex CLI (OpenAI)
codex mcp add mineru --env MINERU_API_KEY=your-api-key -- npx -y mineru-mcp

# Gemini CLI (Google)
gemini mcp add -e MINERU_API_KEY=your-api-key mineru npx -y mineru-mcp
```

### Claude Desktop

Add to your `claude_desktop_config.json`:

| OS | Config path |
|----|-------------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "mineru": {
      "command": "npx",
      "args": ["-y", "mineru-mcp"],
      "env": {
        "MINERU_API_KEY": "your-api-key"
      }
    }
  }
}
```

### VS Code

Add to `.vscode/mcp.json` (workspace) or open Command Palette > `MCP: Open User Configuration` (global):

```json
{
  "servers": {
    "mineru": {
      "command": "npx",
      "args": ["-y", "mineru-mcp"],
      "env": {
        "MINERU_API_KEY": "your-api-key"
      }
    }
  }
}
```

> **Note**: VS Code uses `"servers"` as the top-level key, not `"mcpServers"`. Other VS Code forks (Trae, Void, PearAI, etc.) typically use this same format.

### Cursor

Add to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "mineru": {
      "command": "npx",
      "args": ["-y", "mineru-mcp"],
      "env": {
        "MINERU_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json` (Windows: `%USERPROFILE%\.codeium\windsurf\mcp_config.json`):

```json
{
  "mcpServers": {
    "mineru": {
      "command": "npx",
      "args": ["-y", "mineru-mcp"],
      "env": {
        "MINERU_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Cline

Open MCP Servers icon in Cline panel > Configure > Advanced MCP Settings, then add:

```json
{
  "mcpServers": {
    "mineru": {
      "command": "npx",
      "args": ["-y", "mineru-mcp"],
      "env": {
        "MINERU_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Cherry Studio

In Settings > MCP Servers > Add Server, set Type to `STDIO`, Command to `npx`, Args to `-y mineru-mcp`, and add environment variable `MINERU_API_KEY`. Or paste in JSON/Code mode:

```json
{
  "mineru": {
    "name": "MinerU",
    "command": "npx",
    "args": ["-y", "mineru-mcp"],
    "env": {
      "MINERU_API_KEY": "your-api-key"
    },
    "isActive": true
  }
}
```

### Witsy

In Settings > MCP Servers, add a new server with Type: `stdio`, Command: `npx`, Args: `-y mineru-mcp`, and set environment variable `MINERU_API_KEY` to your API key.

### Codex CLI (TOML config)

Alternatively, edit `~/.codex/config.toml` directly:

```toml
[mcp_servers.mineru]
command = "npx"
args = ["-y", "mineru-mcp"]

[mcp_servers.mineru.env]
MINERU_API_KEY = "your-api-key"
```

### Gemini CLI (JSON config)

Alternatively, edit `~/.gemini/settings.json` directly:

```json
{
  "mcpServers": {
    "mineru": {
      "command": "npx",
      "args": ["-y", "mineru-mcp"],
      "env": {
        "MINERU_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Windows

On Windows, `npx` requires a shell wrapper. Replace `"command": "npx"` with:

```json
{
  "command": "cmd",
  "args": ["/c", "npx", "-y", "mineru-mcp"],
  "env": {
    "MINERU_API_KEY": "your-api-key"
  }
}
```

For CLI tools on Windows:

```bash
claude mcp add mineru-mcp -e MINERU_API_KEY=your-api-key -- cmd /c npx -y mineru-mcp
codex mcp add mineru --env MINERU_API_KEY=your-api-key -- cmd /c npx -y mineru-mcp
```

### ChatGPT

ChatGPT only supports remote MCP servers over HTTPS — local stdio servers like this one are not directly supported. You would need to deploy behind a public URL with HTTP transport.

## CLI: `mineru-cloud`

Every tool is also a shell command — the CLI runs the MCP server in-process over an in-memory
transport, so the two can't drift. Same env vars (`MINERU_API_KEY`, `MINERU_BASE_URL`,
`MINERU_DEFAULT_MODEL`).

```bash
mineru-cloud list                                    # commands + options (from the tool schemas)
mineru-cloud parse --url https://arxiv.org/pdf/2303.08774 --pages 1-10
mineru-cloud status --task-id <id> --wait            # --wait polls every 10s until done/failed
mineru-cloud batch --urls '["https://…/a.pdf","https://…/b.pdf"]'
mineru-cloud download-results --batch-id <id> --output-dir ./papers --wait

# > 200 pages: slice, then stitch
mineru-cloud parse-long --url https://…/book.pdf --total-pages 520 --name book
mineru-cloud merge-slices --batch-id <id> --output-dir ./books --wait
```

Options mirror the tool parameters with `_` → `-` (`--total-pages`, `--output-dir`); numbers,
`true`/`false` and JSON arrays are coerced. Install: `bun add -g mineru-mcp` (or `npm i -g`).

### Offline artifact bundles

Create a portable Scholia v1.0.1 bundle from an existing provider ZIP and the exact
source PDF. This command runs offline and does not require an API key:

```bash
mineru-cloud bundle --source /absolute/source.pdf --archive /absolute/result.zip \
  --output /absolute/bundles --json
```

The command returns `bundle_dir`, an immutable directory containing `bundle.json`,
the original PDF, and the byte-identical ZIP. Move the entire directory for import.
Repeated inputs verify the existing bytes and return the same bundle. Optional
`--batch-id` and `--model` record caller-supplied metadata. `--binding caller_asserted`
records a qualified association; the default is `unknown`. Neither choice proves
that the provider parsed those exact PDF bytes. The command does not infer page
coverage, requested options, or provider versions from filenames.

Only PDF sources qualify for this bundle. Existing non-PDF cloud commands remain
available and produce diagnostic inventories. Unsafe archives are retained in
quarantine, outside importable bundles. ZIP64, encrypted archives, special files,
ambiguous legacy filename encodings, and unsafe or colliding paths are rejected.

### Complete downloads and structured status

`download-results` retains each ZIP under `{name}/archives/<sha256>.zip` and writes
an `inventory.json` covering every member, including unknown formats. It also
creates legacy `{name}.md`, `{name}_content.json`, and image copies when selection
is unambiguous. A missing or ambiguous Markdown file does not discard the archive.
No shell `unzip` executable is used. Inventory hashes expanded bytes incrementally;
selected compatibility copies have a separate 64 MiB size limit.

Use `--json` on lifecycle commands for structured operation IDs, normalized state,
pollability, counts, and errors. `--wait` uses typed state across the whole batch,
including entries outside the displayed page. It polls every 10 seconds for up to
30 minutes. A failed entry does not hide other pending entries. Unknown provider
states remain explicit. Exit status is 1 for failure and 2 for partial or unknown
results. The 8 existing MCP tool names and their CLI commands remain available.

Slice merges retain each archive under a hash-qualified directory. Earlier image
links remain valid after a successor merge. The merged content JSON is a slice
receipt with archive references, rather than a flattened array with assumed page
offsets. Missing Markdown or failed slices produce an explicit partial result;
otherwise coverage and original PDF page provenance remain unknown.

### Durable standalone operations

The 6 additional commands share their implementation with MCP:

```sh
mineru-cloud capabilities --api v4 --json
mineru-cloud submit --file /absolute/source.pdf --api v4 --model vlm --output-dir /absolute/results --json
mineru-cloud operation-status --operation-id ID --json
mineru-cloud resume --operation-id ID --wait --wait-timeout-seconds 1800 --json
mineru-cloud cancel --operation-id ID --json
mineru-cloud bundle --operation-id ID --json
```

`MINERU_STATE_DIR` selects the journal root; the default is
`~/.local/share/mineru-cloud`. Keep that directory for recovery. The journal
retains source bytes, request fingerprints, remote IDs, completed output hashes,
and phase checkpoints. Credentials and signed URLs stay in process memory.
Exact duplicate submissions join the recorded operation. A lost allocation or
job ID requires reconciliation and never triggers automatic resubmission.
An ambiguous V4 upload with a saved batch ID resumes by polling that batch.
V1 inspects a known upload before continuing an uncertain completion.

One process holds the writer lock at a time. Normal dead-process locks can be
reclaimed with an owner-token check. An interrupted lock-recovery step or a reused
PID fails closed with an explicit busy/recovery error. This filesystem journal
is separate from Scholia's SQLite lease and reservation system; it does not claim
Scholia's worker scheduling or maintenance guarantees.

`operation-status` reads locally unless `--refresh` is supplied. `resume` continues
a safe checkpoint. Finalization uses saved outputs without contacting the provider.
Local cancellation does not cancel remote processing or remove uploaded data.
Remote cancellation and automatic lost-ID association remain unsupported.
Completed bundles preserve archives and every detached output, including unknown
formats. Provider transport completion does not establish full PDF page coverage.

When one output remains unavailable after bounded download attempts, the operation
publishes a partial bundle containing the verified successes and typed failure
details. `bundle --operation-id ID` can return that retained evidence. An explicit
later `resume` may recover missing outputs from the same operation and publish a
successor; earlier bundles remain immutable. A partial result is not permission
to submit the document again.

New operation commands use a structured Result envelope in CLI JSON and MCP
`structuredContent`, while retaining the existing flattened fields for
compatibility. Their CLI exit codes are 0 for `ok`, 1 for `partial` or `error`,
and 2 for invalid arguments. The original eight commands retain their historical
error=1 and partial=2 exit codes. Offline `bundle --source ... --archive ...`
also retains its existing created/existing receipt shape. Check `status`,
`state`, and recovery details rather than interpreting a nonzero exit as
permission to resubmit.

The process-restart tests kill workers at actual source, submission-intent,
output-retention, and finalization checkpoints. Verified source orphans created
before the first journal can be adopted safely; uncertain remote submissions
cannot. Source/output writes are synced before their journal references. These
tests establish bounded process-crash behavior, not a universal power-loss or
network-filesystem durability guarantee.

The modern V1 adapter uses `uploads`, `parse/jobs`, and `files/{id}/content`.
It does not use the older `agent/parse` API. Explicit capability refresh queries
`health` and the separate `tiers` endpoint. No V4 model is mapped to a V1 tier.
V1 range parsing is unsupported. Hosted V1 execution remains disabled by default
until endpoint-specific validation; fixture tests can inject an adapter.

New network calls require public HTTPS addresses. DNS results are checked and
pinned at connection time; redirects are revalidated and lose API authorization.
Transfer URLs receive only explicitly supplied headers. Private/self-hosted
endpoints require a separately implemented trust policy and are not enabled here.
New `submit` currently accepts PDFs; the original 8 commands retain non-PDF support.
There is no account quota reservation, automatic scheduler, or operator UI for
uncertain-operation association in this standalone milestone.

Official protocol references are the [pinned V1 guide](https://github.com/opendatalab/MinerU/blob/mineru-4.0.5-released/docs/en/usage/http_api.md),
[pinned example](https://github.com/opendatalab/MinerU/blob/mineru-4.0.5-released/scripts/http_api_example.sh),
and [pinned API server schema](https://github.com/opendatalab/MinerU/blob/mineru-4.0.5-released/mineru/parser/api_server.py).
The current guide was checked on September 30, 2026. All new execution behavior
is fixture-tested; no live provider validation, version bump, or release is claimed.

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `MINERU_API_KEY` | (required) | Your MinerU API Bearer token |
| `MINERU_BASE_URL` | `https://mineru.net/api/v4` | API base URL |
| `MINERU_DEFAULT_MODEL` | `pipeline` | Default model: `pipeline` or `vlm` |

Get your API key at [mineru.net](https://mineru.net)

## Usage

### Parse a single URL

```typescript
mineru_parse({
  url: "https://example.com/document.pdf",
  model: "vlm",        // optional: "pipeline" (default) or "vlm" (90% accuracy)
  pages: "1-10,15",    // optional: page ranges
  ocr: true,           // optional: enable OCR (pipeline only)
  formula: true,       // optional: formula recognition
  table: true,         // optional: table recognition
  language: "en",      // optional: language code
  formats: ["html"]    // optional: extra export formats
})
```

### Check task progress

```typescript
mineru_status({
  task_id: "abc-123",
  format: "concise"    // optional: "concise" (default) or "detailed"
})
```

**Concise output**: `done | abc-123 | https://cdn-mineru.../result.zip`

### Batch parse URLs

```typescript
mineru_batch({
  urls: ["https://example.com/doc1.pdf", "https://example.com/doc2.pdf"],
  model: "vlm"
})
```

### Check batch progress

```typescript
mineru_batch_status({
  batch_id: "batch-123",
  limit: 10,           // optional: max results (default: 10)
  offset: 0,           // optional: skip first N results
  format: "concise"    // optional: "concise" or "detailed"
})
```

### Upload local files

```typescript
mineru_upload_batch({
  directory: "/path/to/pdfs",  // scan directory for supported files
  // OR
  files: ["/path/to/doc1.pdf", "/path/to/doc2.pdf"],  // explicit file list
  model: "vlm",        // optional
  formula: true,       // optional
  table: true,         // optional
  language: "en",      // optional
  formats: ["html"]    // optional
})
```

Returns `batch_id` for tracking. Each file's original name is preserved via `data_id` (spaces become underscores).

### Download results as markdown

```typescript
mineru_download_results({
  batch_id: "batch-123",       // from mineru_upload_batch or mineru_batch
  output_dir: "/path/to/output",
  overwrite: false             // optional: overwrite existing files
})
```

Output filenames are derived from `data_id` (e.g., `my_paper_title.md`). Spaces in original filenames become underscores.

### Typical local file workflow

```
mineru_upload_batch → mineru_batch_status (poll) → mineru_download_results
```

## Supported Formats

- PDF, DOC, DOCX, PPT, PPTX
- PNG, JPG, JPEG

## Limits

- Single file: 200MB max, 200 pages max (use `pages` to parse a longer file in ≤200-page slices — verified 2026-09-16)
- Daily quota: 1000 pages at high priority (excess is deprioritized, not rejected)
- Batch: max 200 files per request

## Release 1.1.6

Restores Node.js 18 HTTP compatibility for fresh installs by retaining MCP SDK
1.29.x and its Node 18-compatible Hono adapter. SDK 1.30 permits an adapter that
requires Node.js 20. Version 1.1.5 passed the locked dependency checks but the
published-package check exposed an HTTP initialization failure on a fresh install.
CI now installs the packed package without the repository lock and exercises both
transports on Node.js 18. The SDK compatibility bound is intentional; revisit it
with this consumer-install gate before adopting a newer SDK.

## Release 1.1.5

Maintenance release: audited dependency updates, Express 5 and Zod 4 compatibility,
and regression coverage for both transports. The MCP handshake and HTTP startup
message now report the package version instead of the stale 1.0.2 value. Tool
inputs and document-processing behavior are unchanged.

## Development

Use Bun 1.4.2 and Node.js 24 for the build and CI checks:

```sh
bun install --frozen-lockfile
bun audit
bun run build
bun run test
bun run test:package
```

The runtime tests exercise the built stdio and HTTP servers against a local
MinerU API double. They check tool schemas, request mapping, pagination defaults,
provider errors, malformed HTTP requests, and session termination without real
credentials or API calls. They do not verify live parsing or file extraction.
Dependabot updates the Bun manifest and lockfile together. CI audits dependencies
and runs the build and runtime tests before publishing on version tags.

### Publishing

Bump `package.json` and both version fields in `server.json`, complete the checks
above, merge, then push the matching `vX.Y.Z` tag. CI publishes to npm, waits for
the exact package version to become available, then registers it with the MCP Registry.
If registry registration fails after npm succeeds, retry only registration using
the existing immutable tag:

```sh
gh workflow run publish-mcp.yml --ref main -f registry_tag=v1.1.6
```

## License

MIT

## Links

- [MinerU](https://mineru.net) — Document parsing service
- [MinerU GitHub](https://github.com/opendatalab/MinerU) — Open source version
- [MCP Specification](https://modelcontextprotocol.io) — Model Context Protocol
