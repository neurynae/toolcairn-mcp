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
 *   - Setup files (CLAUDE.md, .mcp.json, .gitignore) are written by the server
 *     alongside `.toolcairn/` so the agent has nothing to apply. All three are
 *     idempotent via sentinel markers + JSON merge, so re-runs don't duplicate.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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
import writeFileAtomic from 'write-file-atomic';
import { type PendingAuditEntry, mutateConfig } from './config-store/index.js';
import { type BatchResolveFn, scanProject } from './discovery/index.js';
import { fileExists } from './discovery/util/fs.js';
import {
  type AgentType,
  getInstructionsForAgent,
  getMcpConfigEntry,
  getOpenCodeMcpEntry,
} from './templates/agent-instructions.js';

const logger = createMcpLogger({ name: '@toolcairn/tools:auto-init' });

/**
 * Sentinel string that marks the ToolCairn rules block inside any agent
 * instruction file (CLAUDE.md, .cursorrules, AGENTS.md, etc). Matches the
 * actual heading inside CORE_RULES in `templates/agent-instructions.ts` —
 * keep these in sync if either changes.
 */
const INSTRUCTION_SENTINEL = '## ToolCairn — Tool Intelligence MCP';

/** Sentinel for the ToolCairn block inside .gitignore. */
const GITIGNORE_SENTINEL = '# ToolCairn';

/** The exact block we append to .gitignore (kept minimal + human-readable). */
const GITIGNORE_BLOCK =
  '\n# ToolCairn\n.toolcairn/events.jsonl\n.toolcairn/audit-log.jsonl\n.toolcairn/audit-log.archive.jsonl\n.toolcairn/config.lock\n';

export interface AutoInitInput {
  projectRoot: string;
  agent: AgentType;
  batchResolve?: BatchResolveFn;
  /** Optional server path used by `.mcp.json` setup steps for local dev builds. */
  serverPath?: string;
  /** Human-readable reason stamped on the audit entry. */
  reason?: string;
  /**
   * Skip the server-side setup-file writes (CLAUDE.md / .mcp.json / .gitignore).
   * Default false — the server writes them itself so the agent never has to.
   * Tests set this to true to keep fixtures clean.
   */
  skipSetupFileWrites?: boolean;
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

export interface AppliedSetupStep {
  file: string;
  action: 'append-or-create' | 'merge-or-create' | 'append';
  applied: boolean;
  /** Reason when applied === false — e.g. "already present", "unparseable JSON". */
  reason?: string;
}

export interface AutoInitResult {
  project_root: string;
  instruction_file: string;
  config_path: string;
  audit_log_path: string;
  events_path: string;
  mcp_config_entry: Record<string, unknown>;
  /** Legacy structure: still returned for callers that want to re-apply manually. */
  setup_steps: Array<{
    step: number;
    action: string;
    file: string;
    content: string;
    note: string;
  }>;
  /** What the server actually did for each of the three setup files on this run. */
  applied_steps: AppliedSetupStep[];
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
 * Does not throw for expected failures (scanner warnings, batch-resolve offline,
 * setup-file write failures). Only throws for unrecoverable issues (disk full,
 * permission denied on `.toolcairn/`, lockfile corruption). Callers in the
 * MCP auth handler should catch and report `status: 'failed'` per root so one
 * failure doesn't abort the whole auth flow.
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

  // 2. Build the legacy setup_steps[] payload (kept for callers that want it).
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
      content: GITIGNORE_BLOCK,
      note: 'Ignore runtime/audit files. config.json should be committed so teammates share tool intelligence.',
    },
  ];

  // 3. Apply the three setup files on disk, idempotently. Failures are caught
  //    per-file and reported in applied_steps — never throws from here.
  const applied_steps = input.skipSetupFileWrites
    ? setupSteps.map((s) => ({
        file: s.file,
        action: s.action as AppliedSetupStep['action'],
        applied: false,
        reason: 'skipSetupFileWrites=true',
      }))
    : await applySetupFiles(projectRoot, {
        agent,
        instructionFile: instructions.file_path,
        instructionContent: instructions.content,
        mcpConfigFile,
        mcpConfigEntry,
        isOpenCode,
      });

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
    applied_steps,
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

// ─── Setup-file writes ────────────────────────────────────────────────────────

interface ApplySetupArgs {
  agent: AgentType;
  instructionFile: string;
  instructionContent: string;
  mcpConfigFile: string;
  mcpConfigEntry: Record<string, unknown>;
  isOpenCode: boolean;
}

