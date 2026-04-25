/**
 * Read `<projectRoot>/.toolcairn/audit-log.jsonl`, embed the entries inline
 * in `tracker.html`, write the file. The dashboard renders synchronously
 * from the embedded data on open — no fetch, no folder picker, no
 * permission prompt, works on `file://` in any browser.
 *
 * Two callers:
 *   1. `ensureProjectSetup` at server boot — synchronous write so the
 *      tracker is fresh the moment the user opens it.
 *   2. The `withAuditLog` middleware after every audit append — debounced
 *      via `scheduleTrackerRewrite` so a burst of tool calls writes the
 *      tracker once, not once-per-call.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createMcpLogger } from '@toolcairn/errors';
import { joinAuditPath, joinConfigDir, readLiveAudit } from '@toolcairn/tools-local';
import { generateTrackerHtml } from './generate-tracker.js';

const logger = createMcpLogger({ name: '@toolcairn/mcp-server:write-tracker' });

/** How long to wait after the last audit append before rewriting tracker.html. */
const DEBOUNCE_MS = 750;

/** Per-projectRoot debounce timers. */
const pendingRewrites = new Map<string, NodeJS.Timeout>();

/**
 * Read audit-log.jsonl, generate tracker.html with the entries baked inline,
 * write atomically. Best-effort — failures are logged at debug level since
 * the tracker is purely informational.
 */
export async function writeTrackerHtml(projectRoot: string): Promise<void> {
  try {
    const dir = joinConfigDir(projectRoot);
    await mkdir(dir, { recursive: true });
    const entries = await readLiveAudit(projectRoot).catch(() => []);
    const html = generateTrackerHtml({
      rootName: basename(projectRoot) || projectRoot,
      entries,
    });
    await writeFile(join(dir, 'tracker.html'), html, 'utf-8');
    logger.debug(
      { projectRoot, entryCount: entries.length },
      'tracker.html written with embedded audit data',
    );
  } catch (err) {
    logger.debug({ err, projectRoot }, 'tracker.html write skipped (non-fatal)');
  }
}

/**
 * Schedule a tracker.html rewrite for `projectRoot`, coalescing bursts.
 * Call this after every audit append; the actual write fires once per
 * `DEBOUNCE_MS` window so a flurry of tool calls produces one file write.
 */
export function scheduleTrackerRewrite(projectRoot: string): void {
  const existing = pendingRewrites.get(projectRoot);
  if (existing) clearTimeout(existing);
  const handle = setTimeout(() => {
    pendingRewrites.delete(projectRoot);
    void writeTrackerHtml(projectRoot);
  }, DEBOUNCE_MS);
  // Don't keep the Node process alive just for a pending tracker rewrite.
  if (typeof handle.unref === 'function') handle.unref();
  pendingRewrites.set(projectRoot, handle);
}

/** Path helper re-exported for the legacy `events.jsonl` log layout (still referenced by docs). */
export const auditLogPath = joinAuditPath;
