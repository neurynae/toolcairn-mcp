/**
 * MCP Audit-Log Middleware
 *
 * Records every MCP tool invocation as a `tool_call` audit entry in the
 * project's `.toolcairn/audit-log.jsonl`. This complements the engine-side
 * event logger (which streams to the API) with a permanent, replayable,
 * per-project timeline that survives across sessions and powers
 * read_project_config's `pending_outcomes[]` derivation.
 *
 * Side mission: for recommendation tools (search_tools / get_stack /
 * refine_requirement), inject a `next_action` reminder into the response
 * payload so the agent sees, at the moment of receiving the query_id, the
 * exact follow-up call (`report_outcome`) it owes.
 *
 * All disk writes are best-effort and fire-and-forget — never block a
 * tool response, never throw out of the middleware.
 */

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createMcpLogger } from '@toolcairn/errors';
import { appendToolCallAudit } from '@toolcairn/tools-local';
import type { AuditOutcome, ConfigAuditEntry } from '@toolcairn/types';

const logger = createMcpLogger({ name: '@toolcairn/mcp-server:audit-logger' });

/** Cache resolved project_root per CWD for the process lifetime. */
const cwdRootCache = new Map<string, string | null>();

/** MCP tools that issue a `query_id` agents need to follow up on with report_outcome. */
const RECOMMENDATION_TOOLS = new Set([
  'search_tools',
  'search_tools_respond',
  'get_stack',
  'refine_requirement',
]);

/** MCP tools whose existence we never log (avoids feedback loops). */
const SKIP_AUDIT = new Set<string>([
  // Currently empty — but reserved if e.g. a heartbeat tool is added later.
]);

type ToolHandler<TArgs> = (args: TArgs) => Promise<CallToolResult>;

/**
 * Wraps a tool handler so every call appends one entry to
 * `<projectRoot>/.toolcairn/audit-log.jsonl`. Recommendation responses are
 * augmented with a `next_action` reminder string in-place.
 */
