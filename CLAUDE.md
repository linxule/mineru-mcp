# mineru-mcp

MCP server for MinerU document parsing API — PDF/DOC/PPT/images to markdown.

## Quick Reference

- **Language**: TypeScript/Node
- **Package manager**: bun
- **Build**: `bun run build` (outputs to `dist/`)
- **Dev**: `bun run dev` (tsx, stdio mode)
- **Entry**: `src/index.ts` (stdio) / `src/server.ts` (HTTP)

## API Key Management

- **Provider**: MinerU (OpenXLab) — https://mineru.net
- **Format**: JWT token (Bearer auth)
- **Expiry**: Tokens auto-expire after ~90 days from issuance
- **Current key expires**: 2026-05-19
- **Config location**: `~/.claude.json` under `mcpServers.mineru.env.MINERU_API_KEY` (appears in both global and project-level entries)
- **Env var**: `MINERU_API_KEY`
- **Troubleshooting 401**: Decode the JWT payload (`iat`/`exp` fields) to check expiration. Tokens are not refreshable — generate a new one from mineru.net.

## Architecture

Single-file server (`src/index.ts`, ~695 lines) with 6 tools:

| Tool | Purpose | Flow |
|------|---------|------|
| `mineru_parse` | Parse single URL | Returns `task_id` |
| `mineru_status` | Check task progress | Poll with `task_id` |
| `mineru_batch` | Parse multiple URLs (preferred) | Returns `batch_id` |
| `mineru_batch_status` | Check batch progress | Poll with `batch_id` |
| `mineru_upload_batch` | Upload local files (slow, use URLs when possible) | Returns `batch_id` |
| `mineru_download_results` | Download named paper folders | Uses `batch_id`, saves to `output_dir` |

### URL workflow (preferred)

```
mineru_batch (array of public URLs — arXiv, SSRN, publisher sites)
  → mineru_batch_status (poll until all done)
  → mineru_download_results (extracts named paper folders)
```

### Local file workflow (fallback)

```
mineru_upload_batch (directory or files — slow, may timeout)
  → mineru_batch_status (poll until all done)
  → mineru_download_results (extracts named paper folders)
```

### How upload works

1. Collects files from `directory` or `files` param
2. Requests presigned OSS upload URLs from `/file-urls/batch`
3. Uploads each file via PUT to presigned URL (native fetch, no Content-Type header)
4. Size-proportional timeout: 60s base + 2s per MB. On timeout, suggests switching to URL approach.
5. MinerU processes automatically; poll with `mineru_batch_status`

### How download works

1. Fetches batch results from API
2. Downloads each `.zip` result via streaming
3. Extracts with `unzip` CLI (requires `unzip` on PATH)
4. Creates named paper folder `{stem}/` in output directory
5. Copies `full.md` → `{stem}.md`, `content_list_v2.json` → `{stem}_content.json`, and `images/`
6. Skips all other files (layout.json, model.json, block_list.json, origin PDF)

### Output structure

Each paper gets a named folder for easy search by author/keyword across a literature library:

```
output_dir/
├── wei2022_Chain-of-thought_prompting.../
│   ├── wei2022_Chain-of-thought_prompting....md           ← paper content
│   ├── wei2022_Chain-of-thought_prompting..._content.json ← structured TOC with semantic types
│   └── images/                                             ← extracted figures/tables
```

- **`{stem}.md`** — full paper as markdown (essential, always present)
- **`{stem}_content.json`** — structured content list with element types (title, paragraph, table, figure) and bounding boxes; useful for AI agents to quickly locate sections/figures without scanning full markdown
- **`images/`** — extracted figures and tables referenced by the markdown

Naming uses `author_year_title` convention from the original filename, with spaces → underscores, special chars sanitized, max 128 chars.

## Development Notes

- Presigned OSS URLs are signed WITHOUT Content-Type — using axios for upload would fail because axios force-adds the header. Native `fetch` is used instead.
- `data_id` preserves original filename (spaces → underscores, special chars sanitized, max 128 chars) with collision detection.
- Smithery integration: `createServer()` export for hosted deployment, `createSandboxServer()` for scanning.
- Dual entry: `index.ts` = stdio transport (MCP clients), `server.ts` = HTTP/Express transport.

## Limits

- Single file: 200MB max, 600 pages max
- Daily quota: 2000 pages at high priority
- Batch: max 200 files per request
- Models: `pipeline` (fast) or `vlm` (90% accuracy, recommended for academic PDFs)