async function applySetupFiles(
  projectRoot: string,
  args: ApplySetupArgs,
): Promise<AppliedSetupStep[]> {
  const results: AppliedSetupStep[] = [];

  results.push(
    await applyInstructionFile(
      resolve(projectRoot, args.instructionFile),
      args.instructionFile,
      args.instructionContent,
    ),
  );
  results.push(
    await applyMcpConfig(
      resolve(projectRoot, args.mcpConfigFile),
      args.mcpConfigFile,
      args.mcpConfigEntry,
      args.isOpenCode,
    ),
  );
  results.push(await applyGitignore(resolve(projectRoot, '.gitignore')));

  return results;
}

/**
 * CLAUDE.md / .cursorrules / AGENTS.md / etc.
 *
 * If the file exists and already contains the ToolCairn sentinel heading,
 * no-op (idempotent across re-runs). Otherwise append (or create) with the
 * current CORE_RULES block. We never mutate existing content — only add.
 */
async function applyInstructionFile(
  abs: string,
  relPath: string,
  content: string,
): Promise<AppliedSetupStep> {
  try {
    const exists = await fileExists(abs);
    if (exists) {
      const current = await readFile(abs, 'utf-8');
      if (current.includes(INSTRUCTION_SENTINEL)) {
        return {
          file: relPath,
          action: 'append-or-create',
          applied: false,
          reason: 'ToolCairn rules block already present',
        };
      }
      const separator = current.endsWith('\n') ? '' : '\n';
      await writeFileAtomic(abs, `${current}${separator}${content}`, 'utf-8');
      return { file: relPath, action: 'append-or-create', applied: true };
    }
    await writeFileAtomic(abs, content, 'utf-8');
    return { file: relPath, action: 'append-or-create', applied: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ err, file: relPath }, 'Failed to write instruction file');
    return { file: relPath, action: 'append-or-create', applied: false, reason };
  }
}

/**
 * .mcp.json (or opencode.json for OpenCode agents).
 *
 * Three cases:
 *   - File missing: create with just the toolcairn entry.
 *   - File valid JSON but no `toolcairn` entry: merge in without disturbing
 *     existing mcpServers (or `mcp` for OpenCode).
 *   - File has `toolcairn` entry already: no-op.
 *   - File is unparseable: refuse to overwrite — user may have written
 *     something custom. Report reason in applied_steps; caller can retry
 *     after fixing the file.
 */
async function applyMcpConfig(
  abs: string,
  relPath: string,
  entry: Record<string, unknown>,
  isOpenCode: boolean,
): Promise<AppliedSetupStep> {
  try {
    const exists = await fileExists(abs);
    const topKey = isOpenCode ? 'mcp' : 'mcpServers';

    if (!exists) {
      const payload = { [topKey]: entry };
      await writeFileAtomic(abs, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
      return { file: relPath, action: 'merge-or-create', applied: true };
    }

    const raw = await readFile(abs, 'utf-8');
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {
        file: relPath,
        action: 'merge-or-create',
        applied: false,
        reason: 'existing file is not valid JSON — refusing to overwrite; fix manually',
      };
    }

    const existingServers =
      parsed[topKey] && typeof parsed[topKey] === 'object' && !Array.isArray(parsed[topKey])
        ? (parsed[topKey] as Record<string, unknown>)
        : {};

    if (existingServers.toolcairn !== undefined) {
      return {
        file: relPath,
        action: 'merge-or-create',
        applied: false,
        reason: `${topKey}.toolcairn already present`,
      };
    }

    const merged = {
      ...parsed,
      [topKey]: { ...existingServers, ...entry },
    };
    await writeFileAtomic(abs, `${JSON.stringify(merged, null, 2)}\n`, 'utf-8');
    return { file: relPath, action: 'merge-or-create', applied: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ err, file: relPath }, 'Failed to write MCP config');
    return { file: relPath, action: 'merge-or-create', applied: false, reason };
  }
}

/**
 * .gitignore — append the ToolCairn runtime-files block if the sentinel
 * header (`# ToolCairn`) isn't already present. Never overwrites existing
 * entries.
 */
async function applyGitignore(abs: string): Promise<AppliedSetupStep> {
  const relPath = '.gitignore';
  try {
    const exists = await fileExists(abs);
    if (!exists) {
      await writeFileAtomic(abs, GITIGNORE_BLOCK.replace(/^\n/, ''), 'utf-8');
      return { file: relPath, action: 'append', applied: true };
    }
    const current = await readFile(abs, 'utf-8');
    if (current.includes(GITIGNORE_SENTINEL)) {
      return {
        file: relPath,
        action: 'append',
        applied: false,
        reason: 'ToolCairn gitignore block already present',
      };
    }
    const separator = current.endsWith('\n') ? '' : '\n';
    await writeFileAtomic(abs, `${current}${separator}${GITIGNORE_BLOCK}`, 'utf-8');
    return { file: relPath, action: 'append', applied: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ err, file: relPath }, 'Failed to write .gitignore');
    return { file: relPath, action: 'append', applied: false, reason };
  }
}
