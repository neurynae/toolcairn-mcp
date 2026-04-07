# @neurynae/toolcairn-mcp

**Find the right open source tool, every time.**

[![npm version](https://img.shields.io/npm/v/@neurynae/toolcairn-mcp)](https://www.npmjs.com/package/@neurynae/toolcairn-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/NEURYNAE/ToolCairn/blob/main/LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/@neurynae/toolcairn-mcp)](https://www.npmjs.com/package/@neurynae/toolcairn-mcp)

ToolCairn is an MCP server that helps AI agents and developers discover, compare, and evaluate open source tools. Search across 12,000+ indexed tools with natural language, get stack recommendations, check compatibility, and more — all directly from your AI agent.

---

## Quick Start

**Step 1** — Create a free account at **https://toolcairn.neurynae.com/signup**

**Step 2** — Add to your MCP config and restart your agent:

```json
{
  "mcpServers": {
    "toolcairn": {
      "command": "npx",
      "args": ["@neurynae/toolcairn-mcp"]
    }
  }
}
```

On first start, a browser window opens automatically for sign-in. Once you confirm, your agent is ready to use all tools — no further setup needed.

---

## Setup by Client

### Claude Code

```bash
claude mcp add toolcairn -- npx @neurynae/toolcairn-mcp
```

Or add to `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "toolcairn": {
      "command": "npx",
      "args": ["@neurynae/toolcairn-mcp"]
    }
  }
}
```

### Cursor

Open **Settings → MCP** and add:

```json
{
  "mcpServers": {
    "toolcairn": {
      "command": "npx",
      "args": ["@neurynae/toolcairn-mcp"]
    }
  }
}
```

### VS Code (Copilot)

```json
{
  "github.copilot.chat.mcp.servers": {
    "toolcairn": {
      "command": "npx",
      "args": ["@neurynae/toolcairn-mcp"],
      "type": "stdio"
    }
  }
}
```

### Windsurf

```json
{
  "mcpServers": {
    "toolcairn": {
      "command": "npx",
      "args": ["@neurynae/toolcairn-mcp"]
    }
  }
}
```

---

## Available Tools

| Tool | What it does |
|------|-------------|
| `search_tools` | Search for the best tool for a specific need using natural language |
| `search_tools_respond` | Answer follow-up questions to refine search results |
| `get_stack` | Get a curated tool stack recommendation for a project |
| `compare_tools` | Compare two tools side by side |
| `check_compatibility` | Check if two tools are known to work together |
| `check_issue` | Look up known issues for a tool before spending time debugging |
| `report_outcome` | Report whether a recommended tool worked out |
| `refine_requirement` | Turn a vague requirement into a specific, searchable need |
| `verify_suggestion` | Validate a tool your agent suggested |
| `suggest_graph_update` | Suggest a new tool or relationship to add |
| `toolcairn_init` | Set up ToolCairn for the current project |
| `init_project_config` | Initialize project tool configuration |
| `read_project_config` | Read and validate existing project config |
| `update_project_config` | Add or remove tools from project config |
| `toolcairn_auth` | Check sign-in status or sign out |

---

## Session Management

Your sign-in is stored locally in `~/.toolcairn/credentials.json` and lasts 90 days.

```
toolcairn_auth status   # check if you're signed in
toolcairn_auth logout   # sign out (next agent restart will prompt sign-in again)
```

To sign in on a new machine or after signing out, simply restart your agent — the browser sign-in opens automatically.

---

## Project Configuration

On first use, ToolCairn creates a `.toolcairn/config.json` file in your project. Your agent reads this to track which tools are confirmed for the project and avoids redundant searches on future sessions.

---

## Links

- **Website**: https://toolcairn.neurynae.com
- **Docs**: https://toolcairn.neurynae.com/docs
- **GitHub**: https://github.com/NEURYNAE/ToolCairn
- **Issues**: https://github.com/NEURYNAE/ToolCairn/issues

---

## License

MIT — © NEURYNAE
