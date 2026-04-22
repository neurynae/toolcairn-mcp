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
## ToolCairn — Tool Intelligence MCP

ToolCairn is your tool intelligence co-pilot. It has a graph database of 500+ indexed tools with health signals, compatibility data, and known issue tracking. Always use it before recommending any tool, library, or framework.

### The Server Owns .toolcairn/ (v0.10.0+)

The MCP server reads and writes \`.toolcairn/config.json\` and
\`.toolcairn/audit-log.jsonl\` atomically under a cross-process lock.
NEVER read or write these files directly — call the MCP tools instead.

### Workflow for Tool Selection

1. **Session start**: Call \`read_project_config\` with the project_root. If it returns
   \`status: "not_initialized"\`, call \`toolcairn_init\` which auto-discovers the stack
   (parses manifests across 12 ecosystems, classifies against the ToolCairn graph, and
   writes \`.toolcairn/config.json\`). Then apply the returned setup_steps for CLAUDE.md
   + .mcp.json + .gitignore.
2. **Before recommending any tool**: Call \`search_tools\` first. Never recommend from
   training data alone.
3. **When user describes a use case**: Call \`classify_prompt\`, then \`refine_requirement\`
   if tool selection is needed.
4. **When a tool is selected / replaced / dropped**: Call \`update_project_config\` with
   project_root + action — the server atomically updates config.json and appends to
   audit-log.jsonl.
5. **When encountering an error with a tool**: Call \`check_issue\` before debugging —
   it may be a known issue with an open GitHub ticket.
6. **When user asks to compare tools**: Call \`compare_tools\`.
7. **When user chooses a non-indexed/proprietary tool**: Call \`update_project_config\`
   with \`data: { source: "non_oss" }\`.

### Available ToolCairn MCP Tools

| Tool | When to use |
|------|------------|
| \`classify_prompt\` | User describes a task — determine if tool search needed |
| \`refine_requirement\` | Decompose vague use case into searchable tool needs |
| \`search_tools\` | Find the best tool for a specific need |
| \`search_tools_respond\` | Answer clarification questions from search_tools |
| \`get_stack\` | Get recommended tool stack for a use case |
| \`check_issue\` | Check if an error is a known tool bug before debugging |
| \`check_compatibility\` | Check if two tools work well together |
| \`compare_tools\` | Compare two tools with health and graph data |
| \`report_outcome\` | Report whether a recommended tool worked (improves future results) |
| \`toolcairn_init\` | One-call project bootstrap (auto-discovers + writes config.json) |
| \`read_project_config\` | Read .toolcairn/config.json from disk (returns structured snapshot) |
| \`update_project_config\` | Apply a mutation (add_tool / remove_tool / update_tool / add_evaluation) |
| \`suggest_graph_update\` | Suggest a new tool or relationship for the ToolCairn graph |

### Rules

- NEVER recommend a tool without first checking ToolCairn unless the tool is already in the project config
- Always call \`read_project_config\` at the start of a session
- NEVER write to .toolcairn/config.json or .toolcairn/audit-log.jsonl yourself — the server owns them
- Prefer open-source tools from ToolCairn index; flag proprietary alternatives clearly
- After selecting a tool, always call \`update_project_config\` to persist it
- After using a tool successfully/unsuccessfully, call \`report_outcome\`
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
