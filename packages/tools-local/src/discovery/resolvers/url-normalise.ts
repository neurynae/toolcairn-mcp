/**
 * Normalise any flavour of git repository URL to https://github.com/owner/repo.
 * Returns null for URLs outside github.com (we only resolve those for now —
 * other forges (gitlab, bitbucket) are a follow-up, and `undefined` stops
 * the MCP client from sending garbage to the engine's exact-match filter).
 *
 * Handles:
 *   - git+https://github.com/owner/repo.git          → https://github.com/owner/repo
 *   - git+ssh://git@github.com/owner/repo.git        → https://github.com/owner/repo
 *   - git@github.com:owner/repo.git                  → https://github.com/owner/repo
 *   - https://github.com/owner/repo/                 → https://github.com/owner/repo
 *   - github:owner/repo  (npm shorthand)             → https://github.com/owner/repo
 *   - owner/repo  (npm shorthand — short-form)       → https://github.com/owner/repo
 */
export function normaliseGitHubUrl(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  let s = raw.trim();
  if (!s) return undefined;

  if (s.startsWith('git+')) s = s.slice(4);

  // npm shorthand: "github:foo/bar"
  if (s.startsWith('github:')) {
    s = `https://github.com/${s.slice(7)}`;
  }

  // npm short-form shorthand: "foo/bar" (no slashes other than the separator)
  if (/^[A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+$/.test(s)) {
    s = `https://github.com/${s}`;
  }

  // git@github.com:owner/repo(.git)
  s = s.replace(/^git@github\.com:/, 'https://github.com/');
  // ssh://git@github.com/owner/repo(.git)
  s = s.replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/');
  // http → https
  s = s.replace(/^http:\/\//, 'https://');

  // Must be github.com
  if (!/^https:\/\/github\.com\//.test(s)) return undefined;

  // Strip trailing / and .git
  s = s.replace(/\.git$/, '');
  s = s.replace(/\/$/, '');

  // Guard: must have exactly owner/repo path
  const match = s.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) return undefined;
  return `https://github.com/${match[1]}/${match[2]}`;
}
