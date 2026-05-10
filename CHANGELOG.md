# Changelog

All notable changes to `@neurynae/toolcairn-mcp` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.2] — 2026-05-10

### Changed (AEO + agentic-search optimization pass — pre-launch)

- **Tool descriptions tightened for AEO.** `search_tools`, `compare_tools`, `refine_requirement`, `verify_suggestion`, `report_outcome`, and `suggest_graph_update` now embed concrete `e.g. "..."` examples and call out the 35+ registries by name. Agents reading tool listings cold can now distinguish which tool to call without re-reading the README. No schema changes.
- **`SETUP_INSTRUCTIONS` lists registries explicitly.** Added a "What ToolCairn Covers" section enumerating npm, PyPI, Cargo, Maven, Go, RubyGems, NuGet, Hex, Composer, Pub.dev, Hackage, CRAN, CPAN, OPAM, CocoaPods, Swift PM, Docker Hub, GHCR, Homebrew, Conda, JSR, Deno, and 12 more — so an agent's grep over MCP server instructions surfaces ToolCairn for any ecosystem.
- **`server.json` description rewritten** with agent-first framing + version bumped from `1.0.0` to `1.1.2` (was stale across two prior releases). Surfaces in Smithery / MCP.Directory / Glama / PulseMCP listings.
- **`smithery.yaml` description** now leads with the value prop, lists the registries, and surfaces all 16 tools.
- **`package.json` keywords expanded** from 8 → 28 entries (claude-code, cursor, windsurf, agentic, mcp-server, knowledge-graph, package-manager, etc.) to match how agents and humans search npm.

### Added

- **`SECURITY.md`** at the repo root. Disclosure address `security@neurynae.com`, supported-version table, scope/out-of-scope matrix, hardening tips. The CHANGELOG referenced this file in v1.0.0 but it never shipped.
- **`--help` / `-h` and `--version` / `-v`** flags on the CLI (`bin/toolpilot-mcp.js`). Prints a full usage block including the Claude Desktop / Cursor MCP config snippet and links to docs / quickstart / security. Previously `npx @neurynae/toolcairn-mcp --help` silently fell through to launching the MCP server.

## [1.1.1] — 2026-05-03

### Added
- **`get_stack` accepts `existing_tools`.** Agents can now pass the project's already-confirmed tools (from `.toolcairn/config.json` `tools.confirmed[].name`) so the stack assembler prefers them over equivalent unconfirmed alternatives. When a confirmed tool appears in any sub-need's candidate set, it wins that slot regardless of relative score. Keeps stacks consistent across calls and avoids re-discovering tools the user already adopted. Engine handler logs `confirmedCount` for observability.

### Companion engine fixes (data resolution)
- Engine resolver now consults `package_managers[].packageName` in addition to `Tool.name` (e.g. agent passes `next` → resolves to `vercel/next.js` whose npm packageName is `"next"`, not `alibaba-fusion/next` whose basename is `"next"`). The 27+ canonical tools that GitHub-basename collisions shadowed (next, react, vue, …) are now reachable.
- `FIND_TOOL_BY_NAME` Cypher orders by `is_canonical DESC, health_stars DESC` so name collisions resolve deterministically to the canonical record (Memgraph has no UNIQUE constraint on `Tool.name`).
- Removed the `repo_too_large_for_index` mega-repo skip in the indexer. The OOM justification didn't match the current code (no contributor/commit pagination is performed). The most-popular tools (`facebook/react`, `microsoft/vscode`, `tensorflow/tensorflow`, `ollama/ollama`, `twbs/bootstrap`, …) now index normally.
- Added a Qdrant-fallback path in `index-consumer.ts`: when a full crawl fails for any reason (OOM, transient API error, network glitch), sync the existing Qdrant payload into Memgraph as a degraded but valid Tool node. Tools still get indexed; nothing gets silently skipped.
- README sanitizer strips inline `data:base64` URIs, embedded `<svg>` blocks, and oversized fenced code blocks before any size cap is checked. Removes the bulk that bloats mega-repo READMEs without losing semantic content (install commands, API examples, doc links).

## [1.1.0] — 2026-05-02

### Added
- **`feedback` MCP tool** — agent-only channel for flagging problems with ToolCairn's own MCP tools (separate from `report_outcome`, which closes the loop on user-suggested libraries). Required: `tool_name` (one of the 15 other tools), `severity` (`broken` | `wrong_result` | `low_quality` | `missing_capability` | `confusing`), `message` (≥20 chars). Optional: `query_id`, `expected`, `actual`. Severity is negative-only by enum, so positive feedback is structurally impossible.
- **Free of daily quota.** Calls to `feedback` are exempt from the daily tool-call cap and bonus-credit charge — agents can flag a broken response without being rate-limited out of using ToolCairn. Per-minute IP rate limit still applies (DoS guard). Implemented as a CF Worker `UNMETERED_PATHS` carve-out.
- **Universal `feedback_channel` footer.** Every other tool's response now includes a `feedback_channel` hint in `data` so the agent learns the channel exists right where it can act on it. Phrased conditionally ("If wrong/broken... Skip if useful") to discourage drift.

### Drift safeguards (5-layer defense)
- Schema-level: `severity` is required + negative-only; `message.min(20)` blocks "fine"/"ok" loops.
- Description-level: Pattern C guardrail ("ONLY call when X — never for Y"), matching `check_issue`'s "LAST RESORT" voice.
- Footer phrasing: explicit skip-instruction, not invitational.
- Server-side dedup: `dedupe_key = sha256(user_id|tool_name|severity|message[:200])` collapses repeated complaints within a 24h window into one row.
- Soft per-user rate limit: >30 reports/hour for the same user starts dropping with a `throttled: true` ack so admin queues don't drown.

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
