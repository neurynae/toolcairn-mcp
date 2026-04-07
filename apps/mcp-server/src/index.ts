// ToolCairn MCP Server — connects to the hosted ToolCairn API (api.neurynae.com)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config } from '@toolcairn/config';
import { isTokenValid, loadCredentials, startDeviceAuth } from '@toolcairn/remote';
import pino from 'pino';
import { z } from 'zod';
import { ensureProjectSetup } from './project-setup.js';
import { buildProdServer } from './server.prod.js';
import { createTransport } from './transport.js';

// Load .env from project root if NOMIC_API_KEY is missing (Claude Code MCP env inheritance)
if (!process.env.NOMIC_API_KEY) {
  try {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const envPath = resolve(dir, '../../../../.env');
    const lines = readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const match = line.match(/^([A-Z_]+)=(.+)$/);
      const key = match?.[1];
      const val = match?.[2];
      if (key && val && !process.env[key]) {
        process.env[key] = val.trim();
      }
    }
  } catch {
    /* .env not found — continue without */
  }
}

const logger = pino({ name: '@toolcairn/mcp-server' });

/**
 * Builds a minimal server with only the toolcairn_auth tool.
 * Used when the user is not yet authenticated so the MCP handshake
 * completes immediately (no blocking) and the agent can guide the user
 * to sign in by calling toolcairn_auth { action: "login" }.
 */
function buildAuthGateServer(): McpServer {
  const server = new McpServer(
    { name: 'toolcairn', version: '0.1.0' },
    {
      instructions: `
# ToolCairn — Sign In Required

You are NOT authenticated. ToolCairn tools are unavailable until you sign in.

## Action Required

Call: \`toolcairn_auth\` with \`{ "action": "login" }\`

This opens a browser window. The user signs in at toolcairn.neurynae.com/device,
confirms the code, and the token is saved. After that, tell the user to restart
their agent — all 14 tools will be available on the next session.
      `.trim(),
    },
  );

  server.registerTool(
    'toolcairn_auth',
    {
      description:
        'Sign in to ToolCairn. Opens a browser for authentication — required before any other tools are available. Call with action="login" to start.',
      inputSchema: z.object({
        action: z
          .enum(['login', 'status'])
          .describe('"login" starts sign-in, "status" checks current state'),
      }),
    },
    async ({ action }) => {
      if (action === 'status') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                authenticated: false,
                message: 'Not signed in. Call toolcairn_auth with action="login" to authenticate.',
              }),
            },
          ],
        };
      }

      try {
        const user = await startDeviceAuth(config.TOOLPILOT_API_URL);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                message: `Signed in as ${user.email}. Please restart your agent — all ToolCairn tools will be available on the next session.`,
                user_email: user.email,
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

  return server;
}

async function main(): Promise<void> {
  logger.info('Starting ToolCairn MCP Server');

  await ensureProjectSetup();

  let server: McpServer;

  const creds = await loadCredentials();
  const authenticated = creds !== null && isTokenValid(creds);

  if (authenticated) {
    // Fully authenticated — register all tools
    server = await buildProdServer();
  } else {
    // Not authenticated — connect immediately with auth-gate server.
    // Agent will call toolcairn_auth login, user signs in via browser,
    // then restarts the agent to get full tool access.
    logger.info('No valid credentials — starting in auth-gate mode');
    server = buildAuthGateServer();
  }

  const transport = createTransport();
  await server.connect(transport);
  logger.info('ToolCairn MCP Server started');
}

main().catch((error: unknown) => {
  pino({ name: '@toolcairn/mcp-server' }).error({ err: error }, 'Failed to start MCP server');
  process.exit(1);
});
