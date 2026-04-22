import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createMcpLogger } from '@toolcairn/errors';
import { fileExists } from '../util/fs.js';
import type { ResolvedToolIdentity } from './types.js';
import { normaliseGitHubUrl } from './url-normalise.js';

const logger = createMcpLogger({ name: '@toolcairn/tools:resolver:swift-pm' });

interface PackageResolvedV1 {
  object?: {
    pins?: Array<{ package?: string; repositoryURL?: string; state?: { version?: string } }>;
  };
  pins?: Array<{ identity?: string; location?: string; state?: { version?: string } }>;
}

/**
 * SwiftPM records canonical VCS URLs in Package.resolved — one line per pin.
 * The upstream parser already reads this file; the resolver reads it again
 * (cheap, no I/O budget to care about) to get an authoritative github_url
 * per dep without a filesystem walk through ~/Library/Caches.
 */
export async function resolveSwiftPmIdentity(
  workspaceAbs: string,
  _projectRoot: string,
  depName: string,
): Promise<ResolvedToolIdentity> {
  const path = join(workspaceAbs, 'Package.resolved');
  if (!(await fileExists(path))) return {};
  try {
    const raw = await readFile(path, 'utf-8');
    const doc = JSON.parse(raw) as PackageResolvedV1;
    const out: ResolvedToolIdentity = {};
    // v2 format: { pins: [{ identity, location, state: {version} }] }
    for (const pin of doc.pins ?? []) {
      if (pin.identity === depName) {
        if (pin.state?.version) out.resolved_version = pin.state.version;
        const normalised = normaliseGitHubUrl(pin.location);
        if (normalised) out.github_url = normalised;
        return out;
      }
    }
    // v1 format: { object: { pins: [{ package, repositoryURL, state }] } }
    for (const pin of doc.object?.pins ?? []) {
      if (pin.package === depName) {
        if (pin.state?.version) out.resolved_version = pin.state.version;
        const normalised = normaliseGitHubUrl(pin.repositoryURL);
        if (normalised) out.github_url = normalised;
        return out;
      }
    }
    return {};
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), path },
      'Failed to parse Package.resolved during resolve',
    );
    return {};
  }
}
