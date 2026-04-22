import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { IGNORED_DIRS, isDir } from '../util/fs.js';

/**
 * Minimal glob-pattern expansion for workspace declarations.
 * Handles:
 *   - exact paths: "apps/web"
 *   - single-level wildcards: "packages/*"
 *   - recursive wildcards: "packages/**" (treated same as packages/* + one level deep)
 *   - negation: "!packages/internal-*" (excluded post-match)
 *
 * This is intentionally small — we don't need full minimatch semantics because
 * workspace globs are universally "<prefix>/*" or "<prefix>/**" in practice.
 */
export async function expandWorkspaceGlobs(rootDir: string, patterns: string[]): Promise<string[]> {
  const excluded = new Set<string>();
  const included = new Set<string>();

  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern) continue;
    const negated = pattern.startsWith('!');
    const clean = negated ? pattern.slice(1) : pattern;
    // Normalise separators to POSIX for pattern matching; join() later restores OS.
    const normalised = clean.replace(/\\/g, '/');
    const matches = await matchPattern(rootDir, normalised);
    const target = negated ? excluded : included;
    for (const m of matches) target.add(m);
  }

  return [...included].filter((p) => !excluded.has(p)).sort();
}

async function matchPattern(rootDir: string, pattern: string): Promise<string[]> {
  const parts = pattern.split('/').filter(Boolean);
  const results: string[] = [];
  await walkPattern(rootDir, rootDir, parts, 0, results);
  return results;
}

async function walkPattern(
  rootDir: string,
  currentDir: string,
  parts: string[],
  index: number,
  out: string[],
): Promise<void> {
  if (index >= parts.length) {
    if (await isDir(currentDir)) out.push(currentDir);
    return;
  }
  const segment = parts[index];
  if (!segment) return;

  if (segment === '**') {
    // Match this level AND one level deep (common workspace pattern)
    await walkPattern(rootDir, currentDir, parts, index + 1, out);
    try {
      const entries = await readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue;
        await walkPattern(rootDir, join(currentDir, entry.name), parts, index, out);
      }
    } catch {
      /* skip */
    }
    return;
  }

  if (segment.includes('*')) {
    const re = globSegmentToRegex(segment);
    try {
      const entries = await readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue;
        if (re.test(entry.name)) {
          await walkPattern(rootDir, join(currentDir, entry.name), parts, index + 1, out);
        }
      }
    } catch {
      /* skip */
    }
    return;
  }

  // Literal segment
  await walkPattern(rootDir, join(currentDir, segment), parts, index + 1, out);
}

function globSegmentToRegex(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/** Convert absolute workspace dir to project-root-relative path with forward slashes. */
export function toRelPosix(projectRoot: string, absPath: string): string {
  const rel = relative(projectRoot, absPath);
  return rel.split(sep).join('/');
}
