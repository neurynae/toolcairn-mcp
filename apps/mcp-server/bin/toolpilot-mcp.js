#!/usr/bin/env node
// Entry point for `npx @neurynae/toolcairn-mcp` or `toolcairn-mcp` CLI.
//
// Subcommands:
//   (none)             — start the MCP server (default; stdio transport)
//   scan [dir]         — scan project dependencies and check ToolCairn health
//   scan --json        — scan, output raw JSON
//   --help, -h         — print this help
//   --version, -v      — print the package version
//
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.TOOLPILOT_MODE = process.env.TOOLPILOT_MODE ?? 'production';

const args = process.argv.slice(2);

function loadVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function printHelp() {
  const v = loadVersion();
  process.stdout.write(`@neurynae/toolcairn-mcp v${v}

Agent-first MCP server: AI coding agents find, compare, verify, and stack-build
the right open-source tools across 35+ registries (npm, PyPI, Cargo, Maven, Go,
RubyGems, NuGet, Hex, Composer, and more) — with graph-aware ranking and
version-aware compatibility.

Usage:
  npx @neurynae/toolcairn-mcp [command] [options]

Commands:
  (default)            Start the MCP server over stdio. Used by Claude Code,
                       Cursor, Windsurf, Claude Desktop, Continue, Cline, etc.

  scan [dir]           Scan project dependencies and report ToolCairn health
                       status (matched / unknown / stale / mega-skipped tools).
                       'dir' defaults to the current working directory.

  scan --json          Same as 'scan' but emits machine-readable JSON to stdout.

Options:
  -h, --help           Print this help and exit.
  -v, --version        Print the package version and exit.

MCP client setup (Claude Desktop / Cursor / Windsurf example):
  {
    "mcpServers": {
      "toolcairn": {
        "command": "npx",
        "args": ["-y", "@neurynae/toolcairn-mcp"]
      }
    }
  }

Authentication:
  After installing, call the 'toolcairn_auth' MCP tool with action: "login" to
  open a browser device flow. Anonymous mode is fine for low-volume use.

Links:
  Website        https://toolcairn.neurynae.com
  Docs           https://toolcairn.neurynae.com/docs
  Quickstart     https://toolcairn.neurynae.com/docs/quickstart
  Issues         https://github.com/neurynae/toolcairn-mcp/issues
  Security       security@neurynae.com
`);
}

if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
  printHelp();
  process.exit(0);
}

if (args[0] === '--version' || args[0] === '-v' || args[0] === 'version') {
  process.stdout.write(`${loadVersion()}\n`);
  process.exit(0);
}

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
