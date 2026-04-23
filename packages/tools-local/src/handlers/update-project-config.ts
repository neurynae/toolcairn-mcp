import { createMcpLogger } from '@toolcairn/errors';
import type { ConfirmedTool, PendingTool, ToolSource } from '@toolcairn/types';
import { type PendingAuditEntry, mutateConfig } from '../config-store/index.js';
import { errResult, okResult } from '../utils.js';

const logger = createMcpLogger({ name: '@toolcairn/tools:update-project-config' });

type UpdateAction =
  | 'add_tool'
  | 'remove_tool'
  | 'update_tool'
  | 'add_evaluation'
  | 'mark_suggestions_sent';

export async function handleUpdateProjectConfig(args: {
  project_root: string;
  action: UpdateAction;
  /** Required for every action EXCEPT mark_suggestions_sent (uses data.tool_names[]). */
  tool_name?: string;
  data?: Record<string, unknown>;
}) {
  try {
    logger.info(
      { project_root: args.project_root, action: args.action, tool: args.tool_name },
      'update_project_config called',
    );

    const data = args.data ?? {};

    // mark_suggestions_sent uses data.tool_names[] (batch), everything else is per-tool.
    const isBatchMark = args.action === 'mark_suggestions_sent';
    const toolNames: string[] = isBatchMark
      ? Array.isArray(data.tool_names)
        ? (data.tool_names as unknown[]).filter((t): t is string => typeof t === 'string')
        : []
      : [];

    if (!isBatchMark && !args.tool_name) {
      return errResult(
        'missing_field',
        `tool_name is required for action "${args.action}"`,
      );
    }
    if (isBatchMark && toolNames.length === 0) {
      return errResult(
        'missing_field',
        'mark_suggestions_sent requires data.tool_names: string[] with at least one entry',
      );
    }

    let notFound = false;
    let markedCount = 0;
    const now = new Date().toISOString();

    const audit: PendingAuditEntry = {
      action: args.action,
      tool: isBatchMark
        ? `__batch__:${toolNames.length}`
        : (args.tool_name as string),
      reason:
        (data.reason as string | undefined) ??
        (data.chosen_reason as string | undefined) ??
        defaultReasonFor(args.action),
    };

    const { config, audit_entry, bootstrapped } = await mutateConfig(
      args.project_root,
      (cfg) => {
        switch (args.action) {
          case 'add_tool': {
            const toolName = args.tool_name as string;
            cfg.tools.pending_evaluation = cfg.tools.pending_evaluation.filter(
              (t) => t.name !== toolName,
            );
            if (!cfg.tools.confirmed.some((t) => t.name === toolName)) {
              const tool: ConfirmedTool = {
                name: toolName,
                source: (data.source as ToolSource) ?? 'toolcairn',
                github_url: data.github_url as string | undefined,
                version: data.version as string | undefined,
                chosen_at: now,
                chosen_reason: (data.chosen_reason as string) ?? 'Selected via ToolCairn',
                alternatives_considered: (data.alternatives_considered as string[]) ?? [],
                query_id: data.query_id as string | undefined,
                notes: data.notes as string | undefined,
                locations: [],
              };
              cfg.tools.confirmed.push(tool);
            }
            break;
          }
          case 'remove_tool': {
            const toolName = args.tool_name as string;
            cfg.tools.confirmed = cfg.tools.confirmed.filter((t) => t.name !== toolName);
            cfg.tools.pending_evaluation = cfg.tools.pending_evaluation.filter(
              (t) => t.name !== toolName,
            );
            break;
          }
          case 'update_tool': {
            const toolName = args.tool_name as string;
            const idx = cfg.tools.confirmed.findIndex((t) => t.name === toolName);
            if (idx === -1) {
              notFound = true;
              return;
            }
            const existing = cfg.tools.confirmed[idx];
            if (!existing) {
              notFound = true;
              return;
            }
            cfg.tools.confirmed[idx] = {
              ...existing,
              ...(data.version !== undefined ? { version: data.version as string } : {}),
              ...(data.notes !== undefined ? { notes: data.notes as string } : {}),
              ...(data.chosen_reason !== undefined
                ? { chosen_reason: data.chosen_reason as string }
                : {}),
              ...(data.alternatives_considered !== undefined
                ? { alternatives_considered: data.alternatives_considered as string[] }
                : {}),
              last_verified: now,
            };
            break;
          }
          case 'add_evaluation': {
            const toolName = args.tool_name as string;
            const inConfirmed = cfg.tools.confirmed.some((t) => t.name === toolName);
            const inPending = cfg.tools.pending_evaluation.some((t) => t.name === toolName);
            if (!inConfirmed && !inPending) {
              const pending: PendingTool = {
                name: toolName,
                category: (data.category as string) ?? 'other',
                added_at: now,
              };
              cfg.tools.pending_evaluation.push(pending);
            }
            break;
          }
          case 'mark_suggestions_sent': {
            const list = cfg.tools.unknown_in_graph ?? [];
            const wanted = new Set(toolNames);
            for (const entry of list) {
              if (wanted.has(entry.name) && !entry.suggested) {
                entry.suggested = true;
                entry.suggested_at = now;
                markedCount++;
              }
            }
            cfg.tools.unknown_in_graph = list;
            break;
          }
        }
      },
      audit,
    );

    if (notFound) {
      return errResult(
        'not_found',
        `Tool "${args.tool_name}" is not in the confirmed list — cannot update.`,
      );
    }

    return okResult({
      action_applied: args.action,
      tool_name: args.tool_name,
      tool_names: isBatchMark ? toolNames : undefined,
      marked_count: isBatchMark ? markedCount : undefined,
      undrained_unknown_count: (config.tools.unknown_in_graph ?? []).filter(
        (t) => !t.suggested,
      ).length,
      confirmed_count: config.tools.confirmed.length,
      pending_count: config.tools.pending_evaluation.length,
      last_audit_entry: audit_entry,
      bootstrapped,
      config_path: '.toolcairn/config.json',
      audit_log_path: '.toolcairn/audit-log.jsonl',
    });
  } catch (e) {
    logger.error({ err: e }, 'update_project_config failed');
    return errResult('update_config_error', e instanceof Error ? e.message : String(e));
  }
}

function defaultReasonFor(action: UpdateAction): string {
  switch (action) {
    case 'add_tool':
      return 'Added via ToolCairn recommendation';
    case 'remove_tool':
      return 'Removed from project';
    case 'update_tool':
      return 'Tool details updated';
    case 'add_evaluation':
      return 'Added for evaluation';
    case 'mark_suggestions_sent':
      return 'Agent successfully staged unknown tools via suggest_graph_update';
  }
}
