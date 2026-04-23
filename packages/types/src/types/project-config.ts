// ToolCairn Project Config — persisted as .toolcairn/config.json in the user's project root.
// As of v1.1 the MCP server owns reads and writes to this file (atomic, cross-process-locked).
// The legacy v1.0 shape (agent-authored) is still accepted on read and auto-migrated.

// 'toolpilot' kept for backward compat with configs created before the ToolCairn rename
export type ToolSource = 'toolcairn' | 'toolpilot' | 'manual' | 'non_oss';

/** Registries the discovery module knows how to emit. */
export type Ecosystem =
  | 'npm'
  | 'pypi'
  | 'cargo'
  | 'go'
  | 'rubygems'
  | 'maven'
  | 'gradle'
  | 'composer'
  | 'hex'
  | 'pub'
  | 'nuget'
  | 'swift-pm';

/** Manifest section a dependency appeared under. Weighted differently by framework detection. */
export type ManifestSection = 'dep' | 'dev' | 'peer' | 'optional' | 'build';

/** Cascading match method returned by the engine batch-resolve endpoint. */
export type MatchMethod =
  | 'exact_channel'
  | 'channel_alias'
  | 'tool_name_exact'
  | 'tool_name_lowercase'
  | 'none';

/** Where a tool was found in the project. One entry per (workspace, manifest, section) triple. */
export interface ToolLocation {
  /** Relative path from project root, e.g. "apps/web" or "" for root. */
  workspace_path: string;
  /** Manifest file relative to workspace_path, e.g. "package.json". */
  manifest_file: string;
  section: ManifestSection;
  ecosystem: Ecosystem;
  /** e.g. "^14.0.0" from manifest. */
  version_constraint?: string;
  /** e.g. "14.2.3" from lockfile — undefined when no lockfile present. */
  resolved_version?: string;
}

export interface ConfirmedTool {
  /** Tool name as declared in the manifest (or user-provided name for non_oss/manual). */
  name: string;
  /** How this tool was sourced. */
  source: ToolSource;
  /** GitHub URL if available. */
  github_url?: string;
  /** Pinned version, e.g. "^5.0.0" — kept for quick display; full info in `locations`. */
  version?: string;
  /** ISO timestamp when confirmed (canonical field). */
  chosen_at: string;
  /** Alias for chosen_at used in v1.0 configs. */
  confirmed_at?: string;
  /** ISO timestamp of last verification/re-check (used for staleness). */
  last_verified?: string;
  /** Why this tool was chosen. */
  chosen_reason: string;
  /** Tool names that were considered but not chosen. */
  alternatives_considered: string[];
  /** query_id from search_tools session that recommended this tool. */
  query_id?: string;
  /** Notes about proprietary licensing, pricing, etc. */
  notes?: string;
  /** Canonical name from the ToolCairn graph (differs from manifest name). */
  canonical_name?: string;
  /** Graph categories (e.g. ['framework', 'web-framework']). Populated by batch-resolve. */
  categories?: string[];
  /** How batch-resolve matched this tool (undefined for source=manual/non_oss). */
  match_method?: MatchMethod;
  /** Every (workspace, manifest, section) where this tool was detected. v1.1+. */
  locations?: ToolLocation[];
}

export interface PendingTool {
  /** Tool name or category description. */
  name: string;
  /** Tool category. */
  category: string;
  /** ISO timestamp when added. */
  added_at: string;
}

/**
 * A tool discovered in the project whose (ecosystem, name) was NOT matched in
 * the ToolCairn graph by batch-resolve. Persisted across sessions so the agent
 * can drain the list via `suggest_graph_update` even after process restarts.
 */
export interface UnknownInGraphTool {
  /** Tool name as declared in the manifest. */
  name: string;
  ecosystem: Ecosystem;
  /** Canonical package name pulled from the installed manifest, when available. */
  canonical_package_name?: string;
  /** GitHub URL from the installed manifest — enables engine-side indexer enqueue. */
  github_url?: string;
  /** ISO timestamp when this entry was added to the list. */
  discovered_at: string;
  /** Flipped true once the agent successfully staged this tool via suggest_graph_update. */
  suggested: boolean;
  /** ISO timestamp of the successful suggest_graph_update call. */
  suggested_at?: string;
}

