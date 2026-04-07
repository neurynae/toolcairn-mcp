/**
 * Automatic project-level setup — runs at MCP server startup.
 *
 * Detects the host OS, then creates the .toolcairn/ directory and base files
 * in process.cwd() (the project root where the user ran `npx @neurynae/toolcairn-mcp`).
 *
 * This mirrors how credentials.json is auto-created in ~/.toolcairn at
 * startup, but for project-scoped files.
 *
 * Files created (only if absent — never overwrites existing):
 *   .toolcairn/config.json    — empty scaffold; agent fills project details
 *   .toolcairn/tracker.html   — full dashboard HTML (from generateTrackerHtml)
 *   .toolcairn/events.jsonl   — empty JSONL log; written to at runtime
 *
 * The agent still needs to run toolcairn_init + init_project_config to fill
 * in project.name, language, framework, and confirmed tools.
 */

import { access, mkdir, writeFile } from 'node:fs/promises';
import { platform, type } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { generateTrackerHtml } from './tools/generate-tracker.js';

const logger = pino({ name: '@toolcairn/mcp-server:project-setup' });

/** Minimal config.json scaffold written on first run. */
const INITIAL_CONFIG = {
  version: '1.0',
  project: {
    name: '',
    language: '',
    framework: '',
  },
  tools: {
    confirmed: [],
    pending_evaluation: [],
  },
  audit_log: [] as unknown[],
};

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
 * Normalise an absolute file path to use forward slashes.
 * Required when embedding the path in a file:// URL inside tracker.html.
 * On Unix this is a no-op; on Windows it converts C:\foo\bar → C:/foo/bar.
 */
function toFileUrl(absPath: string): string {
  return absPath.replace(/\\/g, '/');
}

/**
 * Ensure .toolcairn/ and its base files exist in projectRoot.
 * Safe to call on every startup — skips files that already exist.
 */
export async function ensureProjectSetup(projectRoot = process.cwd()): Promise<void> {
  const os = detectOs();
  logger.info(
    { os: os.label, platform: os.platform, projectRoot },
    'Detected OS — starting project setup',
  );

  const dir = join(projectRoot, '.toolcairn');
  const configPath = join(dir, 'config.json');
  const trackerPath = join(dir, 'tracker.html');
  const eventsPath = join(dir, 'events.jsonl');

  // tracker.html embeds the events path in a file:// URL — must use forward slashes
  const eventsPathForUrl = toFileUrl(eventsPath);

  try {
    await mkdir(dir, { recursive: true });

    await createIfAbsent(configPath, JSON.stringify(INITIAL_CONFIG, null, 2), 'config.json');
    await createIfAbsent(trackerPath, generateTrackerHtml(eventsPathForUrl), 'tracker.html');

    // events.jsonl starts empty — populated at runtime when TOOLCAIRN_EVENTS_PATH is set
    await createIfAbsent(eventsPath, '', 'events.jsonl');

    logger.info({ dir, os: os.label }, '.toolcairn setup ready');
  } catch (e) {
    // Non-fatal — server still starts even if setup fails (read-only fs, permission denied, etc.)
    logger.warn(
      { err: e, dir, os: os.label },
      'Project setup failed — continuing without .toolcairn files',
    );
  }
}

async function createIfAbsent(filePath: string, content: string, label: string): Promise<void> {
  try {
    await access(filePath);
    logger.debug({ file: label }, 'Already exists — skipping');
  } catch {
    await writeFile(filePath, content, 'utf-8');
    logger.info({ file: label }, 'Created');
  }
}
