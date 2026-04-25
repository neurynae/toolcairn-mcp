import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createMcpLogger } from '@toolcairn/errors';
import type { ConfigAuditEntry } from '@toolcairn/types';
import lockfile from 'proper-lockfile';
import writeFileAtomic from 'write-file-atomic';
import { fileExists } from '../discovery/util/fs.js';
import { emptySkeleton } from './skeleton.js';
import { joinAuditArchivePath, joinAuditPath, joinConfigDir, joinConfigPath } from './paths.js';

const logger = createMcpLogger({ name: '@toolcairn/tools:audit-log' });

/**
 * Maximum entries retained in the live audit-log.jsonl before FIFO archive.
 * Bumped from 1000 → 5000 in v1.2.1: every MCP tool call now produces an
 * audit entry, so the log churns ~10x faster than the old config-mutation-only mode.
 */
const MAX_LIVE_ENTRIES = 5000;
/** Entries moved to the archive when the live file exceeds MAX_LIVE_ENTRIES. */
const ARCHIVE_BATCH = 2500;

/**
 * Appends one entry to `.toolcairn/audit-log.jsonl`, creating the file if absent.
 *
 * After append, if the live file has grown beyond MAX_LIVE_ENTRIES, the oldest
 * ARCHIVE_BATCH lines are moved to `.toolcairn/audit-log.archive.jsonl` and the
 * live file is truncated to the remaining tail.
 *
 * Caller MUST hold the cross-process lock.
 */
export async function appendAudit(projectRoot: string, entry: ConfigAuditEntry): Promise<void> {
  await mkdir(joinConfigDir(projectRoot), { recursive: true });
  const auditPath = joinAuditPath(projectRoot);
  const line = `${JSON.stringify(entry)}\n`;
  await appendFile(auditPath, line, 'utf-8');

  // Rotation check — counts lines in-place; cheap for files under a few MB.
  await rotateIfNeeded(projectRoot, auditPath);
}

/**
 * Bulk-appends many entries in one flush. Used during 1.0 → 1.1 migration when
 * the legacy `audit_log[]` is relocated into the jsonl file.
 */
export async function bulkAppendAudit(
  projectRoot: string,
  entries: ConfigAuditEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  await mkdir(joinConfigDir(projectRoot), { recursive: true });
  const auditPath = joinAuditPath(projectRoot);
  const payload = entries.map((e) => `${JSON.stringify(e)}\n`).join('');
  await appendFile(auditPath, payload, 'utf-8');
  await rotateIfNeeded(projectRoot, auditPath);
}

/**
 * Self-locking append for tool-call audit entries. Used by the MCP server's
 * audit-log middleware after every tool invocation — the call site does NOT
 * already hold the config lock (unlike `mutateConfig` which calls plain
 * `appendAudit` while it owns the lock).
 *
 * Idempotently bootstraps `.toolcairn/config.json` if missing so the lock
 * target exists. If bootstrap fails (read-only FS, permissions), the call is
 * a silent no-op — audit logging must never block real work.
 */
export async function appendToolCallAudit(
  projectRoot: string,
  entry: ConfigAuditEntry,
): Promise<void> {
  try {
    await ensureLockable(projectRoot);
  } catch (err) {
    logger.debug({ err, projectRoot }, 'audit-log: bootstrap skipped (read-only?) — abandoning');
    return;
  }

  const configPath = joinConfigPath(projectRoot);
  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(configPath, {
      stale: 10_000,
      retries: { retries: 5, minTimeout: 50, factor: 2, maxTimeout: 500 },
      realpath: false,
    });
    await appendAudit(projectRoot, entry);
  } catch (err) {
    logger.warn({ err, projectRoot }, 'audit-log: tool-call append failed');
  } finally {
    if (release) {
      try {
        await release();
      } catch (err) {
        logger.debug({ err }, 'audit-log: lock release failed (likely already stale)');
      }
    }
  }
}

async function ensureLockable(projectRoot: string): Promise<void> {
  await mkdir(joinConfigDir(projectRoot), { recursive: true });
  const configPath = joinConfigPath(projectRoot);
  if (!(await fileExists(configPath))) {
    // proper-lockfile requires the lock target to exist — seed an empty
    // skeleton if absent. mutateConfig will overwrite this on its next run.
    await writeFile(configPath, `${JSON.stringify(emptySkeleton(), null, 2)}\n`, 'utf-8');
  }
}

/** Returns all audit entries in the live file (not the archive). Parse errors are skipped. */
export async function readLiveAudit(projectRoot: string): Promise<ConfigAuditEntry[]> {
  const auditPath = joinAuditPath(projectRoot);
  if (!(await fileExists(auditPath))) return [];
  const raw = await readFile(auditPath, 'utf-8');
  return parseJsonl(raw);
}

async function rotateIfNeeded(projectRoot: string, auditPath: string): Promise<void> {
  const raw = await readFile(auditPath, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length <= MAX_LIVE_ENTRIES) return;

  const archiveBatch = lines.slice(0, ARCHIVE_BATCH);
  const keep = lines.slice(ARCHIVE_BATCH);
  const archivePath = joinAuditArchivePath(projectRoot);

  try {
    // Archive append (never truncates) — then atomic-write the truncated live file.
    await appendFile(archivePath, `${archiveBatch.join('\n')}\n`, 'utf-8');
    // Atomic truncate by writing new content to a temp + rename.
    const newContent = `${keep.join('\n')}\n`;
    await writeFileAtomic(auditPath, newContent);
    logger.info(
      { archived: archiveBatch.length, retained: keep.length },
      'audit-log.jsonl rotated',
    );
  } catch (err) {
    logger.warn({ err, auditPath, archivePath }, 'Audit-log rotation failed — live file intact');
  }
}

function parseJsonl(raw: string): ConfigAuditEntry[] {
  const out: ConfigAuditEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ConfigAuditEntry);
    } catch {
      // Skip malformed line — do not break the caller
    }
  }
  return out;
}

/** Test helper — blow away the audit log files. Not exported from the barrel. */
export async function _resetAudit(projectRoot: string): Promise<void> {
  for (const p of [joinAuditPath(projectRoot), joinAuditArchivePath(projectRoot)]) {
    try {
      await rm(p);
    } catch {
      /* ignore */
    }
  }
  // Re-create empty live file so fresh appends start clean.
  try {
    await writeFile(joinAuditPath(projectRoot), '', 'utf-8');
  } catch {
    /* ignore */
  }
}
