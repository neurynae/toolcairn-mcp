/**
 * Production-only entry point for the published npm bundle.
 *
 * Auth flow (automatic, survives restarts, no reconnect needed):
 * - Valid token → buildProdServer() — all 14 tools immediately
 * - No token, pending-auth.json exists (previous process was killed mid-poll):
 *   → Resume polling; browser already open — don't open again
 * - No token, no pending auth:
 *   → Request new device code, persist to pending-auth.json
 *   → Open browser, show URL + code in instructions
 *   → Poll in background; when confirmed: dynamically add all 14 tools
 *     to the running server (notifications/tools/list_changed sent to client)
 *   → No reconnect required
 *
 * Post-auth project provisioning (v0.10.2+):
 * - When creds are already present at startup, run `runPostAuthInit` with
 *   `onlyMissingConfig: true` so any project root under CWD that lacks
 *   `.toolcairn/config.json` gets auto-provisioned BEFORE tools register.
 * - When creds arrive via the background sign-in flow, run `runPostAuthInit`
 *   (full scan) immediately after the tools are registered so the agent's
 *   next `read_project_config` call sees a ready state with `unknown_tools`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config } from '@toolcairn/config';
import { createMcpLogger } from '@toolcairn/errors';
import {
  isTokenValid,
  loadCredentials,
  loadPendingAuth,
  requestDeviceCode,
  startDeviceAuth,
} from '@toolcairn/remote';
import { z } from 'zod';
import { runPostAuthInit } from './post-auth-init.js';
import { ensureProjectSetup } from './project-setup.js';
import { addToolsToServer, buildProdServer } from './server.prod.js';
import { createTransport } from './transport.js';

process.env.TOOLPILOT_MODE = 'production';

const logger = createMcpLogger({ name: '@toolcairn/mcp-server' });

async function main(): Promise<void> {
  await ensureProjectSetup();

  const creds = await loadCredentials();
  const authenticated = creds !== null && isTokenValid(creds);

  let server: McpServer;

  if (authenticated) {
    logger.info({ user: creds.user_email }, 'Authenticated — starting full server');
    // Provision any discovered project root under CWD that is missing
    // `.toolcairn/config.json`. Best-effort — a failure here never blocks the
    // tool list from registering.
    try {
      const summary = await runPostAuthInit({ agent: 'claude', onlyMissingConfig: true });
      logger.info(
        {
          roots: summary.roots_discovered.length,
          provisioned: summary.projects.length,
          unknown_tools_total: summary.unknown_tools_total,
        },
        'Startup auto-init complete',
      );
    } catch (err) {
      logger.warn({ err }, 'Startup auto-init failed — continuing with tool registration');
    }
    server = await buildProdServer();
  } else {
    let verificationUri = 'https://toolcairn.neurynae.com/signup';
    let userCode = '';

    try {
      const pending = await loadPendingAuth();
      if (pending) {
        // Resume from previous process — browser already open, just poll
        verificationUri = pending.verification_uri;
        userCode = pending.user_code;
        logger.info({ userCode }, 'Resuming pending sign-in');
      } else {
        // Fresh start — request new device code + open browser
        const codeData = await requestDeviceCode(config.TOOLPILOT_API_URL);
        verificationUri = codeData.verification_uri;
        userCode = codeData.user_code;
        logger.info({ userCode }, 'New sign-in started');
      }
    } catch (err) {
      logger.error({ err }, 'Could not reach ToolCairn API — check your connection');
    }

    const instructions = userCode
      ? `# ToolCairn — Sign In Required\n\nA browser window should have opened automatically.\n\n**Sign-in URL:** ${verificationUri}\n**Code to confirm:** \`${userCode}\`\n\nOpen the URL, sign in, and confirm the code shown. All 14 tools will appear automatically — no restart needed.\n\nAfter sign-in the server will automatically provision .toolcairn/config.json for every project root under your working directory (scan + graph classification).`
      : '# ToolCairn — Sign In Required\n\nVisit https://toolcairn.neurynae.com to create an account, then reconnect.';

    server = new McpServer({ name: 'toolcairn', version: '0.1.0' }, { instructions });

    server.registerTool(
      'toolcairn_auth',
      {
        description: 'Check ToolCairn sign-in status.',
        inputSchema: z.object({ action: z.enum(['status']) }),
      },
      async () => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              authenticated: false,
              sign_in_url: verificationUri,
              code: userCode || null,
              message: userCode
                ? `Open ${verificationUri} and confirm code "${userCode}". Tools will appear automatically when confirmed.`
                : 'Visit toolcairn.neurynae.com to sign up.',
            }),
          },
        ],
      }),
    );

    // Start auth flow in background.
    // On success: dynamically register all 14 tools on this same server, then
    // run the post-auth scan + config write for every discovered project root.
    // The MCP SDK sends notifications/tools/list_changed — client refreshes
    // the tool list automatically, no reconnect required.
    startDeviceAuth(config.TOOLPILOT_API_URL)
      .then(async () => {
        logger.info('Sign-in complete — adding all tools to running server');
        try {
          await addToolsToServer(server);
          logger.info('All ToolCairn tools now available');
        } catch (err) {
          logger.error({ err }, 'Failed to add tools after sign-in — please reconnect');
          return;
        }
        try {
          const summary = await runPostAuthInit({ agent: 'claude' });
          logger.info(
            {
              roots: summary.roots_discovered.length,
              provisioned: summary.projects.length,
              unknown_tools_total: summary.unknown_tools_total,
            },
            'Post-sign-in auto-init complete',
          );
        } catch (err) {
          logger.warn({ err }, 'Post-sign-in auto-init failed — call toolcairn_init manually');
        }
      })
      .catch((err: unknown) => {
        logger.error({ err }, 'Sign-in failed — please try again');
      });
  }

  const transport = createTransport();
  await server.connect(transport);
  logger.info(authenticated ? 'ToolCairn MCP ready' : 'ToolCairn MCP ready (awaiting sign-in)');
}

main().catch((error: unknown) => {
  createMcpLogger({ name: '@toolcairn/mcp-server' }).error(
    { err: error },
    'Failed to start MCP server',
  );
  process.exit(1);
});
