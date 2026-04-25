import { createMcpLogger } from '@toolcairn/errors';
import type { ConfigAuditEntry, ConfirmedTool, ToolPilotProjectConfig } from '@toolcairn/types';
import {
  joinAuditPath,
  joinConfigPath,
  mutateConfig,
  readConfig,
  readLiveAudit,
} from '../config-store/index.js';
import { errResult, okResult } from '../utils.js';

const logger = createMcpLogger({ name: '@toolcairn/tools:read-project-config' });

/** Tools older than this many days are flagged for re-evaluation. */
const STALENESS_THRESHOLD_DAYS = 90;

/** Outcomes older than this are dropped from the pending list (assumed abandoned). */
const PENDING_OUTCOME_TTL_DAYS = 7;

/** MCP tools whose successful response carries a query_id agents should report on. */
const RECOMMENDATION_MCP_TOOLS = new Set(['search_tools', 'search_tools_respond', 'get_stack']);

interface PendingOutcome {
  query_id: string;
  mcp_tool: string;
  selected_at: string;
  age_hours: number;
  candidates: string[];
  query: string | null;
}

/**
 * Walk the live audit log and surface query_ids that received a recommendation
 * but no matching report_outcome yet. Bounded to the last PENDING_OUTCOME_TTL_DAYS
 * to avoid nagging about long-abandoned sessions.
 */
function derivePendingOutcomes(entries: ConfigAuditEntry[]): PendingOutcome[] {
  const cutoff = Date.now() - PENDING_OUTCOME_TTL_DAYS * 24 * 60 * 60 * 1000;
  const open = new Map<string, PendingOutcome>();

  for (const e of entries) {
    if (e.action !== 'tool_call' || !e.query_id) continue;
    if (e.status === 'error') continue;
    const ts = Date.parse(e.timestamp);
    if (Number.isNaN(ts) || ts < cutoff) continue;

    if (e.mcp_tool && RECOMMENDATION_MCP_TOOLS.has(e.mcp_tool)) {
      // Latest recommendation wins — overwrite any earlier same-query entry so
      // the surfaced age reflects the most recent search call.
      const queryFromMeta =
        typeof e.metadata?.query === 'string'
          ? e.metadata.query
          : typeof e.metadata?.use_case === 'string'
            ? e.metadata.use_case
            : null;
      open.set(e.query_id, {
        query_id: e.query_id,
        mcp_tool: e.mcp_tool,
        selected_at: e.timestamp,
        age_hours: Math.round((Date.now() - ts) / (1000 * 60 * 60)),
        candidates: e.candidates ?? [],
        query: queryFromMeta,
      });
    } else if (e.mcp_tool === 'report_outcome') {
      open.delete(e.query_id);
    }
  }

  return Array.from(open.values()).sort(
    (a, b) => Date.parse(a.selected_at) - Date.parse(b.selected_at),
  );
}

function daysSince(isoDate: string): number {
  return (Date.now() - new Date(isoDate).getTime()) / (1000 * 60 * 60 * 24);
}

