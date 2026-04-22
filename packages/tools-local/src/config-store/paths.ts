import { join } from 'node:path';

export const CONFIG_DIR = '.toolcairn';
export const CONFIG_FILE = 'config.json';
export const AUDIT_LOG_FILE = 'audit-log.jsonl';
export const AUDIT_ARCHIVE_FILE = 'audit-log.archive.jsonl';
export const LOCK_FILE = 'config.lock';

export function joinConfigDir(projectRoot: string): string {
  return join(projectRoot, CONFIG_DIR);
}

export function joinConfigPath(projectRoot: string): string {
  return join(projectRoot, CONFIG_DIR, CONFIG_FILE);
}

export function joinAuditPath(projectRoot: string): string {
  return join(projectRoot, CONFIG_DIR, AUDIT_LOG_FILE);
}

export function joinAuditArchivePath(projectRoot: string): string {
  return join(projectRoot, CONFIG_DIR, AUDIT_ARCHIVE_FILE);
}

export function joinLockPath(projectRoot: string): string {
  return join(projectRoot, CONFIG_DIR, LOCK_FILE);
}
