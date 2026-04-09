#!/usr/bin/env node
// Entry point for `npx @neurynae/toolcairn-mcp` or `toolcairn-mcp` CLI.
//
// Subcommands:
//   (none)       — start the MCP server (default)
//   scan [dir]   — scan project dependencies and check ToolCairn health status
//   scan --json  — same but output raw JSON
//
process.env.TOOLPILOT_MODE = process.env.TOOLPILOT_MODE ?? 'production';

const args = process.argv.slice(2);

if (args[0] === 'scan') {
  // Stack scanner CLI — does NOT start the MCP server
  import('../dist/cli/scan.js').then(({ runScan }) => {
    return runScan(args.slice(1));
  }).catch((err) => {
    console.error('scan failed:', err.message);
    process.exit(1);
  });
} else {
  // Default: start the MCP server
  import('../dist/index.js');
}
