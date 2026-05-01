# Changelog

All notable changes to `@neurynae/toolcairn-mcp` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
