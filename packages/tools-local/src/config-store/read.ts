import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createMcpLogger } from '@toolcairn/errors';
import type { ToolPilotProjectConfig } from '@toolcairn/types';
import { fileExists } from '../discovery/util/fs.js';
import { CONFIG_DIR, joinConfigPath } from './paths.js';

const logger = createMcpLogger({ name: '@toolcairn/tools:config-store' });

export interface ReadConfigResult {
  /** Parsed config, or null when config.json is absent (caller should bootstrap). */
  config: ToolPilotProjectConfig | null;
  /** Absolute path we attempted to read. */
  path: string;
  /** When parsing failed, the corrupt file is renamed here; null means no corruption. */
  corrupt_backup_path: string | null;
}

/**
 * Reads `.toolcairn/config.json` from the project root.
 *
 * - Returns `{ config: null }` when the file does not exist (no error).
 * - On JSON parse failure: renames the corrupt file to
 *   `.toolcairn/config.json.corrupt.<ISO-timestamp>` and returns `{ config: null }`
 *   — callers will bootstrap a fresh skeleton without clobbering recoverable data.
 */
export async function readConfig(projectRoot: string): Promise<ReadConfigResult> {
  const configPath = joinConfigPath(projectRoot);

  if (!(await fileExists(configPath))) {
    return { config: null, path: configPath, corrupt_backup_path: null };
  }

  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch (err) {
    logger.error({ err, configPath }, 'Failed to read config.json');
    throw err;
  }

  try {
    const parsed = JSON.parse(raw) as ToolPilotProjectConfig;
    return { config: parsed, path: configPath, corrupt_backup_path: null };
  } catch (err) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = join(projectRoot, CONFIG_DIR, `config.json.corrupt.${stamp}`);
    try {
      await rename(configPath, backup);
      logger.warn({ configPath, backup, err }, 'config.json was unparseable — moved to backup');
    } catch (renameErr) {
      logger.error({ err: renameErr, configPath, backup }, 'Failed to rename corrupt config.json');
    }
    return { config: null, path: configPath, corrupt_backup_path: backup };
  }
}
