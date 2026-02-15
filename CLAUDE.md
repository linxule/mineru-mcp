# mineru-mcp

MCP server for MinerU document parsing API (v4). Converts PDF/DOC/PPT/images to markdown.

## Build & Run

```bash
bun install
bun run build        # tsc → dist/
bun run start        # stdio mode (for Claude Code)
bun run start:http   # HTTP transport (for Smithery/containers)
```

## Architecture

- `src/index.ts` — Main server with 6 tools + Smithery factory export
- `src/server.ts` — HTTP transport wrapper (StreamableHTTPServerTransport)
- Dual transport: STDIO (Claude Code) and HTTP (Smithery/Docker)
- Factory pattern: `createServer({ config })` returns `Server` instance

## Tools (6)

| Tool | Purpose |
|------|---------|
| `mineru_parse` | Parse single document URL → task_id |
| `mineru_status` | Check task progress → download URL when done |
| `mineru_batch` | Parse multiple URLs (max 200) → batch_id |
| `mineru_batch_status` | Get batch results with pagination |
| `mineru_upload_batch` | Upload local files via presigned OSS URLs → batch_id |
| `mineru_download_results` | Download zips, extract .md, rename to original filenames |

## Local File Upload Flow

`mineru_upload_batch` → `/file-urls/batch` API → presigned Alibaba Cloud OSS URLs → `fetch` PUT (no Content-Type header — OSS signatures break with auto-added headers) → batch_id

**Important**: Uses native `fetch` for PUT uploads, not axios. Axios force-adds Content-Type headers that break OSS presigned URL signatures.

## Download Flow

`mineru_download_results` → check batch status → stream zip downloads (axios) → `execFileSync("unzip", [...])` → recursive `findMd()` with depth limit + symlink protection → write as `{data_id}.md`

**Naming**: Output filenames come from `data_id` (preferred, set by us from original filename with spaces→underscores) falling back to `file_name` (API-returned, can be stale).

## Security Notes

- `execFileSync` (not `execSync`) for zip extraction — no shell injection
- `basename()` + regex sanitization on all API-returned filenames
- `data_id` collision detection with counter suffix
- `findMd()` is depth-limited (max 5), skips symlinks, validates paths stay within extraction dir via `realpathSync`
- Streaming zip downloads to avoid memory pressure
- Temp dirs use `randomBytes` for collision resistance

## API

- Base URL: `https://mineru.net/api/v4`
- Auth: Bearer token (JWT from OpenXLab)
- Get key at: https://mineru.net
- Token expiry: check with `jwt.io` — typically 14 days

## Config (env vars)

| Var | Default | Required |
|-----|---------|----------|
| `MINERU_API_KEY` | — | Yes |
| `MINERU_BASE_URL` | `https://mineru.net/api/v4` | No |
| `MINERU_DEFAULT_MODEL` | `pipeline` | No |

## Limits

- Single file: 200MB, 600 pages
- Batch: max 200 files
- Daily quota: 2000 pages (high priority)
- Supported: PDF, DOC, DOCX, PPT, PPTX, PNG, JPG, JPEG
