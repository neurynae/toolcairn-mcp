/**
 * Auto-init pipeline: the shared scan + classify + write + unknown-detection flow
 * used both by the `toolcairn_init` MCP handler (for explicit agent calls) and
 * by the server's auth/startup wiring (so fresh installs never require an agent
 * round-trip to provision `.toolcairn/`).
 *
 * Design notes:
 *   - One call = one project root. Callers iterate over `discoverProjectRoots()`
 *     to cover sibling-repo and workspace-only layouts.
 *   - Under the same atomic `mutateConfig()` lock, we both persist the scanned
 *     confirmed tools AND the list of `unknown_in_graph` tools (tools with
 *     `source === 'non_oss'` that have a github_url). That list is durable
 *     across sessions so agents can resume the `suggest_graph_update` drain
 *     after restarts.
 *   - When batch-resolve fails (network/HTTP 5xx/404), we DO NOT populate
 *     `unknown_in_graph` — otherwise the entire dependency tree would be
 *     pushed through staging on every offline run.
 */
import { createMcpLogger } from '@toolcairn/errors';
import type {
  ConfigAuditEntry,
  DiscoveryWarning,
  Ecosystem,
  ProjectFramework,
  ProjectSubproject,
  ScanMetadata,
  UnknownInGraphTool,
} from '@toolcairn/types';
import { type PendingAuditEntry, mutateConfig } from './config-store/index.js';
import { type BatchResolveFn, scanProject } from './discovery/index.js';
import {
  type AgentType,
  getInstructionsForAgent,
  getMcpConfigEntry,
  getOpenCodeMcpEntry,
} from './templates/agent-instructions.js';

const logger = createMcpLogger({ name: '@toolcairn/tools:auto-init' });

export interface AutoInitInput {
  projectRoot: string;
  agent: AgentType;
  batchResolve?: BatchResolveFn;
  /** Optional server path used by `.mcp.json` setup steps for local dev builds. */
  serverPath?: string;
  /** Human-readable reason stamped on the audit entry. */
  reason?: string;
}

export interface AutoInitScanSummary {
  project_name: string;
  languages: Array<{ name: string; file_count: number }>;
  frameworks: ProjectFramework[];
  subprojects: ProjectSubproject[];
  tool_counts: { total: number; indexed: number; non_oss: number };
  warnings: DiscoveryWarning[];
  scan_metadata: ScanMetadata;
}

export interface AutoInitResult {
  project_root: string;
  instruction_file: string;
  config_path: string;
  audit_log_path: string;
  events_path: string;
  mcp_config_entry: Record<string, unknown>;
  setup_steps: Array<{
    step: number;
    action: string;
    file: string;
    content: string;
    note: string;
  }>;
  scan_summary: AutoInitScanSummary;
  bootstrapped: boolean;
  migrated: boolean;
  last_audit_entry: ConfigAuditEntry;
  /**
   * Tools the scan found that the ToolCairn graph does not yet know about.
   * Agents MUST drain this via `suggest_graph_update` (batch) and then
   * `update_project_config` action='mark_suggestions_sent'.
   *
   * Empty when batch-resolve failed (to avoid flooding staging with everything).
   */
  unknown_tools: UnknownInGraphTool[];
}

/**
 * Core auto-init entry point. Safe to call repeatedly — idempotent on a given
 * project root because `mutateConfig()` is write-atomic and migration-aware.
 *
 * Does not throw for expected failures (scanner warnings, batch-resolve offline).
 * Only throws for unrecoverable issues (disk full, permission denied on
 * `.toolcairn/`, lockfile corruption). Callers in the MCP auth handler should
 * catch and report `status: 'failed'` per root so one failure doesn't abort
 * the whole auth flow.
 */
