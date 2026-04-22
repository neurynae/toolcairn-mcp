import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDir } from '../util/fs.js';
import { parsePomIdentity } from './pom-shared.js';
import type { ResolvedToolIdentity } from './types.js';

/**
 * Look up the installed .pom for "<group>:<artifact>" under `~/.m2/repository`.
 * Maven stores each version under `<group-with-slashes>/<artifact>/<ver>/`.
 * Picks the lexically-highest version present when `resolved_version` is
 * unknown.
 */
async function findMavenPom(
  groupId: string,
  artifactId: string,
  preferredVersion?: string,
): Promise<string | null> {
  const groupPath = groupId.replace(/\./g, '/');
  const base = join(homedir(), '.m2', 'repository', groupPath, artifactId);
  if (!(await isDir(base))) return null;
  let versions: string[];
  try {
    versions = await readdir(base);
  } catch {
    return null;
  }
  let chosen: string | undefined;
  if (preferredVersion && versions.includes(preferredVersion)) {
    chosen = preferredVersion;
  } else {
    versions.sort();
    chosen = versions[versions.length - 1];
  }
  if (!chosen) return null;
  return join(base, chosen, `${artifactId}-${chosen}.pom`);
}

export async function resolveMavenIdentity(
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
  const pomPath = await findMavenPom(groupId, artifactId, hints.resolved_version);
  if (!pomPath) return {};
  return parsePomIdentity(pomPath, depName);
}
