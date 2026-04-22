import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createMcpLogger } from '@toolcairn/errors';
import { fileExists } from '../util/fs.js';
import type { ResolvedToolIdentity } from './types.js';
import { normaliseGitHubUrl } from './url-normalise.js';

const logger = createMcpLogger({ name: '@toolcairn/tools:resolver:npm' });

/**
 * npm `repository` field shapes (all are valid per package.json spec):
 *   "repository": "github:owner/repo"
 *   "repository": "owner/repo"
 *   "repository": "https://github.com/owner/repo.git"
 *   "repository": { "type": "git", "url": "git+https://github.com/owner/repo.git" }
 *   "repository": { "type": "git", "url": "...", "directory": "packages/foo" }
 */
interface InstalledPackageJson {
  name?: string;
  version?: string;
  repository?: string | { type?: string; url?: string; directory?: string };
  homepage?: string;
}

function extractRepoUrl(pkg: InstalledPackageJson): string | undefined {
  const r = pkg.repository;
  if (!r) return undefined;
  if (typeof r === 'string') return r;
  return r.url;
}

/**
 * Walk up from workspaceAbs looking for node_modules/<depName>/package.json.
 * npm workspaces / pnpm hoist installed deps somewhere between the workspace
 * and the repo root, so we climb until we either find it or hit the filesystem
 * root. Returns `null` when no installed manifest is present.
 */
async function findInstalledManifest(
  workspaceAbs: string,
  projectRoot: string,
  depKey: string,
): Promise<string | null> {
  let cursor = workspaceAbs;
  // Stop at projectRoot's parent so we don't stray outside the repo.
  const stopAt = projectRoot;
  // Safety cap on traversal depth in case the path normalisation misfires.
  for (let i = 0; i < 10; i++) {
    const candidate = join(cursor, 'node_modules', depKey, 'package.json');
    if (await fileExists(candidate)) return candidate;
    if (cursor === stopAt) break;
    const parent = join(cursor, '..');
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

/**
 * Resolve canonical package name + github_url for a detected npm dep by reading
 * its INSTALLED manifest under node_modules. Pure local (no network, no registry
 * hit). Silently returns an empty identity when node_modules isn't present —
 * the MCP handler then falls back to raw dep-key matching server-side.
 */
export async function resolveNpmIdentity(
  workspaceAbs: string,
  projectRoot: string,
  depKey: string,
): Promise<ResolvedToolIdentity> {
  const manifestPath = await findInstalledManifest(workspaceAbs, projectRoot, depKey);
  if (!manifestPath) return {};
  let pkg: InstalledPackageJson;
  try {
    pkg = JSON.parse(await readFile(manifestPath, 'utf-8')) as InstalledPackageJson;
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), manifestPath },
      'Failed to parse installed package.json — skipping url resolution',
    );
    return {};
  }
  const out: ResolvedToolIdentity = {};
  if (pkg.name && pkg.name !== depKey) {
    // Only set canonical_package_name when it actually differs from the dep key
    // (common case: aliased installs). Otherwise we'd send redundant data.
    out.canonical_package_name = pkg.name;
  }
  if (pkg.version) {
    out.resolved_version = pkg.version;
  }
  const url = extractRepoUrl(pkg);
  const normalised = normaliseGitHubUrl(url);
  if (normalised) out.github_url = normalised;
  return out;
}
