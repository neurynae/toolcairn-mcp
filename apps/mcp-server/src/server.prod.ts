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
  getStackSchema,
  handleClassifyPrompt,
  handleInitProjectConfig,
  handleReadProjectConfig,
  handleToolcairnInit,
  handleUpdateProjectConfig,
  initProjectConfigSchema,
  readProjectConfigSchema,
  refineRequirementSchema,
  reportOutcomeSchema,
  searchToolsRespondSchema,
  searchToolsSchema,
  suggestGraphUpdateSchema,
  toolpilotInitSchema,
  updateProjectConfigSchema,
  verifySuggestionSchema,
} from '@toolcairn/tools-local';
import { z } from 'zod';
import { withEventLogging } from './middleware/event-logger.js';

const logger = createMcpLogger({ name: '@toolcairn/mcp-server:prod' });

const SETUP_INSTRUCTIONS = `
# ToolCairn — Agent Setup Instructions

You are connected to the ToolCairn MCP server. ToolCairn is your active tool intelligence co-pilot.

## On Every Session Start — Do This First

Read \`.toolcairn/config.json\` in the project root. The server auto-creates this file on startup,
so it will almost always exist — but it may be an empty scaffold that still needs configuration.

### Case 1 — File does NOT exist (rare: read-only filesystem or manual deletion):
1. List the project root files (package.json, requirements.txt, CLAUDE.md, .cursorrules, .mcp.json, etc.)
2. Call \`toolcairn_init\` with your agent type, project root path, and the list of detected files.
3. Call \`init_project_config\` — pass project name, language, framework, and any tools you detect.
4. Write the returned \`config_json\` to \`.toolcairn/config.json\`.

### Case 2 — File EXISTS but \`project.name\` is empty (auto-created scaffold — not yet configured):
The server wrote the file at startup. You still need to fill in the project details:
1. List the project root files to detect the tech stack.
2. Call \`toolcairn_init\` with your agent type, project root, and detected files.
   This appends ToolCairn rules to CLAUDE.md (or equivalent) and sets up the tracker.
3. Call \`init_project_config\` with the project name, language, framework, and detected tools.
4. Write the returned \`config_json\` to \`.toolcairn/config.json\` (overwrites the empty scaffold).

### Case 3 — File EXISTS and \`project.name\` is set (returning to a configured project):
1. Call \`read_project_config\` with the file content.
2. If \`stale_tools\` is non-empty, inform the user and offer to re-verify those tools.
3. If \`pending_evaluation\` is non-empty, offer to run \`search_tools\` or \`compare_tools\`.

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
   * Composes event logging + error handling around a tool handler.
   * Execution order: withEventLogging → withErrorHandling → handler
   * This ensures events are always recorded even when errors occur.
   *
   * Uses Record<string, unknown> at the composition boundary — individual
   * handlers still receive the validated args from their own Zod schemas.
   */
  type AnyHandler = (
    args: Record<string, unknown>,
  ) => Promise<import('@modelcontextprotocol/sdk/types.js').CallToolResult>;
  function wrap(toolName: string, fn: AnyHandler) {
    return withEventLogging(toolName, withErrorHandling(toolName, logger, fn));
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
        'Set up ToolCairn integration for the current project. Generates agent instruction content, MCP config entry, and project config initializer.',
      inputSchema: toolpilotInitSchema,
    },
    wrap('toolcairn_init', async (args) =>
      handleToolcairnInit(args as Parameters<typeof handleToolcairnInit>[0]),
    ),
  );

  server.registerTool(
    'init_project_config',
    {
      description:
        'Initialize a .toolcairn/config.json file for the current project. Returns the config JSON for the agent to write to disk.',
      inputSchema: initProjectConfigSchema,
    },
    wrap('init_project_config', async (args) =>
      handleInitProjectConfig(args as Parameters<typeof handleInitProjectConfig>[0]),
    ),
  );

  server.registerTool(
    'read_project_config',
    {
      description:
        'Parse and validate a .toolcairn/config.json file. Returns confirmed tools, pending evaluations, stale tools, and agent instructions.',
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
        'Apply a mutation to .toolcairn/config.json and return the updated content. Actions: add_tool, remove_tool, update_tool, add_evaluation.',
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
        'Build a complementary tool stack for a project use case. For best results, call refine_requirement first with classification "stack_building", evaluate its decomposition_prompt to get sub-needs, then pass each {sub_need_type, keyword_sentence} object as a sub_needs entry. This lets get_stack keyword-match per layer (e.g. "web-framework", "database", "auth") instead of one broad search. Falls back to balanced search when sub_needs is omitted.',
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
    async ({ action }) => {
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
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                message: `Successfully authenticated as ${user.email}. All tools are now authorized.`,
                user_email: user.email,
                user_name: user.name,
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
    },
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
