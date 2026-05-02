/**
 * Production MCP server — thin HTTP bridge.
 *
 * LOCAL tools (classify_prompt, *_config, toolcairn_init) run directly.
 * All other tools make a single HTTP call to the ToolCairn API via ToolCairnClient.
 *
 * This file is used when TOOLPILOT_MODE=production (npx @toolcairn/mcp).
 * It intentionally imports NOTHING from @toolcairn/graph, @toolcairn/search,
 * @toolcairn/vector, @toolcairn/db, or @toolcairn/queue so those packages
 * are not bundled into the published npm package.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config } from '@toolcairn/config';
import { createMcpLogger, withErrorHandling } from '@toolcairn/errors';
import {
  ToolCairnClient,
  clearAuthentication,
  isTokenValid,
  loadCredentials,
  startDeviceAuth,
} from '@toolcairn/remote';
// Use the /local subpath — excludes heavy DB/search/graph deps from the npm bundle.
// The full '@toolcairn/tools' CJS dist requires Prisma/neo4j/ioredis at load time
// even though prod mode never calls those code paths.
import {
  checkCompatibilitySchema,
  checkIssueSchema,
  classifyPromptSchema,
  compareToolsSchema,
  feedbackSchema,
  getStackSchema,
  handleClassifyPrompt,
  handleReadProjectConfig,
  handleToolcairnInit,
  handleUpdateProjectConfig,
  readProjectConfigSchema,
  refineRequirementSchema,
  reportOutcomeSchema,
  searchToolsRespondSchema,
  searchToolsSchema,
  suggestGraphUpdateSchema,
  toolcairnInitSchema,
  updateProjectConfigSchema,
  verifySuggestionSchema,
} from '@toolcairn/tools-local';
import { z } from 'zod';
import { withAuditLog } from './middleware/audit-logger.js';
import { withEventLogging } from './middleware/event-logger.js';
import { runPostAuthInit } from './post-auth-init.js';

const logger = createMcpLogger({ name: '@toolcairn/mcp-server:prod' });

const SETUP_INSTRUCTIONS = `
# ToolCairn — Agent Setup Instructions

You are connected to the ToolCairn MCP server. ToolCairn is your active tool intelligence co-pilot.

## The Server Owns .toolcairn/ (v0.10.0+)

The MCP server reads and writes \`.toolcairn/config.json\` + \`.toolcairn/audit-log.jsonl\`
atomically under a cross-process lock. You never touch those files directly.

## On Every Session Start — Do This First

Call \`read_project_config\` with \`project_root\` (absolute path to the user's project).

In most sessions config is already there: when the user ran \`toolcairn_auth\` the
server auto-discovered every project root under its CWD and ran the full 12-ecosystem
scan + graph classification + config write for each. The auth response carried back
per-root \`projects[]\` entries with \`setup_steps\` (CLAUDE.md / .mcp.json / .gitignore)
and \`unknown_tools[]\`.

- If \`read_project_config\` returns \`status: "not_initialized"\` for some root
  (rare — only when auto-init skipped that root): call \`toolcairn_init\` explicitly
  for that \`project_root\`.
- If it returns \`status: "ready"\`: you have the full snapshot — review
  \`stale_tools\` / \`pending_tools\` / \`unknown_tools\` and proceed.

## First-Turn Drain Protocol (REQUIRED before replying to the user)

If the auth response OR \`read_project_config\` returned non-empty \`unknown_tools[]\`
for a root, you MUST submit them before your first user-facing response:

1. \`suggest_graph_update\` with \`suggestion_type: "new_tool"\` and
   \`data.tools: <the full unknown_tools array for that root>\`. Entries are STAGED
   for admin review — they do NOT enter the live graph until approved.
2. \`update_project_config\` with \`action: "mark_suggestions_sent"\`,
   \`project_root\`, and \`data.tool_names: [names that staged successfully]\`.

In multi-root workspaces, repeat per root. This closes the learning loop so every
project contributes its OSS dependency tail back to the ToolCairn graph.

## Applying Mutations

When the user selects / replaces / drops a tool, call \`update_project_config\`
with \`project_root\`, \`action\` (add_tool / remove_tool / update_tool / add_evaluation),
and \`tool_name\`. The server:
- atomically updates \`.toolcairn/config.json\`,
- appends a new line to \`.toolcairn/audit-log.jsonl\` (FIFO-archived at 1000 entries),
- returns the new \`last_audit_entry\` for your record.

Do NOT construct or write these files yourself — you do not have the cross-process
lock that protects them.

## Schema Migration

Configs written by v0.9.x are on schema 1.0. The first \`read_project_config\` or
\`update_project_config\` call after upgrade migrates in place to 1.1 (languages →
array, frameworks → array, \`audit_log[]\` relocated from config.json to
audit-log.jsonl). The migration is logged as an audit entry.

## When to Use ToolCairn Tools

| Situation | Tool to call |
|-----------|-------------|
| User asks which tool to use for X | \`classify_prompt\` → \`refine_requirement\` → \`search_tools\` |
| User needs to compare two tools | \`compare_tools\` |
| User asks if tool A works with tool B | \`check_compatibility\` |
| Error persists after 4+ retries AND docs checked | \`check_issue\` |
| User asks for a recommended stack | \`get_stack\` |
| search_tools returns empty or low confidence | \`verify_suggestion\` |
| You discover a new tool relationship | \`suggest_graph_update\` |
| A tool worked well or was replaced | \`report_outcome\` |
| Tool added/removed from project | \`update_project_config\` |
`.trim();

/**
 * Register all 14 production tools (local + remote) on an existing McpServer.
 * Called either during buildProdServer() or dynamically after auth completes
 * on the waiting server — the MCP SDK notifies the client via
 * notifications/tools/list_changed so tools appear without reconnect.
 */
