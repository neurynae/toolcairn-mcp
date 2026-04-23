/**
 * Post-authentication project provisioning.
 *
 * Called by both the auth-gate `toolcairn_auth` tool (index.ts) and the full
 * prod server's `toolcairn_auth` tool (server.prod.ts) immediately after
 * credentials are persisted. Discovers every independent project root under
 * CWD (one `.toolcairn/` per primary-manifest directory, sibling-repo aware)
 * and runs the full scan + config write for each.
 *
 * Also used during server boot: if the user is already authenticated but one
 * or more roots are missing `.toolcairn/config.json`, we provision them inline
 * before `addToolsToServer()` so the agent sees fully-ready projects on the
 * first `read_project_config` call.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config as mcpConfig } from '@toolcairn/config';
import { createMcpLogger } from '@toolcairn/errors';
import { ToolCairnClient, loadCredentials } from '@toolcairn/remote';
import {
  type AutoInitResult,
  autoInitProject,
  discoverProjectRoots,
} from '@toolcairn/tools-local';

const logger = createMcpLogger({ name: '@toolcairn/mcp-server:post-auth-init' });

export interface PerRootOutcome {
  project_root: string;
  status: 'initialized' | 'failed';
  config_path?: string;
  audit_log_path?: string;
  scan_summary?: AutoInitResult['scan_summary'];
  setup_steps?: AutoInitResult['setup_steps'];
  unknown_tools?: AutoInitResult['unknown_tools'];
  bootstrapped?: boolean;
  migrated?: boolean;
  error?: string;
}

export interface PostAuthInitSummary {
  cwd: string;
  roots_discovered: string[];
  used_fallback: boolean;
  projects: PerRootOutcome[];
  unknown_tools_total: number;
  first_turn_directive: string;
}

/**
 * Build an authenticated remote client using the on-disk credentials.
 * Returns null when credentials are missing/invalid — callers should treat
 * that as "skip auto-init, report a warning".
 */
async function buildAuthenticatedClient(): Promise<ToolCairnClient | null> {
  const creds = await loadCredentials();
  if (!creds) return null;
  return new ToolCairnClient({
    baseUrl: mcpConfig.TOOLPILOT_API_URL,
    apiKey: creds.client_id,
    accessToken: creds.access_token,
  });
}

export interface RunPostAuthInitOptions {
  /** Override CWD (tests). Defaults to process.cwd(). */
  cwd?: string;
  /** Agent type that owns the setup_steps (CLAUDE.md / .cursorrules / etc). */
  agent?: 'claude' | 'cursor' | 'windsurf' | 'copilot' | 'copilot-cli' | 'opencode' | 'generic';
  /**
   * When true, ONLY provision roots whose `.toolcairn/config.json` does not yet exist.
   * Used by the server-startup path to avoid re-scanning an already-ready project on
   * every boot. The auth-completion path leaves this false so a re-auth also refreshes
   * the scan.
   */
  onlyMissingConfig?: boolean;
}

/**
 * Run the scan+write pipeline for every root discovered under `cwd`.
 *
 * Never throws — per-root failures are captured into the `projects[]` outcome
 * with `status: 'failed'` + `error`, so one bad root never breaks the others
 * or the auth flow itself.
 */
export async function runPostAuthInit(
  options: RunPostAuthInitOptions = {},
): Promise<PostAuthInitSummary> {
  const cwd = options.cwd ?? process.cwd();
  const agent = options.agent ?? 'claude';

  const remote = await buildAuthenticatedClient();
  if (!remote) {
    logger.warn('runPostAuthInit called without valid credentials — skipping');
    return {
      cwd,
      roots_discovered: [],
      used_fallback: false,
      projects: [],
      unknown_tools_total: 0,
      first_turn_directive: '',
    };
  }

  const { roots, usedFallback } = await discoverProjectRoots(cwd);
  logger.info({ cwd, roots: roots.length, usedFallback }, 'Roots discovered post-auth');

  const projects: PerRootOutcome[] = [];
  for (const projectRoot of roots) {
    // Skip roots that already have config when the caller asked us to (startup path).
    if (options.onlyMissingConfig) {
      const cfgPath = join(projectRoot, '.toolcairn', 'config.json');
      if (existsSync(cfgPath)) {
        logger.debug({ projectRoot }, 'Root already has config.json — skipping');
        continue;
      }
    }

    try {
      const result = await autoInitProject({
        projectRoot,
        agent,
        batchResolve: (items) => remote.batchResolve(items),
        reason: options.onlyMissingConfig ? 'Startup auto-init (config missing)' : 'Post-auth auto-init',
      });
      projects.push({
        project_root: projectRoot,
        status: 'initialized',
        config_path: result.config_path,
        audit_log_path: result.audit_log_path,
        scan_summary: result.scan_summary,
        setup_steps: result.setup_steps,
        unknown_tools: result.unknown_tools,
        bootstrapped: result.bootstrapped,
        migrated: result.migrated,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, projectRoot }, 'autoInitProject failed for root');
      projects.push({
        project_root: projectRoot,
        status: 'failed',
        error: message,
      });
    }
  }

  const unknownTotal = projects.reduce(
    (sum, p) => sum + (p.unknown_tools?.length ?? 0),
    0,
  );
  const directive = buildFirstTurnDirective(projects, unknownTotal);

  return {
    cwd,
    roots_discovered: roots,
    used_fallback: usedFallback,
    projects,
    unknown_tools_total: unknownTotal,
    first_turn_directive: directive,
  };
}

function buildFirstTurnDirective(
  projects: PerRootOutcome[],
  unknownTotal: number,
): string {
  if (unknownTotal === 0) return '';
  const rootsWithUnknown = projects.filter((p) => (p.unknown_tools?.length ?? 0) > 0);
  const roots = rootsWithUnknown.map((p) => p.project_root).join(', ');
  return [
    `The auto-init scan found ${unknownTotal} tool(s) not yet in the ToolCairn graph`,
    `across ${rootsWithUnknown.length} project root(s): ${roots}.`,
    'BEFORE responding to the user, for EACH root with a non-empty `unknown_tools[]`:',
    '(1) call `suggest_graph_update` with suggestion_type="new_tool" and',
    '    data.tools=<that root\'s unknown_tools array> — entries will be STAGED',
    '    for admin review (no live-graph writes yet);',
    '(2) call `update_project_config` with action="mark_suggestions_sent",',
    '    project_root, and data.tool_names=<names that staged successfully>.',
  ].join(' ');
}
