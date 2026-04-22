import { readFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { createMcpLogger } from '@toolcairn/errors';
import { parse as parseYaml } from 'yaml';
import { fileExists } from '../util/fs.js';
import type { ResolvedToolIdentity } from './types.js';
import { normaliseGitHubUrl } from './url-normalise.js';

const logger = createMcpLogger({ name: '@toolcairn/tools:resolver:pub' });

interface PubSpec {
  name?: string;
  version?: string;
  homepage?: string;
  repository?: string;
  issue_tracker?: string;
}

/**
 * Dart/Flutter pub cache locations:
 *   macOS/Linux: ~/.pub-cache/hosted/pub.dev/<name>-<ver>/pubspec.yaml
 *   Windows    : %LOCALAPPDATA%\Pub\Cache\hosted\pub.dev\<name>-<ver>\pubspec.yaml
 */
function pubCacheRoot(): string {
  if (platform() === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (local) return join(local, 'Pub', 'Cache', 'hosted', 'pub.dev');
  }
  return join(homedir(), '.pub-cache', 'hosted', 'pub.dev');
}

async function findPubspec(depName: string, version?: string): Promise<string | null> {
  const root = pubCacheRoot();
  if (version) {
    const direct = join(root, `${depName}-${version}`, 'pubspec.yaml');
    return (await fileExists(direct)) ? direct : null;
  }
  // Fallback: pick any installed version of this package.
  try {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(root);
    const matches = entries.filter((e) => e.startsWith(`${depName}-`)).sort();
    const chosen = matches.at(-1);
    if (!chosen) return null;
    const candidate = join(root, chosen, 'pubspec.yaml');
    return (await fileExists(candidate)) ? candidate : null;
  } catch {
    return null;
  }
}

export async function resolvePubIdentity(
  _workspaceAbs: string,
  _projectRoot: string,
  depName: string,
  hints: { resolved_version?: string } = {},
): Promise<ResolvedToolIdentity> {
  const path = await findPubspec(depName, hints.resolved_version);
  if (!path) return {};
  try {
    const raw = await readFile(path, 'utf-8');
    const pkg = parseYaml(raw) as PubSpec;
    const out: ResolvedToolIdentity = {};
    if (pkg.name && pkg.name !== depName) out.canonical_package_name = pkg.name;
    if (pkg.version) out.resolved_version = pkg.version;
    const candidate = normaliseGitHubUrl(pkg.repository ?? pkg.homepage);
    if (candidate) out.github_url = candidate;
    return out;
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), path },
      'Failed to parse pubspec.yaml',
    );
    return {};
  }
}
