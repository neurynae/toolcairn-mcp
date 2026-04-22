import type { ResolvedToolIdentity } from './types.js';
import { normaliseGitHubUrl } from './url-normalise.js';

/**
 * Go modules ARE the import path — no filesystem lookup required. For any
 * github.com-hosted module, the github_url is derivable in pure constant time:
 *   github.com/vercel/next.js      → https://github.com/vercel/next.js
 *   github.com/foo/bar/v2          → https://github.com/foo/bar     (strip /vN)
 *   github.com/foo/bar/subpackage  → https://github.com/foo/bar     (owner/repo only)
 *
 * Non-github modules (e.g. golang.org/x/net, gopkg.in/*, bitbucket.org/*)
 * return an empty identity — the MCP resolver cascade catches them via
 * registry_package_keys if indexed, or Memgraph name fallback.
 */
export function resolveGoIdentity(
  _workspaceAbs: string,
  _projectRoot: string,
  depName: string,
): ResolvedToolIdentity {
  if (!depName.startsWith('github.com/')) return {};
  const tail = depName.slice('github.com/'.length);
  const parts = tail.split('/');
  if (parts.length < 2 || !parts[0] || !parts[1]) return {};
  const owner = parts[0];
  let repo = parts[1];
  // Strip /vN version-suffix segments and sub-packages by only keeping owner/repo.
  repo = repo.replace(/\.git$/, '');
  const url = normaliseGitHubUrl(`https://github.com/${owner}/${repo}`);
  return url ? { github_url: url } : {};
}
