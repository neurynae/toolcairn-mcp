import { createMcpLogger } from '@toolcairn/errors';
import { type AutoInitResult, autoInitProject } from '../auto-init.js';
import type { BatchResolveFn } from '../discovery/index.js';
import type { AgentType } from '../templates/agent-instructions.js';
import { errResult, okResult } from '../utils.js';

const logger = createMcpLogger({ name: '@toolcairn/tools:toolcairn-init' });

export interface HandleToolcairnInitDeps {
  /** Injected resolver — the server wires this to ToolCairnClient.batchResolve. */
  batchResolve?: BatchResolveFn;
}

/**
 * Thin MCP wrapper around `autoInitProject`.
 *
 * Most real-world flows now trigger auto-init automatically from the auth
 * handler (see apps/mcp-server/src/handlers/post-auth-init.ts) so the agent
 * never has to call this tool on first use. It remains exposed for two cases:
 *   1. Manual re-scan triggered by the agent after the user reorganises their
 *      project layout.
 *   2. Explicit targeting of a project root that isn't under the MCP server's
 *      CWD (e.g. agent invokes it with an absolute path pointing elsewhere).
 */
export async function handleToolcairnInit(
  args: {
    agent: AgentType;
    project_root: string;
    server_path?: string;
  },
  deps: HandleToolcairnInitDeps = {},
) {
  try {
    logger.info({ agent: args.agent, project_root: args.project_root }, 'toolcairn_init called');

    const result: AutoInitResult = await autoInitProject({
      projectRoot: args.project_root,
      agent: args.agent,
      batchResolve: deps.batchResolve,
      serverPath: args.server_path,
      reason: 'Explicit toolcairn_init call from agent',
    });

    return okResult({
      agent: args.agent,
      instruction_file: result.instruction_file,
      config_path: result.config_path,
      audit_log_path: result.audit_log_path,
      events_path: result.events_path,
      mcp_config_entry: result.mcp_config_entry,
      setup_steps: result.setup_steps,
      scan_summary: result.scan_summary,
      bootstrapped: result.bootstrapped,
      migrated: result.migrated,
      last_audit_entry: result.last_audit_entry,
      unknown_tools: result.unknown_tools,
      first_turn_directive: firstTurnDirectiveFor(result.unknown_tools.length),
      next_steps:
        'Config written. Apply setup_steps (CLAUDE.md / .mcp.json / .gitignore). If unknown_tools is non-empty, drain it via suggest_graph_update (batch) + update_project_config action="mark_suggestions_sent" before responding to the user.',
    });
  } catch (e) {
    logger.error({ err: e }, 'toolcairn_init failed');
    return errResult('init_error', e instanceof Error ? e.message : String(e));
  }
}

function firstTurnDirectiveFor(unknownCount: number): string {
  if (unknownCount === 0) return '';
  return [
    `The scan found ${unknownCount} tool(s) not currently in the ToolCairn graph.`,
    'BEFORE responding to the user, call `suggest_graph_update` with suggestion_type="new_tool"',
    'and `data.tools = <unknown_tools array>` to STAGE them for admin review (they do NOT go live',
    'until approved). Then call `update_project_config` action="mark_suggestions_sent" with the',
    'tool_names that staged successfully.',
  ].join(' ');
}
