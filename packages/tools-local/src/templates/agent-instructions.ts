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

const TOOLCAIRN_MCP_ENTRY = {
  toolcairn: {
    command: 'npx',
    args: ['-y', '@neurynae/toolcairn-mcp'],
  },
};

const CORE_RULES = `
## ToolCairn — Tool Intelligence MCP

ToolCairn is your tool intelligence co-pilot. It has a graph database of 500+ indexed tools with health signals, compatibility data, and known issue tracking. Always use it before recommending any tool, library, or framework.

### Workflow for Tool Selection

1. **Before recommending any tool**: Always call \`search_tools\` first. Never recommend from training data alone.
2. **When user describes a use case**: Call \`classify_prompt\` first, then \`refine_requirement\` if tool selection is needed.
3. **When starting a new project**: Call \`toolcairn_init\` to set up .toolcairn/config.json.
4. **When resuming work on a project**: Read .toolcairn/config.json via \`read_project_config\` to see confirmed tools.
5. **When a tool is selected**: Call \`update_project_config\` to persist the choice.
6. **When encountering an error with a tool**: Call \`check_issue\` before debugging — it may be a known issue with an open GitHub ticket.
7. **When user asks to compare tools**: Call \`compare_tools\` for a structured comparison with health data.
8. **When user chooses a non-indexed/proprietary tool**: Add it to config with source: "non_oss" via \`update_project_config\`.

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
| \`toolcairn_init\` | Set up ToolCairn for a new project |
| \`init_project_config\` | Initialize .toolcairn/config.json |
| \`read_project_config\` | Parse .toolcairn/config.json to get confirmed tools |
| \`update_project_config\` | Add/remove/update tools in .toolcairn/config.json |
| \`suggest_graph_update\` | Suggest a new tool or relationship for the ToolCairn graph |

### Rules

- NEVER recommend a tool without first checking ToolCairn unless the tool is already in .toolcairn/config.json
- Always check .toolcairn/config.json at the start of a session if it exists
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
  const resolvedPath = serverPath;
  return {
    toolcairn: {
      type: 'local',
      command: resolvedPath ? ['node', resolvedPath] : ['npx', '-y', '@neurynae/toolcairn-mcp'],
      enabled: true,
    },
  };
}
