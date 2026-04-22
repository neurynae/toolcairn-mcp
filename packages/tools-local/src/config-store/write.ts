import { mkdir } from 'node:fs/promises';
import { createMcpLogger } from '@toolcairn/errors';
import type { ToolPilotProjectConfig } from '@toolcairn/types';
import writeFileAtomic from 'write-file-atomic';
import { joinConfigDir, joinConfigPath } from './paths.js';

const logger = createMcpLogger({ name: '@toolcairn/tools:config-store' });

/**
 * Atomically writes config.json.
 *
 * Uses `write-file-atomic` which:
 *   - Writes to a same-dir temp file (avoids EXDEV on different volumes).
 *   - fsyncs the temp file and the parent directory (crash-safe).
 *   - Renames to the target (overwrites on Windows via MoveFileExW).
 *   - Retries automatically on EBUSY/EPERM (Windows AV handle contention).
 *
 * Caller MUST hold the cross-process lock — see mutate.ts.
 */
export async function writeConfig(
  projectRoot: string,
  config: ToolPilotProjectConfig,
): Promise<void> {
  // Ensure .toolcairn/ exists (no-op after first write, cheap).
  await mkdir(joinConfigDir(projectRoot), { recursive: true });

  const configPath = joinConfigPath(projectRoot);
  const serialised = `${JSON.stringify(config, null, 2)}\n`;

  await writeFileAtomic(configPath, serialised);
  logger.debug({ configPath, bytes: serialised.length }, 'config.json written atomically');
}
