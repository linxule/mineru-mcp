# mineru-mcp

MCP server for [MinerU](https://mineru.net) document parsing API - optimized for Claude Code.

## Features

- **4 optimized tools** with concise descriptions (~73% token reduction vs alternatives)
- **VLM model support** (90%+ accuracy) and pipeline mode (faster)
- **Page range selection** - parse specific pages only
- **Batch processing** - up to 200 documents at once
- **Pagination** - efficient handling of large batch results
- **109 language OCR** support

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

## Tools

### `mineru_parse`

Parse a single document URL.

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

### `mineru_status`

Check task progress and get download URL.

```typescript
mineru_status({
  task_id: "abc-123",
  format: "concise"    // optional: "concise" (default) or "detailed"
})
```

**Concise output**: `done | abc-123 | https://cdn-mineru.../result.zip`

### `mineru_batch`

Parse multiple documents in one batch (max 200).

```typescript
mineru_batch({
  urls: ["https://example.com/doc1.pdf", "https://example.com/doc2.pdf"],
  model: "vlm"
})
```

### `mineru_batch_status`

Get batch results with pagination.

```typescript
mineru_batch_status({
  batch_id: "batch-123",
  limit: 10,           // optional: max results (default: 10)
  offset: 0,           // optional: skip first N results
  format: "concise"    // optional: "concise" or "detailed"
})
```

## Supported Formats

- PDF, DOC, DOCX, PPT, PPTX
- PNG, JPG, JPEG

## Limits

- Single file: 200MB max, 600 pages max
- Daily quota: 2000 pages at high priority
- Batch: max 200 URLs per request

## License

MIT

## Links

- [MinerU](https://mineru.net) - Document parsing service
- [MinerU GitHub](https://github.com/opendatalab/MinerU) - Open source version
- [MCP Specification](https://modelcontextprotocol.io) - Model Context Protocol