export interface ConfigAuditEntry {
  action:
    | 'add_tool'
    | 'remove_tool'
    | 'update_tool'
    | 'add_evaluation'
    | 'init'
    | 'migrate'
    | 'mark_suggestions_sent';
  tool: string;
  /** ISO timestamp. */
  timestamp: string;
  reason: string;
}

export interface ProjectLanguage {
  /** e.g. "TypeScript", "Python". */
  name: string;
  /** Source files counted under this language across the whole tree (excl. vendor/build dirs). */
  file_count: number;
  /** Workspaces where this language appears (by file count > 0). */
  workspaces: string[];
}

export interface ProjectFramework {
  /** e.g. "Next.js", "FastAPI". */
  name: string;
  /** Registry where the underlying dep lives. */
  ecosystem: Ecosystem;
  /** Workspace path where the framework was detected. */
  workspace: string;
  /** 'graph' when classified by batch-resolve, 'local' when only the fallback map matched. */
  source: 'graph' | 'local';
}

export interface ProjectSubproject {
  /** Relative path from project root. */
  path: string;
  /** Manifest file that declared this as a subproject (e.g. "package.json", "pyproject.toml"). */
  manifest: string;
  ecosystem: Ecosystem;
}

export interface ScanMetadata {
  ecosystems_scanned: Ecosystem[];
  parsers_failed: string[];
  tools_resolved: number;
  tools_unresolved: number;
  duration_ms: number;
  /** ISO timestamp of the scan. */
  completed_at: string;
}

/** A partial-failure note attached to scan output or handler responses. */
export interface DiscoveryWarning {
  scope: string;
  message: string;
  path?: string;
}

/**
 * Project config schema.
 *
 * v1.0 (legacy): agent-authored; had `project.language` string, `project.framework?` string,
 * and inline `audit_log: []`. Still accepted on read and migrated to v1.1 on first write.
 *
 * v1.1: server-authored; multi-language/framework via arrays, per-tool `locations[]`,
 * audit log relocated to `.toolcairn/audit-log.jsonl`.
 *
 * v1.2 (current): adds `tools.unknown_in_graph[]` — tools discovered during scanning
 * that the ToolCairn graph does not yet know about. Agent drains these via
 * `suggest_graph_update` (staging for admin review) and marks them with
 * `update_project_config action='mark_suggestions_sent'`.
 */
export interface ToolPilotProjectConfig {
  /** Config schema version. Reader supports 1.0/1.1/1.2; writer always emits 1.2. */
  version: '1.0' | '1.1' | '1.2';
  project: {
    name: string;
    /** v1.0 legacy, preserved on read for migration; v1.1+ writer omits in favour of `languages`. */
    language?: string;
    /** v1.0 legacy; v1.1+ writer uses `frameworks`. */
    framework?: string;
    /** v1.1+: all languages detected across the tree, ordered by file count. */
    languages?: ProjectLanguage[];
    /** v1.1+: frameworks detected per workspace. */
    frameworks?: ProjectFramework[];
    /** v1.1+: monorepo sub-projects. */
    subprojects?: ProjectSubproject[];
  };
  tools: {
    confirmed: ConfirmedTool[];
    pending_evaluation: PendingTool[];
    /**
     * v1.2+: tools scanned from the project that were not matched by the engine's
     * batch-resolve — candidates for the agent to submit via `suggest_graph_update`.
     * Entries flip `suggested: true` after a successful staging call.
     */
    unknown_in_graph?: UnknownInGraphTool[];
  };
  /**
   * v1.0 only — chronological log of all config mutations. v1.1+ migrates this array into
   * `.toolcairn/audit-log.jsonl` and removes it from the config doc.
   */
  audit_log?: ConfigAuditEntry[];
  /** v1.1+: summary of the most recent mutation. Full history is in audit-log.jsonl. */
  last_audit_entry?: ConfigAuditEntry | null;
  /** v1.1+: metadata from the scan that populated / refreshed this config. */
  scan_metadata?: ScanMetadata;
}
