# mineru-mcp

MCP server for [MinerU](https://mineru.net) document parsing API — extract text, tables, and formulas from PDFs, DOCs, and images.

## Features

- **VLM model** — 90%+ accuracy for complex documents
- **Pipeline model** — Fast processing for simple documents
- **Local file upload** — Upload files from disk for batch parsing
- **Batch processing** — Parse up to 200 documents at once
- **Download & rename** — Extract markdown with original filenames
- **Page ranges** — Extract specific pages only
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
| `mineru_download_results` | Download results as named markdown files |

## Installation

### Claude Code

```bash
claude mcp add mineru-mcp -e MINERU_API_KEY=your-api-key -- npx mineru-mcp
```

### Claude Desktop

Add to your Claude Desktop config:

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

- Single file: 200MB max, 600 pages max
- Daily quota: 2000 pages at high priority
- Batch: max 200 files per request

## License

MIT

## Links

- [MinerU](https://mineru.net) — Document parsing service
- [MinerU GitHub](https://github.com/opendatalab/MinerU) — Open source version
- [MCP Specification](https://modelcontextprotocol.io) — Model Context Protocol
