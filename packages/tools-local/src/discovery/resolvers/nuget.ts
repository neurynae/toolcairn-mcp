import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createMcpLogger } from '@toolcairn/errors';
import { XMLParser } from 'fast-xml-parser';
import { fileExists, isDir } from '../util/fs.js';
import type { ResolvedToolIdentity } from './types.js';
import { normaliseGitHubUrl } from './url-normalise.js';

const logger = createMcpLogger({ name: '@toolcairn/tools:resolver:nuget' });

interface Nuspec {
  package?: {
    metadata?: {
      id?: string;
      version?: string;
      projectUrl?: string;
      repository?: { '@_url'?: string } | { url?: string };
    };
  };
}

/**
 * Find the installed .nuspec under the global NuGet cache:
 *   ~/.nuget/packages/<name-lowercase>/<ver>/<name-lowercase>.nuspec
 */
async function findNuspec(depName: string, preferredVersion?: string): Promise<string | null> {
  const pkgRoot = join(homedir(), '.nuget', 'packages', depName.toLowerCase());
  if (!(await isDir(pkgRoot))) return null;
  let versions: string[];
  try {
    versions = await readdir(pkgRoot);
  } catch {
    return null;
  }
  const chosen =
    preferredVersion && versions.includes(preferredVersion)
      ? preferredVersion
      : versions.sort().at(-1);
  if (!chosen) return null;
  const path = join(pkgRoot, chosen, `${depName.toLowerCase()}.nuspec`);
  return (await fileExists(path)) ? path : null;
}

export async function resolveNugetIdentity(
  _workspaceAbs: string,
  _projectRoot: string,
  depName: string,
  hints: { resolved_version?: string } = {},
): Promise<ResolvedToolIdentity> {
  const path = await findNuspec(depName, hints.resolved_version);
  if (!path) return {};
  try {
    const raw = await readFile(path, 'utf-8');
    const parser = new XMLParser({ ignoreAttributes: false });
    const doc = parser.parse(raw) as Nuspec;
    const meta = doc.package?.metadata;
    if (!meta) return {};
    const out: ResolvedToolIdentity = {};
    if (meta.id && meta.id !== depName) out.canonical_package_name = meta.id;
    if (meta.version) out.resolved_version = meta.version;
    const repoUrl =
      (meta.repository as { '@_url'?: string } | undefined)?.['@_url'] ??
      (meta.repository as { url?: string } | undefined)?.url;
    const candidate = normaliseGitHubUrl(repoUrl ?? meta.projectUrl);
    if (candidate) out.github_url = candidate;
    return out;
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), path },
      'Failed to parse .nuspec',
    );
    return {};
  }
}
