// Agent instruction templates for toolcairn_init.
// Each function returns the section content to inject into the agent's instruction file.
// The agent writes the content to the appropriate file — MCP server never touches the filesystem.

export type AgentType =
  | 'claude'
  | 'cursor'
  | 'windsurf'
  | 'copilot'
  | 'copilot-cli'
  | 'opencode'
  | 'generic';

interface InstructionTemplate {
  /** Target file path relative to project root */
  file_path: string;
  /** Whether to append to or create the file */
  mode: 'append' | 'create';
  /** Content to write/append */
  content: string;
}

// On Windows, npx is a .cmd shim — Claude Code + many MCP clients require a
// `cmd /c` wrapper to spawn it. Detect the target host at server runtime.
const IS_WINDOWS = process.platform === 'win32';

const TOOLCAIRN_MCP_ENTRY = IS_WINDOWS
  ? {
      toolcairn: {
        command: 'cmd',
        args: ['/c', 'npx', '-y', '@neurynae/toolcairn-mcp'],
      },
    }
  : {
      toolcairn: {
        command: 'npx',
        args: ['-y', '@neurynae/toolcairn-mcp'],
      },
    };

/**
 * Auxiliary tooling guidance, written as a marker-fenced block so it can be
 * appended to ANY existing agent-instructions file without clobbering the
 * user's own primary instructions. On reconnect the writer (auto-init.ts)
 * looks for the markers and replaces ONLY the block between them; outside
 * the block, the user's content is untouched.
 *
 * Style choices:
 *   - `###` heading (sub-section, not a top-level `##` competing with the
 *     user's primary headings).
 *   - HTML comment markers (Markdown-safe, render as nothing).
 *   - Imperative decision-flow steps (1 → 5) ahead of the reference table —
 *     the agent should know WHEN to call WHICH tool before knowing WHAT
 *     each tool does.
 *   - No fluff: every line carries a tool name or a constraint.
 */
const TOOLCAIRN_BLOCK_START = '<!-- toolcairn:start -->';
const TOOLCAIRN_BLOCK_END = '<!-- toolcairn:end -->';

const CORE_RULES = `${TOOLCAIRN_BLOCK_START}
<!-- ToolCairn MCP — 15-tool flow guide. Managed by @neurynae/toolcairn-mcp;
     do not edit between markers. -->

### ToolCairn — when to call which tool

Always consult ToolCairn before recommending a library / CLI / framework.

**Session entry.** Call \`toolcairn_auth\` once. The auth response auto-runs \`toolcairn_init\` for every project root under CWD; call \`toolcairn_init\` explicitly only when \`read_project_config\` returns \`not_initialized\`.

**Before answering ANY user request — per project root**

1. \`read_project_config\` — load the snapshot.
2. Drain non-empty \`unknown_tools[]\`: \`suggest_graph_update\` (stages them for admin review) → \`update_project_config\` action \`mark_suggestions_sent\`.
3. Each \`pending_outcomes[]\` entry still owes a \`report_outcome\` — fire it as soon as the underlying tool is used.

**Use the on-disk state, not just MCP tools**

\`.toolcairn/\` is a local knowledge base — read it freely, never write directly (mutations go through \`update_project_config\`).

- \`.toolcairn/config.json\` → \`tools.confirmed[]\` carries every tool's full enrichment: \`description\`, \`license\`, \`homepage_url\`, \`docs.{readme_url,docs_url,api_url,changelog_url}\`, \`package_managers[].install_commands[]\`, \`version\` (resolved from the lockfile), \`categories\`, \`locations[]\` (workspaces + manifest paths). When the user asks "how do I install X?", "where are X's docs?", "what version of X are we on?", "where is X used?" — read config.json. Do NOT call \`search_tools\` or hit the network.
- \`tools.unknown_in_graph[]\` tracks which candidates still owe \`suggest_graph_update\` (\`suggested:true\` is already drained).
- \`project.subprojects[]\` + per-tool \`locations[]\` reveal monorepo layout — pick the right \`project_root\` before mutating.
- \`.toolcairn/audit-log.jsonl\` is the append-only journal — tail it to recover a recent \`query_id\` or de-dup against an identical recent search.

**Per user request**

1. \`classify_prompt\` to decide if ToolCairn is needed at all. Branch on the returned classification:
2. \`tool_discovery\` (one specific need) → \`search_tools\`. If the response asks clarification questions → \`search_tools_respond\` (loop until complete).
3. \`stack_building\` (multi-layer "build me a …") → \`refine_requirement\` → feed its \`sub_needs\` into \`get_stack\`.
4. \`tool_comparison\` ("X vs Y") → \`compare_tools\`.
5. Anything else → answer directly, ToolCairn isn't the right surface.

**Validate + persist (after the agent picks tools)**

1. \`verify_suggestion\` to confirm every pick exists in the graph; not-indexed picks route through \`suggest_graph_update\` instead of \`add_tool\`.
2. \`check_compatibility\` between picks when versions are uncertain.
3. \`update_project_config\` action \`add_tool\` for each accepted tool — record the \`query_id\` and \`chosen_reason\`.

**Close the loop**

- \`report_outcome\` after the user actually uses (or replaces) each tool. Fire-and-forget; never await.

**Last resort.** \`check_issue\` for known-bug lookup, ONLY after 4+ retries on the user's actual error and a docs review.

**Tracker.** Open \`.toolcairn/tracker.html\` in any browser — server-rewritten, auto-refreshes, shows every tool call + pending outcomes in real time.
${TOOLCAIRN_BLOCK_END}`;