export async function addToolsToServer(server: McpServer): Promise<void> {
  const creds = await loadCredentials();
  if (!creds || !isTokenValid(creds)) {
    throw new Error('ToolCairn: authentication required.');
  }

  const remote = new ToolCairnClient({
    baseUrl: config.TOOLPILOT_API_URL,
    apiKey: creds.client_id,
    accessToken: creds.access_token,
  });

  logger.info({ user: creds.user_email }, 'Registering production tools');

  /**
   * Composes event logging + audit logging + error handling around a tool handler.
   * Execution order: withEventLogging → withAuditLog → withErrorHandling → handler
   *
   * - withErrorHandling normalises throws into error CallToolResults.
   * - withAuditLog appends a `tool_call` entry to .toolcairn/audit-log.jsonl
   *   (per-project, persistent) and can augment recommendation responses with
   *   a `next_action` reminder pointing back to report_outcome.
   * - withEventLogging streams timing/metadata to the engine event API.
   *
   * Uses Record<string, unknown> at the composition boundary — individual
   * handlers still receive the validated args from their own Zod schemas.
   */
  type AnyHandler = (
    args: Record<string, unknown>,
  ) => Promise<import('@modelcontextprotocol/sdk/types.js').CallToolResult>;
  function wrap(toolName: string, fn: AnyHandler) {
    return withEventLogging(
      toolName,
      withAuditLog(toolName, withErrorHandling(toolName, logger, fn)),
    );
  }

  // ── LOCAL tools (zero network, run on user's machine) ──────────────────────

  server.registerTool(
    'classify_prompt',
    {
      description:
        'Classify a developer prompt to determine if ToolCairn tool search is needed. Returns a structured classification prompt for the agent to evaluate.',
      inputSchema: classifyPromptSchema,
    },
    wrap('classify_prompt', async (args) =>
      handleClassifyPrompt(args as Parameters<typeof handleClassifyPrompt>[0]),
    ),
  );

  server.registerTool(
    'toolcairn_init',
    {
      description:
        'Bootstrap ToolCairn for the current project. Walks every workspace, parses manifests across 12 ecosystems, classifies tools against the ToolCairn graph, and writes .toolcairn/config.json + audit-log.jsonl atomically. Returns setup_steps for CLAUDE.md / .mcp.json / .gitignore (agent applies those).',
      inputSchema: toolcairnInitSchema,
    },
    wrap('toolcairn_init', async (args) =>
      handleToolcairnInit(args as Parameters<typeof handleToolcairnInit>[0], {
        batchResolve: (items) => remote.batchResolve(items),
      }),
    ),
  );

  server.registerTool(
    'read_project_config',
    {
      description:
        'Read .toolcairn/config.json from disk and return the structured project snapshot: project metadata, confirmed tools, stale tools, pending evaluations, and last audit entry. Auto-migrates v1.0 configs to v1.1 on first read.',
      inputSchema: readProjectConfigSchema,
    },
    wrap('read_project_config', async (args) =>
      handleReadProjectConfig(args as Parameters<typeof handleReadProjectConfig>[0]),
    ),
  );

  server.registerTool(
    'update_project_config',
    {
      description:
        'Apply a mutation to .toolcairn/config.json (add_tool / remove_tool / update_tool / add_evaluation). The server atomically rewrites config.json and appends a new line to audit-log.jsonl under a cross-process lock. Requires project_root.',
      inputSchema: updateProjectConfigSchema,
    },
    wrap('update_project_config', async (args) =>
      handleUpdateProjectConfig(args as Parameters<typeof handleUpdateProjectConfig>[0]),
    ),
  );

  // ── REMOTE tools (one HTTP call each to ToolCairn API) ────────────────────

  server.registerTool(
    'search_tools',
    {
      description:
        'Search for the best tool for a specific need using a natural language query. Initiates a guided discovery session with clarification questions when needed.',
      inputSchema: searchToolsSchema,
    },
    wrap('search_tools', async (args) => remote.searchTools(args)),
  );

  server.registerTool(
    'search_tools_respond',
    {
      description:
        'Submit clarification answers for an in-progress tool search session and receive refined results.',
      inputSchema: searchToolsRespondSchema,
    },
    wrap('search_tools_respond', async (args) => remote.searchToolsRespond(args)),
  );

  server.registerTool(
    'get_stack',
    {
      description:
        'Build a complementary tool stack for a project use case. For best results, call refine_requirement first with classification "stack_building", evaluate its decomposition_prompt to get sub-needs, then pass each {sub_need_type, keyword_sentence} object as a sub_needs entry. This lets get_stack keyword-match per layer (e.g. "web-framework", "database", "auth") instead of one broad search. Falls back to balanced search when sub_needs is omitted. Each tool in the returned stack also carries a `version` object with the recommended version that is cross-compatible with the rest of the stack (downgraded from latest if needed to satisfy peer constraints), plus a top-level `compatibility_matrix` + `stack_compatibility` summarising cross-tool version fit.',
      inputSchema: getStackSchema,
    },
    wrap('get_stack', async (args) => remote.getStack(args)),
  );

  server.registerTool(
    'check_compatibility',
    {
      description:
        'Check compatibility between two tools with version-aware matching. When both tools have declared dependency metadata (npm peerDependencies, PyPI requires_dist, etc.) the handler evaluates range constraints directly and returns a version_checks array plus runtime_requirements. Pass optional tool_a_version / tool_b_version to evaluate specific versions (e.g. "is next@14 compatible with react@17?"). Falls back to graph-edge + shared-neighbors inference when version metadata is unavailable. Response includes `source`: "declared_dependency" | "graph_edges" | "shared_neighbors".',
      inputSchema: checkCompatibilitySchema,
    },
    wrap('check_compatibility', async (args) => remote.checkCompatibility(args)),
  );

  server.registerTool(
    'compare_tools',
    {
      description:
        'Compare two tools head-to-head using health signals, graph relationships, and community data.',
      inputSchema: compareToolsSchema,
    },
    wrap('compare_tools', async (args) => remote.compareTools(args)),
  );

  server.registerTool(
    'refine_requirement',
    {
      description: 'Decompose a vague user use-case into specific, searchable tool requirements.',
      inputSchema: refineRequirementSchema,
    },
    wrap('refine_requirement', async (args) => remote.refineRequirement(args)),
  );

  server.registerTool(
    'check_issue',
    {
      description:
        'LAST RESORT — check GitHub Issues for a known error after 4+ retries and docs review.',
      inputSchema: checkIssueSchema,
    },
    wrap('check_issue', async (args) => remote.checkIssue(args)),
  );

  server.registerTool(
    'verify_suggestion',
    {
      description: 'Validate agent-suggested tools against the ToolCairn graph.',
      inputSchema: verifySuggestionSchema,
    },
    wrap('verify_suggestion', async (args) => remote.verifySuggestion(args)),
  );

  server.registerTool(
    'report_outcome',
    {
      description: 'Report the outcome of using a tool recommended by ToolCairn (fire-and-forget).',
      inputSchema: reportOutcomeSchema,
    },
    wrap('report_outcome', async (args) => remote.reportOutcome(args)),
  );

  server.registerTool(
    'suggest_graph_update',
    {
      description:
        'Suggest a new tool, relationship, use case, or health update to the ToolCairn graph.',
      inputSchema: suggestGraphUpdateSchema,
    },
    wrap('suggest_graph_update', async (args) => remote.suggestGraphUpdate(args)),
  );

  server.registerTool(
    'feedback',
    {
      description:
        "ONLY call when a ToolCairn response was wrong, broken, low-quality, or missed something obvious — NEVER for positive feedback or routine confirmation. Free (does not count toward daily quota), but spammy or duplicate calls are dropped server-side. Required: tool_name (which ToolCairn tool), severity (broken|wrong_result|low_quality|missing_capability|confusing), message (>=20 chars). Optional: query_id (link to the offending call), expected, actual. Fire-and-forget — do not await; the return value is just an ack.",
      inputSchema: feedbackSchema,
    },
    wrap('feedback', async (args) => remote.feedback(args)),
  );

  // ── AUTH tool (local — manages ~/.toolcairn/credentials.json) ─────────────

  server.registerTool(
    'toolcairn_auth',
    {
      description:
        'Manage your ToolCairn authentication. Use "login" to authenticate via browser (unlocks higher rate limits), "status" to check current auth state, or "logout" to revert to anonymous mode.',
      inputSchema: z.object({
        action: z
          .enum(['login', 'status', 'logout'])
          .describe(
            '"login" opens a browser to authenticate, "status" shows current auth state, "logout" clears authentication',
          ),
      }),
    },
    wrap('toolcairn_auth', async (rawArgs) => {
      const action = (rawArgs as { action: 'login' | 'status' | 'logout' }).action;
      if (action === 'status') {
        const c = await loadCredentials();
        const isAuth = c !== null && isTokenValid(c);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                authenticated: isAuth,
                user_email: c?.user_email ?? null,
                user_name: c?.user_name ?? null,
                authenticated_at: c?.authenticated_at ?? null,
              }),
            },
          ],
        };
      }

      if (action === 'logout') {
        await clearAuthentication();
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                message:
                  'Signed out. Restart your agent to sign in again — authentication will start automatically.',
              }),
            },
          ],
        };
      }

      // action === 'login'
      try {
        const user = await startDeviceAuth(config.TOOLPILOT_API_URL);
        // Auto-provision every discovered project root — one `.toolcairn/`
        // per sibling-repo root, workspace-member dedup'd. Best-effort: a
        // failed root never aborts the auth flow.
        const initSummary = await runPostAuthInit({ agent: 'claude' }).catch((err) => {
          logger.warn({ err }, 'runPostAuthInit failed post-login — auth still succeeds');
          return null;
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                message: `Successfully authenticated as ${user.email}. All tools are now authorized.`,
                user_email: user.email,
                user_name: user.name,
                roots_discovered: initSummary?.roots_discovered ?? [],
                projects: initSummary?.projects ?? [],
                unknown_tools_total: initSummary?.unknown_tools_total ?? 0,
                first_turn_directive: initSummary?.first_turn_directive ?? '',
              }),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Authentication failed';
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: msg }) }],
          isError: true,
        };
      }
    }),
  );
}

/**
 * Build a new fully-authenticated prod server.
 * Creates the McpServer then delegates tool registration to addToolsToServer().
 */
export async function buildProdServer(): Promise<McpServer> {
  const server = new McpServer(
    { name: 'toolcairn', version: '0.1.0' },
    { instructions: SETUP_INSTRUCTIONS },
  );
  await addToolsToServer(server);
  return server;
}