export async function handleReadProjectConfig(args: {
  project_root: string;
  include_locations?: boolean;
}) {
  try {
    logger.info({ project_root: args.project_root }, 'read_project_config called');

    const { config: initial, corrupt_backup_path } = await readConfig(args.project_root);

    if (!initial) {
      return okResult({
        status: 'not_initialized',
        project_root: args.project_root,
        config_path: joinConfigPath(args.project_root),
        audit_log_path: joinAuditPath(args.project_root),
        corrupt_backup_path,
        agent_instructions: corrupt_backup_path
          ? `.toolcairn/config.json was unparseable — moved to ${corrupt_backup_path}. Call toolcairn_init with the project_root to re-discover and write a fresh config.`
          : 'No .toolcairn/config.json present. Call toolcairn_init with the project_root to auto-discover the project and bootstrap the config.',
      });
    }

    // If the file is older than v1.2, lazily migrate through mutateConfig
    // (atomic under the lock — handles the full v1.0→v1.1→v1.2 cascade).
    let config: ToolPilotProjectConfig = initial;
    let migrated = false;
    if (initial.version === '1.0' || initial.version === '1.1') {
      const result = await mutateConfig(
        args.project_root,
        () => {
          // No-op mutator — migrate* functions inside mutateConfig handle the upgrade.
        },
        {
          action: 'migrate',
          tool: '__schema__',
          reason: `Lazy migration on first read: ${initial.version} → 1.2`,
        },
      );
      config = result.config;
      migrated = true;
    }

    const confirmedToolNames = config.tools.confirmed.map((t) => t.name);
    const pendingToolNames = config.tools.pending_evaluation.map((t) => t.name);

    const staleTools = config.tools.confirmed
      .filter((t) => {
        const date = t.last_verified ?? t.chosen_at ?? t.confirmed_at;
        return date ? daysSince(date) > STALENESS_THRESHOLD_DAYS : true;
      })
      .map((t) => {
        const date = t.last_verified ?? t.chosen_at ?? t.confirmed_at;
        const days = date ? Math.round(daysSince(date)) : -1;
        return {
          name: t.name,
          last_verified: date ?? 'unknown',
          days_since_verified: days,
          recommendation: 'Consider using check_issue to verify no new known issues',
        };
      });

    const non_oss_tools = config.tools.confirmed
      .filter((t) => t.source === 'non_oss')
      .map((t) => t.name);

    // v1.2+: un-suggested candidates for `suggest_graph_update`. Persisted in
    // the config so the drain protocol survives process restarts.
    const unknown_tools = (config.tools.unknown_in_graph ?? []).filter((t) => !t.suggested);

    // v1.2.1+: derive pending outcomes from the audit log so the agent sees,
    // at session start, every recommendation it still owes a report_outcome on.
    // Best-effort: a missing or malformed audit log returns [] silently.
    let pending_outcomes: PendingOutcome[] = [];
    try {
      const auditEntries = await readLiveAudit(args.project_root);
      pending_outcomes = derivePendingOutcomes(auditEntries);
    } catch (err) {
      logger.debug({ err }, 'pending_outcomes derivation skipped (audit-log unreadable)');
    }

    // Indexed tools: source === 'toolcairn' (current) or 'toolpilot' (legacy pre-rename)
    const toolcairn_indexed_tools = config.tools.confirmed
      .filter((t) => t.source === 'toolcairn' || t.source === 'toolpilot')
      .map((t) => t.name);

    const include_locations = args.include_locations === true;
    const confirmed_tools_detail = include_locations
      ? config.tools.confirmed.map((t: ConfirmedTool) => ({
          name: t.name,
          source: t.source,
          canonical_name: t.canonical_name,
          categories: t.categories ?? [],
          match_method: t.match_method ?? 'none',
          github_url: t.github_url,
          locations: t.locations ?? [],
        }))
      : undefined;

    const instructions_lines = [
      `Project: ${config.project.name}`,
      config.project.languages && config.project.languages.length > 0
        ? `Languages: ${config.project.languages.map((l) => `${l.name} (${l.file_count} files)`).join(', ')}`
        : '',
      config.project.frameworks && config.project.frameworks.length > 0
        ? `Frameworks: ${config.project.frameworks.map((f) => `${f.name}@${f.workspace}`).join(', ')}`
        : '',
      `Confirmed tools (${confirmedToolNames.length}): ${confirmedToolNames.join(', ') || 'none'}`,
      'When recommending tools, skip any already in confirmed_tools.',
      non_oss_tools.length > 0
        ? `Non-OSS tools in project (handle separately): ${non_oss_tools.join(', ')}`
        : '',
      staleTools.length > 0
        ? `Tools that may be stale — worth re-checking: ${staleTools.map((t) => t.name).join(', ')}`
        : '',
      unknown_tools.length > 0
        ? `Unknown-to-graph tools awaiting submission (${unknown_tools.length}): ${unknown_tools
            .map((t) => t.name)
            .join(
              ', ',
            )}. BEFORE answering the user, call suggest_graph_update (suggestion_type="new_tool", data.tools=<this list>) to STAGE them for admin review, then update_project_config action="mark_suggestions_sent" with the successful tool_names.`
        : '',
      pending_outcomes.length > 0
        ? `Pending outcomes (${pending_outcomes.length}) — recommendations the user used but you have not yet reported on. As soon as the user uses (or replaces) one of the suggested tools, call report_outcome with the matching query_id: ${pending_outcomes
            .map(
              (p) =>
                `${p.query_id} (${p.mcp_tool}, ${p.age_hours}h ago${p.candidates.length > 0 ? `, candidates: ${p.candidates.slice(0, 3).join('/')}` : ''})`,
            )
            .join('; ')}.`
        : '',
    ].filter(Boolean);

    return okResult({
      status: 'ready',
      schema_version: config.version,
      migrated,
      project: {
        name: config.project.name,
        languages: config.project.languages ?? [],
        frameworks: config.project.frameworks ?? [],
        subprojects: config.project.subprojects ?? [],
      },
      confirmed_tools: confirmedToolNames,
      pending_tools: pendingToolNames,
      non_oss_tools,
      toolcairn_indexed_tools,
      stale_tools: staleTools,
      unknown_tools,
      total_confirmed: confirmedToolNames.length,
      total_pending: pendingToolNames.length,
      total_unknown_undrained: unknown_tools.length,
      pending_outcomes,
      total_pending_outcomes: pending_outcomes.length,
      last_audit_entry: config.last_audit_entry ?? null,
      scan_metadata: config.scan_metadata ?? null,
      confirmed_tools_detail,
      agent_instructions: instructions_lines.join('\n'),
    });
  } catch (e) {
    logger.error({ err: e }, 'read_project_config failed');
    return errResult('read_config_error', e instanceof Error ? e.message : String(e));
  }
}
