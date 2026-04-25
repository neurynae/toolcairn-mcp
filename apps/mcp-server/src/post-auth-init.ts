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
 *
 * Safety-net auto-push (v0.10.4+): after each root's scan+write completes,
 * we push its `unknown_tools[]` to the engine's `suggest_graph_update`
 * endpoint directly. This guarantees the OSS tail gets submitted for admin
 * review even if the agent skips the first-turn directive. The engine
 * dedups against existing staged + already-indexed rows, so overlapping
 * submissions from the agent are safe — no double-staging.
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
  mutateConfig,
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
  /** Populated by the safety-net auto-push when non-zero tools were submitted. */
  auto_submitted?: {
    staged: string[];
    already_staged: string[];
    already_indexed: string[];
    rejected: Array<{ tool_name: string; reason: string }>;
  };
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
  /** Disable the safety-net auto-push (tests). Default false — auto-push is on. */
  disableAutoSubmit?: boolean;
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
        reason: options.onlyMissingConfig
          ? 'Startup auto-init (config missing)'
          : 'Post-auth auto-init',
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

  // Safety-net: push each root's unknown_tools to suggest_graph_update even
  // if the agent never calls the tool. Engine dedups against stagedNode +
  // indexedTool, so concurrent agent calls are safe. Runs in sequence per
  // root; if the engine is unreachable the flag stays unsuggested and the
  // next startup retries.
  if (!options.disableAutoSubmit) {
    for (const project of projects) {
      if (project.status !== 'initialized') continue;
      const pending = (project.unknown_tools ?? []).filter((t) => !!t.github_url);
      if (pending.length === 0) continue;

      try {
        const outcome = await submitUnknownsToEngine(remote, pending);
        project.auto_submitted = outcome;
        const toMark = [...outcome.staged, ...outcome.already_staged, ...outcome.already_indexed];
        if (toMark.length > 0) {
          await markSuggestedInConfig(project.project_root, toMark).catch((err) =>
            logger.warn(
              { err, projectRoot: project.project_root },
              'Failed to flip suggested flags after auto-submit',
            ),
          );
        }
        logger.info(
          {
            projectRoot: project.project_root,
            staged: outcome.staged.length,
            already_staged: outcome.already_staged.length,
            already_indexed: outcome.already_indexed.length,
            rejected: outcome.rejected.length,
          },
          'Auto-push to suggest_graph_update complete',
        );
      } catch (err) {
        logger.warn(
          { err, projectRoot: project.project_root },
          'Auto-push to suggest_graph_update failed — agent directive remains as fallback',
        );
      }
    }
  }

  const unknownTotal = projects.reduce(
    (sum, p) => sum + (p.unknown_tools ?? []).filter((t) => !t.suggested).length,
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

interface AutoSubmitOutcome {
  staged: string[];
  already_staged: string[];
  already_indexed: string[];
  rejected: Array<{ tool_name: string; reason: string }>;
}

/**
 * POST the whole unknown_tools list for one root to /v1/feedback/suggest.
 * Parses the CallToolResult envelope and bucket-sorts per-item results.
 */
async function submitUnknownsToEngine(
  remote: ToolCairnClient,
  pending: ReadonlyArray<{ name: string; github_url?: string; ecosystem?: string }>,
): Promise<AutoSubmitOutcome> {
  const res = await remote.suggestGraphUpdate({
    suggestion_type: 'new_tool',
    data: {
      tools: pending.map((t) => ({
        tool_name: t.name,
        github_url: t.github_url,
        ecosystem: t.ecosystem,
      })),
    },
    confidence: 0.5,
  });

  const textBlock = res.content?.[0];
  const outcome: AutoSubmitOutcome = {
    staged: [],
    already_staged: [],
    already_indexed: [],
    rejected: [],
  };
  if (!textBlock || textBlock.type !== 'text') return outcome;

  let envelope: {
    ok?: boolean;
    data?: {
      results?: Array<{
        tool_name?: string;
        verified?: boolean;
        staged?: boolean;
        already_staged?: boolean;
        already_indexed?: boolean;
        reason?: string;
      }>;
    };
  };
  try {
    envelope = JSON.parse(textBlock.text ?? '{}');
  } catch {
    return outcome;
  }
  const items = envelope.data?.results ?? [];
  for (const item of items) {
    const name = item.tool_name ?? '';
    if (!name) continue;
    if (item.already_indexed) {
      outcome.already_indexed.push(name);
    } else if (item.already_staged) {
      outcome.already_staged.push(name);
    } else if (item.staged === true) {
      outcome.staged.push(name);
    } else {
      outcome.rejected.push({ tool_name: name, reason: item.reason ?? 'unknown' });
    }
  }
  return outcome;
}

/**
 * Flip `suggested: true` + `suggested_at` for the given tool names under the
 * atomic config lock. Only writes when at least one matching entry changes,
 * so repeated runs don't churn the audit log.
 */
async function markSuggestedInConfig(
  projectRoot: string,
  toolNames: ReadonlyArray<string>,
): Promise<void> {
  const wanted = new Set(toolNames);
  const now = new Date().toISOString();
  let changed = 0;

  await mutateConfig(
    projectRoot,
    (cfg) => {
      const list = cfg.tools.unknown_in_graph ?? [];
      for (const entry of list) {
        if (wanted.has(entry.name) && !entry.suggested) {
          entry.suggested = true;
          entry.suggested_at = now;
          changed++;
        }
      }
      cfg.tools.unknown_in_graph = list;
    },
    {
      action: 'mark_suggestions_sent',
      tool: `__auto_submit__:${toolNames.length}`,
      reason: 'Server auto-pushed unknown_in_graph tools to suggest_graph_update',
      metadata: {
        tool_names: toolNames,
        tool_count: toolNames.length,
      },
    },
  );

  if (changed === 0) {
    logger.debug({ projectRoot, toolNames }, 'No unknown_in_graph entries flipped');
  }
}

function buildFirstTurnDirective(projects: PerRootOutcome[], unknownTotal: number): string {
  if (unknownTotal === 0) return '';
  const rootsWithUnknown = projects.filter(
    (p) => (p.unknown_tools ?? []).filter((t) => !t.suggested).length > 0,
  );
  if (rootsWithUnknown.length === 0) return '';
  const roots = rootsWithUnknown.map((p) => p.project_root).join(', ');
  return [
    `The auto-init scan found ${unknownTotal} tool(s) not yet in the ToolCairn graph`,
    `across ${rootsWithUnknown.length} project root(s): ${roots}.`,
    'The server has already auto-submitted these to the admin review queue,',
    'but you MAY repeat the call below to confirm — engine-side dedup prevents duplicates:',
    '(1) call `suggest_graph_update` with suggestion_type="new_tool" and',
    "    data.tools=<that root's unknown_tools array>;",
    '(2) call `update_project_config` with action="mark_suggestions_sent",',
    '    project_root, and data.tool_names=<names that staged or were already_staged>.',
  ].join(' ');
}
