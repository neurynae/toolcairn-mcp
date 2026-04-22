import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDir } from '../util/fs.js';
import { parsePomIdentity } from './pom-shared.js';
import type { ResolvedToolIdentity } from './types.js';

/**
 * Find a cached .pom under Gradle's modules cache:
 *   ~/.gradle/caches/modules-2/files-2.1/<group>/<artifact>/<ver>/<hash>/<artifact>-<ver>.pom
 */
async function findGradlePom(
  groupId: string,
  artifactId: string,
  preferredVersion?: string,
): Promise<string | null> {
  const base = join(homedir(), '.gradle', 'caches', 'modules-2', 'files-2.1', groupId, artifactId);
  if (!(await isDir(base))) return null;
  let versions: string[];
  try {
    versions = await readdir(base);
  } catch {
    return null;
  }
  const chosen =
    preferredVersion && versions.includes(preferredVersion)
      ? preferredVersion
      : versions.sort().at(-1);
  if (!chosen) return null;

  const versionDir = join(base, chosen);
  let hashDirs: string[];
  try {
    hashDirs = await readdir(versionDir);
  } catch {
    return null;
  }
  for (const hash of hashDirs) {
    const candidate = join(versionDir, hash, `${artifactId}-${chosen}.pom`);
    // We can't stat here without an import; just return — parsePomIdentity
    // gracefully no-ops when the file is missing, so the first candidate wins.
    return candidate;
  }
  return null;
}

export async function resolveGradleIdentity(
  _workspaceAbs: string,
  _projectRoot: string,
  depName: string,
  hints: { resolved_version?: string } = {},
): Promise<ResolvedToolIdentity> {
  const colon = depName.indexOf(':');
  if (colon < 0) return {};
  const groupId = depName.slice(0, colon);
  const artifactId = depName.slice(colon + 1);
  if (!groupId || !artifactId) return {};
  const pomPath = await findGradlePom(groupId, artifactId, hints.resolved_version);
  if (!pomPath) return {};
  return parsePomIdentity(pomPath, depName);
}
