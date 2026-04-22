import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createMcpLogger } from '@toolcairn/errors';
import type { ConfigAuditEntry } from '@toolcairn/types';
import writeFileAtomic from 'write-file-atomic';
import { fileExists } from '../discovery/util/fs.js';
import { joinAuditArchivePath, joinAuditPath, joinConfigDir } from './paths.js';

const logger = createMcpLogger({ name: '@toolcairn/tools:audit-log' });

/** Maximum entries retained in the live audit-log.jsonl before FIFO archive. */
const MAX_LIVE_ENTRIES = 1000;
/** Entries moved to the archive when the live file exceeds MAX_LIVE_ENTRIES. */
const ARCHIVE_BATCH = 500;

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
