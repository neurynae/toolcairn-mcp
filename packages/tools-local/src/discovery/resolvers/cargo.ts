import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createMcpLogger } from '@toolcairn/errors';
import { parse as parseToml } from 'smol-toml';
import { fileExists, isDir } from '../util/fs.js';
import type { ResolvedToolIdentity } from './types.js';
import { normaliseGitHubUrl } from './url-normalise.js';

const logger = createMcpLogger({ name: '@toolcairn/tools:resolver:cargo' });

interface CargoToml {
  package?: {
    name?: string;
    version?: string;
    repository?: string;
    homepage?: string;
  };
}

/**
 * Find cached source of a crate under `~/.cargo/registry/src/<index-host>-*`.
 * Each crate is checked out as `<name>-<version>`. We prefer the exact version
 * when the caller supplied it (via lockfile resolved_version); otherwise pick
 * the lexically-highest matching dir.
 */
async function findCachedCrate(name: string, preferredVersion?: string): Promise<string | null> {
  const registryRoot = join(homedir(), '.cargo', 'registry', 'src');
  if (!(await isDir(registryRoot))) return null;
  let indexHosts: string[];
  try {
    indexHosts = await readdir(registryRoot);
  } catch {
    return null;
  }
  const matches: string[] = [];
  for (const host of indexHosts) {
    const hostDir = join(registryRoot, host);
    if (!(await isDir(hostDir))) continue;
    let entries: string[];
    try {
      entries = await readdir(hostDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith(`${name}-`)) continue;
      if (preferredVersion && entry !== `${name}-${preferredVersion}`) continue;
      const manifestPath = join(hostDir, entry, 'Cargo.toml');
      if (await fileExists(manifestPath)) matches.push(manifestPath);
    }
  }
  if (matches.length === 0) return null;
  matches.sort();
  return matches[matches.length - 1] ?? null;
}

export async function resolveCargoIdentity(
  _workspaceAbs: string,
  _projectRoot: string,
  depName: string,
  hints: { resolved_version?: string } = {},
): Promise<ResolvedToolIdentity> {
  const manifestPath = await findCachedCrate(depName, hints.resolved_version);
  if (!manifestPath) return {};
  try {
    const raw = await readFile(manifestPath, 'utf-8');
    const doc = parseToml(raw) as CargoToml;
    const pkg = doc.package;
    if (!pkg) return {};
    const out: ResolvedToolIdentity = {};
    if (pkg.name && pkg.name !== depName) out.canonical_package_name = pkg.name;
    if (pkg.version) out.resolved_version = pkg.version;
    const normalised = normaliseGitHubUrl(pkg.repository ?? pkg.homepage);
    if (normalised) out.github_url = normalised;
    return out;
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), manifestPath },
      'Failed to parse cached Cargo.toml',
    );
    return {};
  }
}
