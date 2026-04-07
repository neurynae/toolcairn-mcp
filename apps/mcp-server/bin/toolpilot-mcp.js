#!/usr/bin/env node
// Entry point for `npx @toolcairn/mcp` or `toolpilot-mcp` CLI.
// Forces TOOLPILOT_MODE=production so the server uses the HTTP bridge.
process.env.TOOLPILOT_MODE = process.env.TOOLPILOT_MODE ?? 'production';
import('../dist/index.js');
