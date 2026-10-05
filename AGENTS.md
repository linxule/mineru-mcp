# Contributor handoff

This is the canonical contributor guide for this independent TypeScript package.
Apply higher-level instructions too. Read `README.md` for user workflows and the
actual tool schemas before changing behavior. `CLAUDE.md` points here.

## Verified baseline and authority

As of 2026-09-30, pushed `main` is `49e88ca` (portable verification/release gates),
including `9d3c95e` (provider boundaries, durable recovery, artifact containment).
Package/server versions remain 1.2.0. The published npm 1.2.0 predates the new
durable-operation and bundle features; a clean checkout or passing package test
does not make those features available from npm.

Last verification: build passed, full suite 323/323, fresh consumer package on
Node 18.20.8 8/8, and publication-version guard fixtures 7/7. These are dated
synthetic/offline checks, not a live provider pilot or parsing-accuracy claim.
Local full-suite execution used macOS/Node 26; CI is configured for Node 24 on
macOS/Linux and fresh-package checks on Node 18 on both platforms.
Ordinary `main` pushes now run verification only. Publishing still requires a
version tag; manual dispatch remains registry recovery for an existing release
tag and must not be used as a verification-only trigger. A pushed commit alone
does not establish a hosted CI pass; inspect the run for that exact commit.

Check `git status --short` before work; preserve unrelated edits and other agents'
ownership. Keep work local unless the task authorizes more. Documentation, tests,
and local builds do not authorize provider calls, credential access, push, tags,
npm publication, or registry registration. A partially failed or uncertain cloud
request is not permission to submit again.

## Runtime and code map

Use Bun 1.4.2 for dependency/build commands. Recommend Node 24; retain Node >=18
runtime compatibility. `bun.lock` owns locked dependency resolution. `dist/` is
generated and ignored; rebuild before running tests or the CLI. Keep the MCP SDK
1.29.x compatibility bound until the fresh Node 18 consumer gate proves a change.

| Area | Responsibility |
| --- | --- |
| `src/index.ts` | MCP registration and legacy V4 workflows |
| `src/cli.ts`, `src/server.ts` | CLI over the same tools via `InMemoryTransport`; HTTP transport |
| `src/operations.ts` | Standalone filesystem journal, writer lock, checkpoints and recovery |
| `src/providers/` | V4/V1 adapters, identity checks, public HTTPS transport, credential-echo rejection |
| `src/bundle/archive.ts`, `download.ts` | ZIP validation, exact retention, inventories, quarantine and compatibility aliases |
| `src/bundle/manifest.ts`, `operation_writer.ts`, `validation.ts` | Immutable bundles, intended-operation identity, semantic/byte validation |
| `src/bundle/filesystem.ts`, `filesystem_worker.ts` | Kernel-pinned directory operations; worker must ship in `dist/` |
| `src/canonical.ts`, `src/bundle/schema.ts` | Canonical hash profile and artifact schema |

The checkout registers 14 MCP tools: eight legacy tools plus `mineru_capabilities`,
`mineru_submit`, `mineru_operation_status`, `mineru_resume`, `mineru_cancel` and
`mineru_bundle`. Discover current names/options with `node dist/cli.js list`;
CLI names remove `mineru_` and replace underscores with hyphens. CLI `bundle`
also supports offline `--source PDF --archive ZIP --output DIRECTORY`; that form
returns its historical created/existing receipt and requires no credentials.

New operation commands expose a Result envelope through CLI `--json` and MCP
`structuredContent`: exit 0 for ok, 1 for partial/error, 2 for invalid arguments.
The original eight commands retain error=1 and partial/unknown=2. Inspect status,
state and recovery details; a nonzero exit does not authorize resubmission.

## Credentials and provider evidence

Use `MINERU_API_KEY` in the process environment. Only an explicitly authorized
MinerU task permits retrieving its necessary credential on this Mac through
`~/.local/bin/op-agent` from `op://Agent Keys/mineru api/credential` (the item title
is **mineru api**). Such task authorization covers the needed key access; it
does not cover unrelated calls. State the provider and bounded call scope before
execution. Keep keys only in process memory/environment, never in arguments,
logs, files, receipts or Git. Do not enumerate vaults or inspect private client
configuration such as `~/.claude.json`. A missing env var is not proof the key is
missing. Do not infer token lifetime, decode tokens as a routine check, or run
an authentication probe without task authorization.

Offline bundle creation, discovery and the test suite need no real credentials.
`operation-status` is local unless refreshed; capability refresh and `resume`
can contact the provider. Do not silently retry uncertain paid requests.

Modern V1 uses uploads/parse/jobs, not agent/parse. Hosted V1 execution is disabled
by default and remains fixture-only; do not enable it merely because tests pass.
V4 model names are not V1 tiers. New provider transports require public HTTPS,
pin validated DNS addresses, revalidate redirects and strip API authorization on
redirects. Preserve credential-echo checks at response, error and transfer edges.
Private/self-hosted endpoints need an explicit trust-policy implementation.

Local guards and legacy descriptions are not current provider/account evidence.
Do not repeat numeric quota, speed, OCR-accuracy, language-count or token-savings
claims without evidence and its scope/date. No quota reservation, scheduler,
remote cancellation or automatic lost-ID association is implemented here.

