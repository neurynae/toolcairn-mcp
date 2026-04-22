import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createMcpLogger } from '@toolcairn/errors';
import { fileExists } from '../util/fs.js';
import type { ResolvedToolIdentity } from './types.js';
import { normaliseGitHubUrl } from './url-normalise.js';

const logger = createMcpLogger({ name: '@toolcairn/tools:resolver:composer' });

interface InstalledComposerJson {
  name?: string;
  version?: string;
  homepage?: string;
  source?: { url?: string };
  support?: { source?: string };
}

/**
 * Read the installed vendored composer.json for `<vendor>/<pkg>` and extract
 * canonical name + github_url. Composer lays installed deps out as
 * `<ws>/vendor/<vendor>/<pkg>/composer.json`, so the dep name is already a
 * path hint.
 */
export async function resolveComposerIdentity(
  workspaceAbs: string,
  _projectRoot: string,
  depName: string,
): Promise<ResolvedToolIdentity> {
  // depName is "vendor/package" — matches the vendor dir layout directly.
  const path = join(workspaceAbs, 'vendor', depName, 'composer.json');
  if (!(await fileExists(path))) return {};
  try {
    const pkg = JSON.parse(await readFile(path, 'utf-8')) as InstalledComposerJson;
    const out: ResolvedToolIdentity = {};
    if (pkg.name && pkg.name !== depName) out.canonical_package_name = pkg.name;
    if (pkg.version) out.resolved_version = pkg.version;
    const candidateUrl = pkg.source?.url ?? pkg.support?.source ?? pkg.homepage;
    const normalised = normaliseGitHubUrl(candidateUrl);
    if (normalised) out.github_url = normalised;
    return out;
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), path },
      'Failed to parse installed composer.json',
    );
    return {};
  }
}
