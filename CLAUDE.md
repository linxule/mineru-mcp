# mineru-mcp

MCP server for MinerU document parsing API — PDF/DOC/PPT/images to markdown.

## Quick Reference

- **Language**: TypeScript/Node
- **Package manager**: bun
- **Build**: `bun run build` (outputs to `dist/`)
- **Dev**: `bun run dev` (tsx, stdio mode)
- **Entry**: `src/index.ts` (stdio) / `src/server.ts` (HTTP) / `src/cli.ts` (`mineru-cloud` — runs the server in-process over `InMemoryTransport` and calls its tools; one implementation, two channels)

## API Key Management

- **Provider**: MinerU (OpenXLab) — https://mineru.net
- **Format**: Bearer token. Older keys were JWTs (decode `exp` below); keys issued in 2026 are opaque `sk-…` strings — the decode snippet then fails, and the only expiry check is a live probe: `GET /extract/task/probe` → `-60012` means authenticated, `401/403` means expired.
- **Expiry**: Tokens auto-expire after ~90 days from issuance
- **Don't hard-code the expiry date here** — a stale one is worse than none. (This line used to read "Current key expires: 2026-05-19" and sat ~2 months past that, presenting an expired key as current.) Read the real expiry from the token itself:
  ```bash
  # decode the JWT payload -> exp (unix seconds)
  python3 -c "import base64,json,os,sys;t=os.environ['MINERU_API_KEY'].split('.')[1];print(json.loads(base64.urlsafe_b64decode(t+'='*(-len(t)%4)))['exp'])"
  ```
- **Config location**: `~/.claude.json` under `mcpServers.mineru.env.MINERU_API_KEY` (appears in both global and project-level entries)
- **Env var**: `MINERU_API_KEY`
- **Troubleshooting 401**: almost always an expired token. Decode `exp` (above); tokens are **not refreshable** — generate a new one at mineru.net and update *both* the global and project-level entries in `~/.claude.json`.

## Architecture

Server registration in `src/index.ts`, artifact modules in `src/bundle/`, and 8 existing tools:

| Tool | Purpose | Flow |
|------|---------|------|
| `mineru_parse` | Parse single URL | Returns `task_id` |
| `mineru_status` | Check task progress | Poll with `task_id` |
| `mineru_batch` | Parse multiple URLs (preferred) | Returns `batch_id` |
| `mineru_batch_status` | Check batch progress | Poll with `batch_id` |
| `mineru_upload_batch` | Upload local files (slow, use URLs when possible) | Returns `batch_id` |
| `mineru_download_results` | Download named paper folders | Uses `batch_id`, saves to `output_dir` |
| `mineru_parse_long` | Document >200 pages | One batch of ≤200-page `page_ranges` slices; `data_id` = `name__pAAAAA-BBBBB` |
| `mineru_merge_slices` | Stitch a sliced batch | Orders by `data_id`, retains hash-qualified slice archives, and keeps page provenance unknown |

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

1. Fetch batch results from the API.
2. Download each ZIP with a compressed-byte limit.
3. Validate every entry, stream expanded-byte hashes, and check CRC integrity.
4. Retain the byte-identical ZIP under `{stem}/archives/<sha256>.zip`.
5. Write complete member inventory and diagnostic warnings.
6. Create named Markdown, content JSON, and image copies only when unambiguous.

Unknown files, layout/model JSON, and provider PDFs remain in the retained ZIP.
Unsafe archives go to quarantine. No shell `unzip` is used. ZIP64, encryption,
legacy non-ASCII names without a UTF-8 flag, special entries, and unsafe paths
are rejected. A retained diagnostic inventory has unknown source binding and
is not an importable Scholia bundle by itself.

### Offline bundle command

```sh
mineru-cloud bundle --source /absolute/source.pdf --archive /absolute/result.zip \
  --output /absolute/bundles --json
```

This command publishes an immutable directory containing `bundle.json`, exact
source bytes, and the original ZIP under the Scholia artifact contract 1.0.1.
It requires no credentials. Binding defaults to `unknown`; an explicit
`--binding caller_asserted` remains qualified. `--batch-id` and `--model` are
optional caller metadata. No provider version, coverage, or source-upload proof
is inferred. Replays verify retained bytes before returning the existing bundle.

### Lifecycle and slice limits

MCP lifecycle results include `structuredContent`; CLI lifecycle commands expose
it with `--json`. Polling uses normalized states across the full batch, including
pending entries outside pagination. All 8 public tool and command names remain.
Standalone durable submission reservation and lost-ID recovery are not implemented.
A CLI process restart is not proof that a prior cloud submission was rejected.

Merged slices retain hash-qualified archives and report unknown page provenance.
The content JSON now records slice references rather than flattening arrays or
adding assumed page offsets. Missing content produces a partial result and never
removes otherwise useful artifacts. Successor merges preserve earlier image links.

Historical note: released 1.2.0 matched UUID-prefixed content filenames but used
shell unzip, kept selected outputs, and assumed slice offsets. The current local
implementation replaces those behaviors; its fixtures do not establish live
provider or released-package validation. No version bump or release is implied.

## Development Notes

- Presigned OSS URLs are signed WITHOUT Content-Type — using axios for upload would fail because axios force-adds the header. Native `fetch` is used instead.
- `data_id` preserves original filename (spaces → underscores, special chars sanitized, max 128 chars) with collision detection.
- Smithery integration: `createServer()` export for hosted deployment, `createSandboxServer()` for scanning.
- Dual entry: `index.ts` = stdio transport (MCP clients), `server.ts` = HTTP/Express transport.

## Limits

- Single file: 200MB max, 200 pages max (use `pages` to parse a longer file in ≤200-page slices — verified 2026-09-16)
- Daily quota: 1000 pages at high priority (excess is deprioritized, not rejected)
- Batch: max 200 files per request
- Models: `pipeline` (fast) or `vlm` (90% accuracy, recommended for academic PDFs)

## Release (tokenless OIDC)

CI (`.github/workflows/publish-mcp.yml`) publishes on a `v*` tag — to npm (OIDC Trusted Publishing) **and** the MCP Registry (`mcp-publisher login github-oidc`, namespace `io.github.linxule/mineru`). Tokenless; no manual `npm publish` / `mcp-publisher`. Bun toolchain (`bun.lock`), grouped Dependabot. Since v1.1.4.

1. Bump `version` in **`package.json` AND `server.json`** (both top-level `version` and `packages[0].version`) — npm + Registry reject duplicate versions.
2. `bun run build` (tsc)
3. Commit + push (PRs run the build gate)
4. `git tag vX.Y.Z && git push origin vX.Y.Z` → CI publishes npm then the Registry.
5. **If the run fails at "Wait for exact npm version to propagate"** (npm took ~9 min on
   2026-09-16; the wait gives up at 5), the npm publish already succeeded — do not re-tag.
   Once `curl -sf https://registry.npmjs.org/mineru-mcp/X.Y.Z` returns, run the recovery path:
   `gh workflow run publish-mcp.yml --ref vX.Y.Z -f registry_tag=vX.Y.Z` (skips npm, publishes
   the Registry).

**One-time setup (done 2026-06-22):** npm Trusted Publisher for `mineru-mcp` (owner `linxule`, repo, workflow `publish-mcp.yml`, Environment blank; 2FA mode = "2FA **or** automation tokens"). Migrated npm→bun at v1.1.4 (the old `package-lock.json` was stale).