## Recovery and artifact invariants

- Preserve `MINERU_STATE_DIR` (default `~/.local/share/mineru-cloud`) for recovery.
  Exact requests deduplicate. Resume only safe saved checkpoints/known remote IDs;
  lost allocation/job IDs remain `reconciliation_required`. Preserve owner-token
  lock checks and verified orphan adoption; never clear an uncertain lock blindly.
- A partial operation retains verified outputs and typed missing-output causes.
  Explicit later resume may publish a successor; earlier bundles remain immutable.
  Local cancellation does not cancel remote processing or remove uploaded bytes.
- Retain original source/ZIP/detached bytes, including unknown formats. Never
  repack the retained ZIP, infer binding from filenames, or manufacture page
  offsets/coverage. Offline binding defaults to unknown; caller assertion stays
  qualified. Diagnostic inventories/quarantine are not importable bundles.
- Durable V4 page requests retain their original text in the operation identity.
  `src/providers/page_ranges.ts` validates bounded positive safe-integer
  intervals before source/provider access. New operation bundles record only
  normalized requested intent and unknown coverage; they do not derive page
  offsets, completed/missing pages or source completeness. Ranged writer
  addresses are versioned separately from legacy unknown-scope addresses.
  Exact old replay preserves its bytes; legacy successors must match the old
  writer's deterministic identity and any recorded manifest hash. Missing
  recorded bundles and conflicting occupied addresses fail closed. The archived
  writer fixture and `tests/operation-range-intent.test.mjs` exercise this
  compatibility without network access.
  Bounded historical selectors outside today's admission rules may reuse only
  exact existing legacy receipts; they cannot publish new/enriched bundles or
  reach a provider action. Offline finalization performs receipt adoption
  before applying the new-request guard.
- Local retention, bundles and durable operations require macOS/Linux and fail
  closed on Windows. Hold a pinned directory before awaits and use the contained
  helper through staging/publication. A final pathname check cannot replace that
  containment. Sync retained bytes before journal references. Process-kill tests
  establish bounded process-crash behavior, not universal power-loss or network
  filesystem durability.

## Verification and the independent Scholia boundary

```sh
bun install --frozen-lockfile
bun audit
bun run build
bun run test
bun run test:package
```

The package test installs the packed manifest without the repo lock and checks
both transports, packaged filesystem helper, and operation bundle identity.
Select Node 18 in PATH for the minimum-runtime gate (`process.execPath` is used).
Use injected/local providers and synthetic bytes. New temp fixtures must use
`tests/temp-dir.mjs` or `realpathSync(tmpdir())`, not a hardcoded `/private/tmp` or
an unresolved symlink alias. Run focused realistic regressions then the relevant
full/package checks; do not add live probes to verification.

Scholia is a separately packaged Python application with its own provider and
SQLite lease/reservation system. Neither runtime imports the other. Compatibility
is the Scholia artifact contract 1.0.1 and canonical profile
`scholia.canonical-json.v1`, not matching package versions. In a paired Scholia
checkout, read `docs/CONTINUITY.md` first, then
`docs/specs/scholia-v1/ARTIFACT_CONTRACT.md`, its schema and current
acceptance ledger; historical specification snapshots are not current delivery
status. Structural, semantic and retained-byte validation are all required.

Keep `tests/fixtures/artifact-contract/` and `tests/fixtures/page-mapping/`
byte-identical in both repositories, including manifest hashes and provenance.
Intentional contract/fixture changes require coordinating both owners and running
both conformance/page-mapping suites. Last comparison: 373 artifact-contract and
24 page-mapping files matched. Fixtures establish supported synthetic shapes,
not hosted parser identity or OCR accuracy.

For the real publication/import/replay/successor smoke, set `MINERU_CHECKOUT` and
`SCHOLIA_CHECKOUT` to explicit paired checkouts, build MinerU first, then run:

```sh
cd "$SCHOLIA_CHECKOUT"
uv run --group test python tests/cross_runtime_bundle_smoke.py --mineru-checkout "$MINERU_CHECKOUT"
```

Its provider boundary is fake and networking disabled; the journal/writer and
Scholia importer are real. Never point integration checks at a live corpus.

## Release authority and gates

Release only when explicitly authorized. Keep `package.json.version`,
`server.json.version` and all matching npm registration versions synchronized
with `vX.Y.Z`. `.github/workflows/publish-mcp.yml` resolves the checkout once;
macOS/Linux verification and publication use that same SHA. The aggregate `ci`
check requires every verification job before npm/MCP OIDC publication. Triggers
are PRs to `main`, version-tag pushes and manual registry recovery. Publishing
on a version tag is consequential; a successful local check does not authorize it.

If npm succeeded but MCP registration failed, do not re-tag or republish npm.
After verifying the intended published version, authorized registry-only recovery
is `gh workflow run publish-mcp.yml --ref main -f registry_tag=vX.Y.Z`.
It resolves the existing `refs/tags/vX.Y.Z`, verifies it, skips npm publication,
and registers through GitHub OIDC. Do not guess current publisher configuration
from historical setup dates or bypass these gates with a manual token.
