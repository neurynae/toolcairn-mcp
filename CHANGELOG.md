# Changelog

All notable changes to `@neurynae/toolcairn-mcp` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.2] — 2026-05-01

### Fixed
- **Critical first-reconnect provisioning bug.** `runPostAuthInit` (the multi-root scan that writes `.toolcairn/config.json` + CLAUDE.md + .mcp.json + .gitignore for every project root under CWD) was running fire-and-forget *after* `server.connect(transport)`. On first reconnect, MCP hosts that close the stdio pipe right after `initialize` returns killed the scan mid-write — leaving sub-projects with no config.json. Moved the cheap part (scan + config write, `disableAutoSubmit: true`, `onlyMissingConfig: true`) before `server.connect`, with a 6s `Promise.race` cap so a slow batch-resolve can't blow Claude Code's ~10s initialize window. The expensive part (auto-push of unknown tools to `/v1/feedback/suggest`) stays in the background refresh as before. Subsequent reconnects are a no-op (existsSync short-circuit).

## [1.0.1] — 2026-05-01

### Fixed
- `npx @neurynae/toolcairn-mcp scan` no longer crashes with `Cannot find module '.../dist/cli/scan.js'`. Added `cli/scan` as a second tsup entry so the bundled scan CLI is included in the published tarball.
- **`scan` rewritten on top of the canonical `scanProject` + `batch-resolve` pipeline** — the same resolver that powers `toolcairn_init`. Lookups now go: Qdrant `registry_package_keys` → Qdrant `github_url` → Memgraph name (case-insensitive). Previous releases used `findByName` exact-match against Memgraph, which mis-classified npm-scoped packages (`@biomejs/biome` → graph stores it as `biome`), case-mismatched names (`typescript` lowercase → graph stores `TypeScript`), and ambiguous names (`turbo` matched didi/turbo BPMN engine instead of vercel/turborepo).
- `scan` now authenticates via the saved JWT from `~/.toolcairn/credentials.json` (written by `toolcairn_auth login`). Previously it called the API unauthenticated and got 401 from the CF Worker.
- `scan` table output is now real (was a no-op empty `for` loop) and shows `manifest_name → canonical_name` when the graph stores the tool under a different display name.
- `scan --json` now writes JSON to stdout (was silently dropped before).

### Added
- `scan` reads each dep's installed manifest (`node_modules/<dep>/package.json`, `Cargo.toml`, `requirements.txt`, etc.) to extract `canonical_package_name` + `github_url` for the resolver — so `@types/*`, npm aliases, and scope-stripped names all resolve correctly.
- `scan` prints a clear sign-in instruction when no valid credentials exist, instead of failing with an opaque API error.

## [1.0.0] — 2026-05-01 — Public Launch

### Added
- **Public launch** of ToolCairn — graph-powered MCP server for tool discovery, comparison, and stack building.
- 15 MCP tools across discovery, stacks, compatibility, comparison, and project config:
  - `search_tools`, `search_tools_respond` — multi-stage ranked tool search with clarification loop
  - `get_stack`, `refine_requirement` — multi-facet stack building with version-aware cross-tool fit
  - `check_compatibility` — peer-dependency range evaluator with declared / graph / shared-neighbors fallback
  - `compare_tools` — head-to-head with health signals + community data
  - `classify_prompt` — fast triage of when to engage tool intelligence
  - `verify_suggestion`, `report_outcome`, `suggest_graph_update` — agent feedback loop
  - `toolcairn_init`, `read_project_config`, `update_project_config` — `.toolcairn/` project state
  - `toolcairn_auth` — anonymous + OAuth dual-auth modes
  - `check_issue` — last-resort GitHub issue lookup after 4+ retries
- Coverage of **35+ open-source registries** including npm, PyPI, Cargo, Maven, Go modules, Composer, RubyGems, NuGet, Homebrew, and more.
- Project-aware tracking via `.toolcairn/config.json` with cross-process atomic writes and `audit-log.jsonl` journal.
- Live dashboard at `.toolcairn/tracker.html`.
- `mcpName: io.github.neurynae/toolcairn-mcp` for Official MCP Registry namespace verification.
- `smithery.yaml` for Smithery npm-stdio submission.
- `.well-known/mcp/server-card.json` static fallback for directories that prefer pre-built metadata.

### Security
- Pre-launch hardening sweep complete (24 findings: 6 critical / 9 high / 9 medium — see SECURITY.md in toolcairn-engine).
- npm package ships with `--provenance` attestations.
- Project-config writes use `chmod 0600` and atomic file replacement.
- Project root validation rejects symlink traversal and non-absolute paths.
- Cached `cwdRootCache` is TTL'd to prevent stale state.

### Infrastructure
- All GitHub Actions SHA-pinned.
- Dependabot configured for npm, GitHub Actions, and dev-deps.

## Earlier 0.x releases

For pre-launch development releases, see [git tags](https://github.com/neurynae/toolcairn-mcp/tags).
