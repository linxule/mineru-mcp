# mineru-mcp contributor guide

Read [AGENTS.md](AGENTS.md) before working in this package. It is the canonical
handoff for all agents, including Claude Code: current runtime/tool surface,
credential authority, recovery/artifact invariants, Scholia integration,
verification and release gates.

Use [README.md](README.md) for user-facing setup and command examples; use the
actual registered schemas (`node dist/cli.js list` after building) for current
options. Do not substitute private client configuration or historical provider
claims for current evidence. No client-config edits, credential retrieval,
provider calls or publication are authorized merely by reading these guides.
