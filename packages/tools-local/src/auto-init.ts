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
  ConfirmedTool,
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

// No sentinel / marker matching for the agent instruction file — it's
// server-owned, so every reconnect simply overwrites it with the current
// CORE_RULES content. The MCP server is the source of truth; user-authored
// notes belong in a separate file (or outside our managed block).
//
// .gitignore is different: users have their own ignore rules we mustn't
// touch. We preserve those and refresh only our block in place.

/** The exact block we append to .gitignore (kept minimal + human-readable). */
const GITIGNORE_BLOCK =
  '\n# ToolCairn\n.toolcairn/events.jsonl\n.toolcairn/audit-log.jsonl\n.toolcairn/audit-log.archive.jsonl\n.toolcairn/config.json\n';

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
      cfg.scan_metadata = scan.scan_metadata;

      // Merge confirmed[] — reconnect/auto-refresh must preserve user fields.
      //
      // Scan output supplies the latest graph/registry-derived truth
      // (description, license, homepage_url, docs, package_managers, categories,
      // canonical_name, match_method, locations, github_url, version). User
      // fields that we must NOT clobber on re-scan: chosen_reason, notes,
      // alternatives_considered, query_id, confirmed_at/chosen_at (original
      // add timestamp). last_verified is bumped to now to reflect the fresh
      // verification.
      //
      // Safety: when batch-resolve failed (offline / engine down), EVERY scan
      // tool would come back as source='non_oss', which would incorrectly
      // flip previously-matched tools. Short-circuit and leave cfg.tools.confirmed
      // untouched in that case.
      if (!batchResolveFailed) {
        const priorConfirmedByKey = new Map<string, ConfirmedTool>();
        for (const existing of cfg.tools.confirmed) {
          const eco = existing.locations?.[0]?.ecosystem ?? '';
          priorConfirmedByKey.set(`${eco}:${existing.name}`, existing);
        }
        cfg.tools.confirmed = scan.tools.map((fresh) => {
          const eco = fresh.locations?.[0]?.ecosystem ?? '';
          const prior = priorConfirmedByKey.get(`${eco}:${fresh.name}`);
          if (!prior) return fresh;
          return {
            ...fresh,
            // Preserve add-time ordinals + user-set fields.
            chosen_at: prior.chosen_at ?? fresh.chosen_at,
            confirmed_at: prior.confirmed_at ?? prior.chosen_at ?? fresh.chosen_at,
            last_verified: now,
            chosen_reason:
              prior.chosen_reason && prior.chosen_reason.length > 0
                ? prior.chosen_reason
                : fresh.chosen_reason,
            alternatives_considered:
              prior.alternatives_considered && prior.alternatives_considered.length > 0
                ? prior.alternatives_considered
                : fresh.alternatives_considered,
            query_id: prior.query_id ?? fresh.query_id,
            notes: prior.notes ?? fresh.notes,
          };
        });
      }

      // Merge unknown_in_graph: preserve `suggested: true` flags from prior runs
      // if the agent already drained them — a re-scan shouldn't undo progress.
      const priorUnknownByKey = new Map<string, UnknownInGraphTool>();
      for (const existing of cfg.tools.unknown_in_graph ?? []) {
        priorUnknownByKey.set(`${existing.ecosystem}:${existing.name}`, existing);
      }
      cfg.tools.unknown_in_graph = unknownFromScan.map((fresh) => {
        const prior = priorUnknownByKey.get(`${fresh.ecosystem}:${fresh.name}`);
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
 * Server-owned file: every reconnect overwrites it with the current
 * CORE_RULES content. No keyword or marker detection — the MCP server is
 * the source of truth, and trying to merge user-authored prose into a
 * server-managed file just creates sentinel-drift bugs when the rules
 * heading changes.
 *
 * If you need to keep your own project notes, put them in a sibling file
 * (e.g. PROJECT_NOTES.md) that the server doesn't touch.
 */
async function applyInstructionFile(
  abs: string,
  relPath: string,
  content: string,
): Promise<AppliedSetupStep> {
  try {
    // Skip the write when the file already holds the exact content we'd
    // produce — saves the audit entry + filesystem churn on reconnects.
    if (await fileExists(abs)) {
      const current = await readFile(abs, 'utf-8');
      if (current === content) {
        return {
          file: relPath,
          action: 'append-or-create',
          applied: false,
          reason: 'content already up to date',
        };
      }
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
 * The `toolcairn` entry under `mcpServers` / `mcp` is always refreshed with
 * the current entry shape (command + args) — picks up changes to the launcher
 * between MCP versions. Other entries (user's own MCP servers) are preserved
 * untouched. If the existing file isn't valid JSON we refuse to overwrite
 * so we don't destroy hand-written config; the caller reports the reason.
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

    // Always replace `toolcairn` with the latest entry. Other MCP servers
    // the user has configured stay untouched (spread existingServers first,
    // then overlay our entry — a fresh object so deleted fields don't linger).
    const toolcairnEntry = (entry as { toolcairn?: Record<string, unknown> }).toolcairn ?? entry;
    const merged = {
      ...parsed,
      [topKey]: {
        ...existingServers,
        toolcairn: toolcairnEntry,
      },
    };
    const nextJson = `${JSON.stringify(merged, null, 2)}\n`;
    if (raw === nextJson) {
      return {
        file: relPath,
        action: 'merge-or-create',
        applied: false,
        reason: 'toolcairn entry already up to date',
      };
    }
    await writeFileAtomic(abs, nextJson, 'utf-8');
    return { file: relPath, action: 'merge-or-create', applied: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ err, file: relPath }, 'Failed to write MCP config');
    return { file: relPath, action: 'merge-or-create', applied: false, reason };
  }
}

/**
 * .gitignore — refreshes only the ToolCairn block between stable markers,
 * preserves every other rule in the file.
 *
 * Rule: everything between `# toolcairn:start` and `# toolcairn:end` is
 * server-owned and gets replaced every reconnect. Lines outside the
 * markers are the user's and we never touch them. If markers don't exist,
 * we append the block at the end. No keyword detection of any kind.
 */
const GITIGNORE_BLOCK_START = '# toolcairn:start';
const GITIGNORE_BLOCK_END = '# toolcairn:end';

function buildGitignoreBlock(): string {
  return `${GITIGNORE_BLOCK_START}${GITIGNORE_BLOCK}${GITIGNORE_BLOCK_END}\n`;
}

async function applyGitignore(abs: string): Promise<AppliedSetupStep> {
  const relPath = '.gitignore';
  try {
    const exists = await fileExists(abs);
    const ourBlock = buildGitignoreBlock();

    if (!exists) {
      await writeFileAtomic(abs, ourBlock, 'utf-8');
      return { file: relPath, action: 'append', applied: true };
    }
    const current = await readFile(abs, 'utf-8');
    const startIdx = current.indexOf(GITIGNORE_BLOCK_START);
    const endIdx = current.indexOf(GITIGNORE_BLOCK_END);

    let next: string;
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      // Replace in place. Slice up to start-of-line for the opening marker
      // and just past end-of-line for the closing marker so we don't leave
      // ragged newlines.
      const lineStart = current.lastIndexOf('\n', startIdx) + 1;
      const afterEndOfLine = current.indexOf('\n', endIdx);
      const sliceEnd = afterEndOfLine === -1 ? current.length : afterEndOfLine + 1;
      next = current.slice(0, lineStart) + ourBlock + current.slice(sliceEnd);
    } else {
      // No markers → append. Users with an older, unmarked ToolCairn block
      // will briefly have both; a manual one-line cleanup resolves it.
      const separator = current.endsWith('\n') ? '' : '\n';
      next = `${current}${separator}${ourBlock}`;
    }

    if (next === current) {
      return {
        file: relPath,
        action: 'append',
        applied: false,
        reason: 'block already up to date',
      };
    }
    await writeFileAtomic(abs, next, 'utf-8');
    return { file: relPath, action: 'append', applied: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ err, file: relPath }, 'Failed to write .gitignore');
    return { file: relPath, action: 'append', applied: false, reason };
  }
}