export async function autoInitProject(input: AutoInitInput): Promise<AutoInitResult> {
  const { projectRoot, agent, batchResolve, serverPath, reason } = input;

  logger.info({ projectRoot, agent }, 'autoInitProject starting');

  // 1. Full scan (12 ecosystems, per-tool resolver, batch-resolve classification).
  const scan = await scanProject(projectRoot, { batchResolve });

  // Detect whether batch-resolve actually produced a usable signal. If every
  // tool came back `non_oss`, batch-resolve was either offline or the endpoint
  // was down — in that case we skip persisting `unknown_in_graph` to avoid
  // spamming staging with the whole dependency tree on every cold start.
  const batchResolveFailed = scan.warnings.some(
    (w) => w.scope === 'batch-resolve' && /offline|falling back|unreachable|http /i.test(w.message),
  );

  const now = new Date().toISOString();
  const unknownFromScan: UnknownInGraphTool[] = batchResolveFailed
    ? []
    : scan.tools
        .filter((t) => t.source === 'non_oss' && !!t.github_url)
        .map((t) => {
          const ecosystem: Ecosystem = t.locations?.[0]?.ecosystem ?? 'npm';
          return {
            name: t.name,
            ecosystem,
            canonical_package_name: t.canonical_name,
            github_url: t.github_url,
            discovered_at: now,
            suggested: false,
          } satisfies UnknownInGraphTool;
        });

  const audit: PendingAuditEntry = {
    action: 'init',
    tool: '__project__',
    reason:
      reason ??
      `Auto-init: scanned ${scan.tools.length} tools across ${scan.scan_metadata.ecosystems_scanned.length} ecosystems; ${unknownFromScan.length} candidate(s) for graph submission.`,
  };

  const { config, audit_entry, bootstrapped, migrated } = await mutateConfig(
    projectRoot,
    (cfg) => {
      cfg.project.name = scan.name;
      cfg.project.languages = scan.languages;
      cfg.project.frameworks = scan.frameworks;
      cfg.project.subprojects = scan.subprojects;
      cfg.tools.confirmed = scan.tools;
      cfg.scan_metadata = scan.scan_metadata;

      // Merge unknown_in_graph: preserve `suggested: true` flags from prior runs
      // if the agent already drained them — a re-scan shouldn't undo progress.
      const priorByKey = new Map<string, UnknownInGraphTool>();
      for (const existing of cfg.tools.unknown_in_graph ?? []) {
        priorByKey.set(`${existing.ecosystem}:${existing.name}`, existing);
      }
      cfg.tools.unknown_in_graph = unknownFromScan.map((fresh) => {
        const prior = priorByKey.get(`${fresh.ecosystem}:${fresh.name}`);
        if (prior?.suggested) {
          return { ...fresh, suggested: true, suggested_at: prior.suggested_at };
        }
        return fresh;
      });
    },
    audit,
  );

  // 2. Setup steps for agent-owned files (CLAUDE.md / .mcp.json / .gitignore).
  const instructions = getInstructionsForAgent(agent);
  const isOpenCode = agent === 'opencode';
  const mcpConfigEntry = isOpenCode
    ? getOpenCodeMcpEntry(serverPath)
    : getMcpConfigEntry(serverPath);
  const mcpConfigFile = isOpenCode ? 'opencode.json' : '.mcp.json';
  const mcpContent = isOpenCode
    ? JSON.stringify({ mcp: mcpConfigEntry }, null, 2)
    : JSON.stringify({ mcpServers: mcpConfigEntry }, null, 2);

  const setupSteps = [
    {
      step: 1,
      action: 'append-or-create',
      file: instructions.file_path,
      content: instructions.content,
      note: `Append the ToolCairn rules block to ${instructions.file_path} (or create it if missing).`,
    },
    {
      step: 2,
      action: 'merge-or-create',
      file: mcpConfigFile,
      content: mcpContent,
      note: isOpenCode
        ? `Merge the toolcairn entry into ${mcpConfigFile} under "mcp".`
        : `Merge the toolcairn entry into ${mcpConfigFile} under "mcpServers".`,
    },
    {
      step: 3,
      action: 'append',
      file: '.gitignore',
      content:
        '\n# ToolCairn\n.toolcairn/events.jsonl\n.toolcairn/audit-log.jsonl\n.toolcairn/audit-log.archive.jsonl\n.toolcairn/config.lock\n',
      note: 'Ignore runtime/audit files. config.json should be committed so teammates share tool intelligence.',
    },
  ];

  const tool_counts = {
    total: config.tools.confirmed.length,
    indexed: config.tools.confirmed.filter((t) => t.source === 'toolcairn').length,
    non_oss: config.tools.confirmed.filter((t) => t.source === 'non_oss').length,
  };

  const undrained = (config.tools.unknown_in_graph ?? []).filter((t) => !t.suggested);

  return {
    project_root: projectRoot,
    instruction_file: instructions.file_path,
    config_path: '.toolcairn/config.json',
    audit_log_path: '.toolcairn/audit-log.jsonl',
    events_path: '.toolcairn/events.jsonl',
    mcp_config_entry: mcpConfigEntry,
    setup_steps: setupSteps,
    scan_summary: {
      project_name: scan.name,
      languages: scan.languages.map((l) => ({ name: l.name, file_count: l.file_count })),
      frameworks: scan.frameworks,
      subprojects: scan.subprojects,
      tool_counts,
      warnings: scan.warnings,
      scan_metadata: scan.scan_metadata,
    },
    bootstrapped,
    migrated,
    last_audit_entry: audit_entry,
    unknown_tools: undrained,
  };
}
