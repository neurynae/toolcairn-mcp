import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createMcpLogger } from '@toolcairn/errors';
import { fileExists, isDir } from '../util/fs.js';
import type { ResolvedToolIdentity } from './types.js';
import { normaliseGitHubUrl } from './url-normalise.js';

const logger = createMcpLogger({ name: '@toolcairn/tools:resolver:ruby' });

/**
 * Find a candidate "<name>-<ver>.gemspec" in well-known locations:
 *   - <ws>/vendor/bundle/ruby/<X>/specifications/
 *   - ~/.gem/specifications/
 *   - ~/.rbenv/versions/<X>/lib/ruby/gems/<Y>/specifications/ (opportunistic)
 *   - System ruby (rare, skipped)
 * (The <X>/<Y> placeholders are enumerated via readdir at runtime.)
 */
async function findGemspec(
  workspaceAbs: string,
  depName: string,
  preferredVersion?: string,
): Promise<string | null> {
  const specsDirs: string[] = [];
  const bundleRubyDir = join(workspaceAbs, 'vendor', 'bundle', 'ruby');
  if (await isDir(bundleRubyDir)) {
    try {
      for (const entry of await readdir(bundleRubyDir)) {
        const dir = join(bundleRubyDir, entry, 'specifications');
        if (await isDir(dir)) specsDirs.push(dir);
      }
    } catch {
      /* skip */
    }
  }
  const homeSpecs = join(homedir(), '.gem', 'specifications');
  if (await isDir(homeSpecs)) specsDirs.push(homeSpecs);

  for (const dir of specsDirs) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    const matches = entries
      .filter((e) => e.endsWith('.gemspec') && e.startsWith(`${depName}-`))
      .filter((e) => {
        if (!preferredVersion) return true;
        return e === `${depName}-${preferredVersion}.gemspec`;
      })
      .sort();
    const chosen = matches.at(-1);
    if (chosen) {
      const path = join(dir, chosen);
      if (await fileExists(path)) return path;
    }
  }
  return null;
}

/**
 * Gemspecs are Ruby DSL, but the relevant fields follow stable patterns.
 * We extract via regex — safer than executing Ruby code.
 */
function extractGemspecFields(raw: string): {
  name?: string;
  version?: string;
  homepage?: string;
  source_code_uri?: string;
} {
  const out: {
    name?: string;
    version?: string;
    homepage?: string;
    source_code_uri?: string;
  } = {};
  const pick = (pattern: RegExp): string | undefined => {
    const m = raw.match(pattern);
    return m ? m[1] : undefined;
  };
  out.name = pick(/(?:s|spec)\.name\s*=\s*(['"])([^'"]+)\1/)
    ? raw.match(/(?:s|spec)\.name\s*=\s*['"]([^'"]+)['"]/)?.[1]
    : undefined;
  out.version = raw.match(/(?:s|spec)\.version\s*=\s*['"]([^'"]+)['"]/)?.[1];
  out.homepage = raw.match(/(?:s|spec)\.homepage\s*=\s*['"]([^'"]+)['"]/)?.[1];
  out.source_code_uri = raw.match(/["']source_code_uri["']\s*=>\s*["']([^'"]+)["']/)?.[1];
  return out;
}

export async function resolveRubyIdentity(
  workspaceAbs: string,
  _projectRoot: string,
  depName: string,
  hints: { resolved_version?: string } = {},
): Promise<ResolvedToolIdentity> {
  const path = await findGemspec(workspaceAbs, depName, hints.resolved_version);
  if (!path) return {};
  try {
    const raw = await readFile(path, 'utf-8');
    const fields = extractGemspecFields(raw);
    const out: ResolvedToolIdentity = {};
    if (fields.name && fields.name !== depName) out.canonical_package_name = fields.name;
    if (fields.version) out.resolved_version = fields.version;
    const candidate = normaliseGitHubUrl(fields.source_code_uri ?? fields.homepage);
    if (candidate) out.github_url = candidate;
    return out;
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), path },
      'Failed to read/parse gemspec',
    );
    return {};
  }
}