export function getClaudeInstructions(): InstructionTemplate {
  return {
    file_path: 'CLAUDE.md',
    mode: 'append',
    content: CORE_RULES,
  };
}

export function getCursorInstructions(): InstructionTemplate {
  return {
    file_path: '.cursorrules',
    mode: 'append',
    content: CORE_RULES,
  };
}

export function getWindsurfInstructions(): InstructionTemplate {
  return {
    file_path: '.windsurfrules',
    mode: 'append',
    content: CORE_RULES,
  };
}

export function getCopilotInstructions(): InstructionTemplate {
  return {
    file_path: '.github/copilot-instructions.md',
    mode: 'append',
    content: CORE_RULES,
  };
}

export function getCopilotCliInstructions(): InstructionTemplate {
  return {
    file_path: '.github/copilot-instructions.md',
    mode: 'append',
    content: CORE_RULES,
  };
}

export function getOpenCodeInstructions(): InstructionTemplate {
  return {
    file_path: 'AGENTS.md',
    mode: 'append',
    content: CORE_RULES,
  };
}

export function getGenericInstructions(): InstructionTemplate {
  return {
    file_path: 'AI_INSTRUCTIONS.md',
    mode: 'append',
    content: CORE_RULES,
  };
}

/** Marker constants shared with the writer in `auto-init.ts`. */
export const INSTRUCTION_BLOCK_START = TOOLCAIRN_BLOCK_START;
export const INSTRUCTION_BLOCK_END = TOOLCAIRN_BLOCK_END;
/**
 * Pre-marker (v0.10.x) heading the writer matches when migrating an old
 * unmanaged file to the new managed-block layout. If a CLAUDE.md still
 * starts the toolcairn section with this exact heading we trim from there
 * to end-of-file before appending the marker block.
 */
export const LEGACY_HEADING = '## ToolCairn MCP — Tool Intelligence';

export function getInstructionsForAgent(agent: AgentType): InstructionTemplate {
  switch (agent) {
    case 'claude':
      return getClaudeInstructions();
    case 'cursor':
      return getCursorInstructions();
    case 'windsurf':
      return getWindsurfInstructions();
    case 'copilot':
      return getCopilotInstructions();
    case 'copilot-cli':
      return getCopilotCliInstructions();
    case 'opencode':
      return getOpenCodeInstructions();
    case 'generic':
      return getGenericInstructions();
  }
}

export function getMcpConfigEntry(serverPath?: string): Record<string, unknown> {
  if (serverPath) {
    // Running a locally-built server: node <path> works cross-platform, no wrapper needed
    return {
      toolcairn: {
        command: 'node',
        args: [serverPath],
      },
    };
  }
  return TOOLCAIRN_MCP_ENTRY;
}

/** Returns OpenCode-specific MCP config (opencode.json format under "mcp" key). */
export function getOpenCodeMcpEntry(serverPath?: string): Record<string, unknown> {
  if (serverPath) {
    return {
      toolcairn: {
        type: 'local',
        command: ['node', serverPath],
        enabled: true,
      },
    };
  }
  const command = IS_WINDOWS
    ? ['cmd', '/c', 'npx', '-y', '@neurynae/toolcairn-mcp']
    : ['npx', '-y', '@neurynae/toolcairn-mcp'];
  return {
    toolcairn: {
      type: 'local',
      command,
      enabled: true,
    },
  };
}
