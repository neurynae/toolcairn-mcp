import { mkdir, writeFile } from 'node:fs/promises';
import { createMcpLogger } from '@toolcairn/errors';
import type { ConfigAuditEntry, ToolPilotProjectConfig } from '@toolcairn/types';
import lockfile from 'proper-lockfile';
import { fileExists } from '../discovery/util/fs.js';
import { appendAudit } from './audit.js';
import { migrateToV1_1 } from './migrate.js';
import { joinConfigDir, joinConfigPath } from './paths.js';
import { readConfig } from './read.js';
import { emptySkeleton } from './skeleton.js';
import { writeConfig } from './write.js';

const logger = createMcpLogger({ name: '@toolcairn/tools:config-store' });

export type Mutator = (config: ToolPilotProjectConfig) => void | Promise<void>;

/** The audit entry to attach, sans timestamp (mutate.ts stamps it). */
export type PendingAuditEntry = Omit<ConfigAuditEntry, 'timestamp'>;

export interface MutateResult {
  config: ToolPilotProjectConfig;
  audit_entry: ConfigAuditEntry;
  /** True iff we bootstrapped a fresh config.json on this call. */
  bootstrapped: boolean;
  /** True iff the config on disk was v1.0 and was migrated in the same write. */
  migrated: boolean;
}

/**
 * The single supported entry point for mutating `.toolcairn/config.json`.
 *
 * Flow (under cross-process advisory lock):
 *   1. Ensure `.toolcairn/` exists + acquire `.toolcairn/config.lock`.
 *   2. Read config.json (or bootstrap a fresh v1.1 skeleton if absent).
 *   3. If schema is v1.0, migrate in place and relocate legacy audit entries.
 *   4. Apply the caller-supplied `mutator(config)` on the in-memory object.
 *   5. Stamp `{...audit, timestamp: now}` into `config.last_audit_entry`.
 *   6. Atomic-write `config.json` (write-file-atomic: fsync + parent dirsync + EBUSY retry).
 *   7. Append the audit entry to `.toolcairn/audit-log.jsonl` (FIFO-archives at 1000 entries).
 *   8. Release the lock.
 *
 * The lock survives process crashes (stale-lock timeout = 10s); if a prior holder
 * crashed mid-write, the write-file-atomic temp file is naturally cleaned up by a
 * subsequent run.
 */
export async function mutateConfig(
  projectRoot: string,
  mutator: Mutator,
  audit: PendingAuditEntry,
): Promise<MutateResult> {
  // proper-lockfile locks a real file by creating `<file>.lock/` directory.
  // We lock config.json itself (idiomatic), seeding an empty skeleton first when absent.
  // Record whether the real config.json existed BEFORE we seeded anything — the
  // "bootstrapped" flag we return reflects that pre-seed state.
  const configPath = joinConfigPath(projectRoot);
  const preExisted = await fileExists(configPath);
  await ensureLockableDir(projectRoot);

  const release = await lockfile.lock(configPath, {
    stale: 10_000,
    retries: { retries: 5, minTimeout: 50, factor: 2, maxTimeout: 500 },
    realpath: false,
  });

  try {
    // 1. Read
    const { config: existing } = await readConfig(projectRoot);
    let config: ToolPilotProjectConfig;
    const bootstrapped = !preExisted;
    let migrated = false;

    if (!existing) {
      config = emptySkeleton();
      logger.info({ projectRoot }, 'Bootstrapping fresh .toolcairn/config.json');
    } else {
      config = existing;
    }

    // 2. Migrate if needed (before mutator so mutators see the v1.1 shape).
    if (config.version === '1.0') {
      const result = await migrateToV1_1(config, projectRoot);
      migrated = result.migrated;
    } else {
      // Ensure v1.1 invariants even if the file was hand-edited
      for (const tool of config.tools.confirmed) {
        if (!tool.locations) tool.locations = [];
      }
      if (!config.project.languages) config.project.languages = [];
      if (!config.project.frameworks) config.project.frameworks = [];
      if (!config.project.subprojects) config.project.subprojects = [];
    }

    // 3. Caller mutation.
    await mutator(config);

    // 4. Stamp audit entry.
    const now = new Date().toISOString();
    const entry: ConfigAuditEntry = { ...audit, timestamp: now };
    config.last_audit_entry = entry;
    config.version = '1.1';

    // 5. Atomic write + audit append.
    await writeConfig(projectRoot, config);
    await appendAudit(projectRoot, entry);

    return { config, audit_entry: entry, bootstrapped, migrated };
  } finally {
    try {
      await release();
    } catch (err) {
      logger.warn({ err, configPath }, 'Failed to release config lock — may be stale');
    }
  }
}

/**
 * proper-lockfile requires the lock target to exist on disk. For first-time
 * runs we seed an empty v1.1 skeleton; subsequent runs no-op.
 */
async function ensureLockableDir(projectRoot: string): Promise<void> {
  await mkdir(joinConfigDir(projectRoot), { recursive: true });

  const configPath = joinConfigPath(projectRoot);
  if (!(await fileExists(configPath))) {
    try {
      await writeFile(configPath, `${JSON.stringify(emptySkeleton(), null, 2)}\n`, 'utf-8');
    } catch (err) {
      // Tolerable — another process may have seeded concurrently.
      logger.debug({ err, configPath }, 'Bootstrap seed skipped (likely race)');
    }
  }
}
