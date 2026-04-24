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

const CORE_RULES = `
## ToolCairn MCP — Tool Intelligence

Graph-backed catalog of tools with health, compatibility, and issue data. Always consult before recommending a tool/library/framework. The server owns \`.toolcairn/config.json\` + \`audit-log.jsonl\` under a cross-process lock — never read/write these files directly; use the MCP tools.

### First-turn protocol

1. \`read_project_config({ project_root })\`. If \`status:"not_initialized"\`, call \`toolcairn_init\`. (Auto-init usually ran during \`toolcairn_auth\` already.)
2. **If \`unknown_tools[]\` is non-empty** — BEFORE replying to the user:
   - \`suggest_graph_update({ suggestion_type:"new_tool", data:{ tools: <unknown_tools array> } })\` — entries are STAGED for admin review, NOT live.
   - \`update_project_config({ action:"mark_suggestions_sent", data:{ tool_names: <names that staged ok> } })\`.
   - Repeat per root in monorepos (each has its own list).

### Tool reference

| Tool | Trigger |
|------|---------|
| \`classify_prompt\` | User describes a task — decide whether tool search is needed |
| \`refine_requirement\` | Decompose a use case into searchable sub-needs (required input for \`get_stack\`) |
| \`search_tools\` | Find the best tool for one specific need |
| \`search_tools_respond\` | Submit clarification answers for an in-progress search session |
| \`get_stack\` | Build a version-compatible multi-layer stack for a use case |
| \`compare_tools\` | Head-to-head comparison of two tools |
| \`check_compatibility\` | Version-aware compatibility check between two tools |
| \`check_issue\` | LAST RESORT — known-bug lookup after 4+ retries + docs review |
| \`verify_suggestion\` | Validate agent-picked tool names against the graph |
| \`report_outcome\` | Fire-and-forget feedback after using a recommended tool |
| \`suggest_graph_update\` | Stage a new tool / edge / use-case for admin review (never writes live) |
| \`toolcairn_init\` | Manual project re-scan (auto-init usually covers it) |
| \`read_project_config\` | Load project snapshot (confirmed, pending, unknown, stale, metadata) |
| \`update_project_config\` | Mutate confirmed tools or mark unknown suggestions sent |
| \`toolcairn_auth\` | Login / status / logout for ToolCairn credentials |

### Rules

- Never recommend a tool that isn't in \`confirmed_tools\` without first hitting \`search_tools\` / \`get_stack\`.
- After selecting a tool: \`update_project_config({ action:"add_tool", tool_name, data: {...} })\`. Pass \`data.source:"non_oss"\` for proprietary picks.
- After using a tool (success or failure): \`report_outcome\`.
- Use \`check_issue\` only after docs + 4 retries — it's network-heavy.
- Confirmed tools in config.json carry graph enrichment: \`description\`, \`license\`, \`homepage_url\`, \`docs.{readme_url,docs_url,api_url,changelog_url}\`, and \`package_managers[]\` with install commands. Prefer these over re-fetching.
- Suggestions are STAGED; admin approval gates live-graph promotion.
`;

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
    mode: 'create',
    content: `# GitHub Copilot Instructions\n${CORE_RULES}`,
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
    mode: 'create',
    content: `# AI Assistant Instructions\n${CORE_RULES}`,
  };
}

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