export function withAuditLog<TArgs extends Record<string, unknown>>(
  toolName: string,
  handler: ToolHandler<TArgs>,
): ToolHandler<TArgs> {
  return async (args: TArgs): Promise<CallToolResult> => {
    const start = Date.now();
    let result: CallToolResult | undefined;
    let status: 'ok' | 'error' = 'ok';
    let thrown: unknown;

    try {
      result = await handler(args);
      if (result.isError) status = 'error';
    } catch (err) {
      status = 'error';
      thrown = err;
    }

    const duration_ms = Date.now() - start;

    // ── Augment recommendation responses with a next_action reminder ─────────
    if (result && status === 'ok' && RECOMMENDATION_TOOLS.has(toolName)) {
      result = injectNextActionHint(result, toolName);
    }

    // ── Fire-and-forget audit append ────────────────────────────────────────
    if (!SKIP_AUDIT.has(toolName)) {
      const projectRoot = resolveProjectRoot(args);
      if (projectRoot) {
        const entry = buildEntry({
          toolName,
          args,
          result,
          status,
          duration_ms,
        });
        appendToolCallAudit(projectRoot, entry).catch((err) => {
          logger.debug({ err, toolName, projectRoot }, 'audit-log: append failed (non-fatal)');
        });
      }
    }

    if (thrown !== undefined) throw thrown;
    // result is always assigned in the try block above; undefined path is unreachable
    return result ?? { content: [], isError: true };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Project root resolution
// ─────────────────────────────────────────────────────────────────────────────

function resolveProjectRoot(args: Record<string, unknown>): string | null {
  // 1. Explicit project_root in args (toolcairn_init / read_project_config /
  //    update_project_config and anything else passing one).
  const explicit = args.project_root;
  if (typeof explicit === 'string' && explicit.length > 0 && isAbsolute(explicit)) {
    return explicit;
  }

  // 2. Walk up from process.cwd() to the nearest .toolcairn/config.json.
  return findRootForCwd(process.cwd());
}

function findRootForCwd(cwd: string): string | null {
  const cached = cwdRootCache.get(cwd);
  if (cached !== undefined) return cached;

  let dir = resolve(cwd);
  // Stop at the filesystem root (parent === self).
  while (true) {
    if (existsSync(join(dir, '.toolcairn', 'config.json'))) {
      cwdRootCache.set(cwd, dir);
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      cwdRootCache.set(cwd, null);
      return null;
    }
    dir = parent;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit entry construction
// ─────────────────────────────────────────────────────────────────────────────

interface BuildEntryInput {
  toolName: string;
  args: Record<string, unknown>;
  result: CallToolResult | undefined;
  status: 'ok' | 'error';
  duration_ms: number;
}

function buildEntry(input: BuildEntryInput): ConfigAuditEntry {
  const { toolName, args, result, status, duration_ms } = input;

  const argQueryId = typeof args.query_id === 'string' ? args.query_id : undefined;
  const data = result ? extractResultData(result) : undefined;
  const responseQueryId = typeof data?.query_id === 'string' ? data.query_id : undefined;
  const query_id = argQueryId ?? responseQueryId;

  // Decide what to put in the `tool` slot for this tool_call entry — we want
  // the most useful one-word handle for log-grepping.
  const tool = pickToolLabel(toolName, args, data);

  // Tool-specific extractions
  const outcome = pickOutcome(toolName, args);
  const replaced_by = pickReplacedBy(toolName, args);
  const candidates = pickCandidates(toolName, data);
  const metadata = buildMetadata(toolName, args, data);

  const reason = buildReason(toolName, args, status);

  const entry: ConfigAuditEntry = {
    action: 'tool_call',
    tool,
    timestamp: new Date().toISOString(),
    reason,
    mcp_tool: toolName,
    duration_ms,
    status,
  };
  if (query_id) entry.query_id = query_id;
  if (outcome) entry.outcome = outcome;
  if (replaced_by) entry.replaced_by = replaced_by;
  if (candidates && candidates.length > 0) entry.candidates = candidates;
  if (metadata && Object.keys(metadata).length > 0) entry.metadata = metadata;
  return entry;
}

function pickToolLabel(
  toolName: string,
  args: Record<string, unknown>,
  data: Record<string, unknown> | undefined,
): string {
  // For report_outcome the most useful identifier is the package being acted on.
  if (toolName === 'report_outcome' && typeof args.chosen_tool === 'string') {
    return args.chosen_tool;
  }
  // For per-tool inspection calls, prefer the package name.
  if (
    (toolName === 'check_compatibility' || toolName === 'compare_tools') &&
    typeof args.tool_a === 'string' &&
    typeof args.tool_b === 'string'
  ) {
    return `${args.tool_a}|${args.tool_b}`;
  }
  if (toolName === 'check_issue' && typeof args.tool_name === 'string') {
    return args.tool_name;
  }
  if (toolName === 'verify_suggestion' && Array.isArray(data?.verified)) {
    return '__verify__';
  }
  // Config mutation tools: surface the package name.
  if (toolName === 'update_project_config' && typeof args.tool_name === 'string') {
    return args.tool_name;
  }
  // Fallback: the MCP tool name itself.
  return `__call__:${toolName}`;
}

function pickOutcome(toolName: string, args: Record<string, unknown>): AuditOutcome | undefined {
  if (toolName !== 'report_outcome') return undefined;
  const v = args.outcome;
  if (v === 'success' || v === 'failure' || v === 'replaced' || v === 'pending') return v;
  return undefined;
}

function pickReplacedBy(toolName: string, args: Record<string, unknown>): string | undefined {
  if (toolName !== 'report_outcome') return undefined;
  return typeof args.replaced_by === 'string' ? args.replaced_by : undefined;
}

function pickCandidates(
  toolName: string,
  data: Record<string, unknown> | undefined,
): string[] | undefined {
  if (!data) return undefined;
  if (toolName === 'search_tools' || toolName === 'search_tools_respond') {
    const results = data.results;
    if (Array.isArray(results)) {
      const names = results
        .map((r) => (r && typeof r === 'object' ? (r as { name?: unknown }).name : undefined))
        .filter((n): n is string => typeof n === 'string')
        .slice(0, 5);
      return names.length > 0 ? names : undefined;
    }
  }
  if (toolName === 'get_stack') {
    const stack = data.stack;
    if (Array.isArray(stack)) {
      const names = stack
        .map((r) => (r && typeof r === 'object' ? (r as { name?: unknown }).name : undefined))
        .filter((n): n is string => typeof n === 'string')
        .slice(0, 10);
      return names.length > 0 ? names : undefined;
    }
  }
  return undefined;
}

function buildMetadata(
  toolName: string,
  args: Record<string, unknown>,
  data: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  // Lightweight, non-PII signals derived from args.
  if (typeof args.query === 'string') meta.query = truncate(args.query, 200);
  if (typeof args.use_case === 'string') meta.use_case = truncate(args.use_case, 200);
  if (typeof args.action === 'string') meta.config_action = args.action;
  if (typeof args.agent === 'string') meta.agent = args.agent;
  // Pull data signals if present (mirror event-logger summary fields).
  if (data) {
    if (typeof data.status === 'string') meta.response_status = data.status;
    if (typeof data.stage === 'number') meta.stage = data.stage;
    if (typeof data.is_two_option === 'boolean') meta.is_two_option = data.is_two_option;
    if (typeof data.compatibility_signal === 'string')
      meta.compatibility_signal = data.compatibility_signal;
    if (typeof data.recommendation === 'string') meta.recommendation = data.recommendation;
    if (typeof data.staged === 'number') meta.staged = data.staged;
  }
  return meta;
}

function buildReason(
  toolName: string,
  args: Record<string, unknown>,
  status: 'ok' | 'error',
): string {
  if (status === 'error') return `MCP tool ${toolName} failed`;
  if (toolName === 'report_outcome' && typeof args.outcome === 'string') {
    const chosen = typeof args.chosen_tool === 'string' ? args.chosen_tool : '?';
    return `report_outcome: ${chosen} → ${args.outcome}`;
  }
  if (toolName === 'search_tools' && typeof args.query === 'string') {
    return `search_tools: ${truncate(args.query, 120)}`;
  }
  if (toolName === 'get_stack' && typeof args.use_case === 'string') {
    return `get_stack: ${truncate(args.use_case, 120)}`;
  }
  if (toolName === 'update_project_config' && typeof args.action === 'string') {
    const tn = typeof args.tool_name === 'string' ? ` ${args.tool_name}` : '';
    return `update_project_config: ${args.action}${tn}`;
  }
  return `MCP tool ${toolName}`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Response augmentation: inject `next_action` for recommendation tools
// ─────────────────────────────────────────────────────────────────────────────

function injectNextActionHint(result: CallToolResult, toolName: string): CallToolResult {
  try {
    const first = result.content?.[0];
    if (!first || first.type !== 'text') return result;
    const parsed = JSON.parse(first.text) as Record<string, unknown>;
    const data = (parsed.data as Record<string, unknown> | undefined) ?? undefined;
    if (!data) return result;
    const queryId = typeof data.query_id === 'string' ? data.query_id : undefined;
    if (!queryId) return result;
    if (typeof data.next_action === 'string' && data.next_action.length > 0) return result;

    data.next_action = buildHint(toolName, queryId);
    parsed.data = data;
    return {
      ...result,
      content: [{ type: 'text', text: JSON.stringify(parsed) }],
    };
  } catch {
    // If parsing fails, return the original — we never want to mangle a response.
    return result;
  }
}

function buildHint(toolName: string, queryId: string): string {
  if (toolName === 'refine_requirement') {
    return `Use the decomposition to call get_stack or search_tools (passing query_id="${queryId}"); after the user actually uses the chosen tool, call report_outcome({ query_id: "${queryId}", chosen_tool, outcome }).`;
  }
  return `After the user actually uses one of the suggested tools (or replaces it), call report_outcome({ query_id: "${queryId}", chosen_tool, outcome }) to close the feedback loop.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Result-text JSON extraction (mirrors event-logger.ts)
// ─────────────────────────────────────────────────────────────────────────────

function extractResultData(result: CallToolResult): Record<string, unknown> | undefined {
  try {
    const first = result.content?.[0];
    if (!first || first.type !== 'text') return undefined;
    const parsed = JSON.parse(first.text) as Record<string, unknown>;
    const data = parsed.data;
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
