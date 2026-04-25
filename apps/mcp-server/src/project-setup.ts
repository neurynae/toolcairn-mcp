/**
 * Project-level setup hooks — runs once at MCP server startup.
 *
 * As of v0.10.0 the MCP server NO LONGER auto-scaffolds `.toolcairn/config.json`
 * or `.toolcairn/events.jsonl`. Those files are owned by handler flows:
 *   - `config.json` is created atomically by `mutateConfig` on the first call
 *     that passes a `project_root` (cross-process locked, no race).
 *   - `events.jsonl` is created on demand by the event-logger middleware when
 *     `TOOLCAIRN_EVENTS_PATH` is set.
 *
 * What this module still does:
 *   - Detects the host OS (for logging only).
 *   - Writes `.toolcairn/tracker.html` — a read-only dashboard; safe to create at
 *     startup because nothing else writes to it.
 *
 * The tracker's cwd placement is best-effort: `ensureProjectSetup` receives
 * `projectRoot` from the caller (the stdio server boot). If the agent later
 * invokes `toolcairn_init` with a different `project_root`, that handler bootstraps
 * config.json at the correct location via its own cross-process lock.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { platform, type } from 'node:os';
import { join } from 'node:path';
import { createMcpLogger } from '@toolcairn/errors';
import { generateTrackerHtml } from './tools/generate-tracker.js';

const logger = createMcpLogger({ name: '@toolcairn/mcp-server:project-setup' });

/**
 * Detect and return a human-readable OS label for logging.
 * Uses process.platform (win32 / darwin / linux / …).
 */
function detectOs(): { platform: string; label: string } {
  const p = platform();
  const labels: Record<string, string> = {
    win32: 'Windows',
    darwin: 'macOS',
    linux: 'Linux',
    freebsd: 'FreeBSD',
    openbsd: 'OpenBSD',
    sunos: 'Solaris',
    android: 'Android',
  };
  return { platform: p, label: labels[p] ?? type() };
}

/**
 * Ensure `.toolcairn/tracker.html` exists in `projectRoot`. The tracker is
 * a self-contained dashboard the user opens in a browser; it picks up audit
 * logs at runtime via the File System Access API or a directory <input>
 * fallback, so no path interpolation is needed at write time.
 *
 * v0.10.18+: the tracker is regenerated unconditionally on every server
 * start (not gated on createIfAbsent) so previously-deployed stale content
 * gets replaced. Old single-project trackers from v0.10.x relied on a
 * separate events.jsonl file that was almost never written; the new
 * tracker reads `audit-log.jsonl` directly from one or more project roots.
 */
export async function ensureProjectSetup(projectRoot = process.cwd()): Promise<void> {
  const os = detectOs();
  logger.info(
    { os: os.label, platform: os.platform, projectRoot },
    'Detected OS — starting project setup',
  );

  const dir = join(projectRoot, '.toolcairn');
  const trackerPath = join(dir, 'tracker.html');

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(trackerPath, generateTrackerHtml(), 'utf-8');
    logger.info({ dir, os: os.label }, '.toolcairn tracker ready');
  } catch (e) {
    // Non-fatal — server still starts even if setup fails (read-only fs, perms, etc.)
    logger.warn(
      { err: e, dir, os: os.label },
      'tracker.html setup failed — continuing (config.json still bootstrapped by handlers)',
    );
  }
}
