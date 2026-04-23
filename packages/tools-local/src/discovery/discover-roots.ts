/**
 * Discover every independent project root under a given directory.
 *
 * A "project root" is any directory containing a primary manifest file
 * (package.json, Cargo.toml, pyproject.toml, go.mod, Gemfile, pom.xml,
 * build.gradle*, composer.json, mix.exs, pubspec.yaml, *.csproj, Package.swift).
 *
 * Candidates that are declared workspace members of a kept ancestor (pnpm /
 * yarn / npm / cargo / go workspaces, etc.) are dropped — the ancestor's
 * scan-project walk picks them up via `discoverWorkspaces()`.
 *
 * Used by `autoInitProject` wiring in the MCP server's auth handler so one
 * invocation of `npx toolcairn-mcp` covers any sibling-repo layout (e.g.
 * `D:\Workspace\{app,api,web}\` where the parent has no manifest of its own).
 */
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createMcpLogger } from '@toolcairn/errors';
import { IGNORED_DIRS, fileExists, isDir } from './util/fs.js';
import { discoverWorkspaces } from './workspaces/walker.js';

const logger = createMcpLogger({ name: '@toolcairn/tools:discover-roots' });

/** Files whose presence marks a directory as a project root candidate. */
const EXACT_MANIFEST_NAMES = [
  'package.json',
  'Cargo.toml',
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
  'setup.cfg',
  'go.mod',
  'Gemfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'mix.exs',
  'pubspec.yaml',
  'Package.swift',
] as const;

/** File extensions that mark a directory as a project root (any file with the extension). */
const MANIFEST_EXTENSIONS = ['.csproj', '.fsproj', '.sln'] as const;

export interface DiscoverRootsOptions {
  /** Maximum BFS depth below `cwd`. Matches the scanner's default. */
  maxDepth?: number;
}

export interface DiscoverRootsResult {
  roots: string[];
  /** True iff no candidate was found and `cwd` was used as a fallback root. */
  usedFallback: boolean;
}

/**
 * BFS-walk `cwd` and return every discovered project root (absolute paths).
 *
 * Fallback: when nothing matches, returns `[resolve(cwd)]` so downstream
 * callers always have at least one root to write a `.toolcairn/` into.
 */
export async function discoverProjectRoots(
  cwd: string,
  options: DiscoverRootsOptions = {},
): Promise<DiscoverRootsResult> {
  const { maxDepth = 5 } = options;
  const root = resolve(cwd);

  // 1. BFS collect every directory holding a primary manifest.
  const candidates = await collectManifestDirs(root, maxDepth);
  if (candidates.length === 0) {
    logger.info({ cwd: root }, 'No project roots discovered — falling back to cwd itself');
    return { roots: [root], usedFallback: true };
  }

  // Shortest path first — ensures shallower candidates get to claim their
  // subtree via `discoverWorkspaces()` before deeper ones are considered.
  candidates.sort((a, b) => a.split(/[\\/]/).length - b.split(/[\\/]/).length || a.localeCompare(b));

  // 2. Dedup: ancestors claim workspace members.
  const surviving = new Set(candidates);
  for (const candidate of candidates) {
    if (!surviving.has(candidate)) continue;
    const ws = await discoverWorkspaces(candidate, maxDepth).catch(() => ({ paths: [candidate] }));
    if (ws.paths.length <= 1) continue; // Not a workspace root
    for (const member of ws.paths) {
      if (member === candidate) continue;
      // A workspace member that is also an independent candidate → drop it.
      if (surviving.has(member)) {
        surviving.delete(member);
      }
    }
  }

  const roots = [...surviving].sort();
  logger.info(
    { cwd: root, candidates: candidates.length, roots: roots.length },
    'Discovered project roots',
  );
  return { roots, usedFallback: false };
}

/** BFS walk — yields any dir whose contents match the manifest criteria. */
async function collectManifestDirs(root: string, maxDepth: number): Promise<string[]> {
  const hits: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    if (depth > maxDepth) continue;

    if (await hasPrimaryManifest(dir)) hits.push(dir);

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (IGNORED_DIRS.has(entry.name)) continue;
      // Hidden dirs are noise except for known tool dirs — which themselves
      // never hold manifests, so skipping all dotted dirs here is safe.
      if (entry.name.startsWith('.')) continue;
      queue.push({ dir: resolve(dir, entry.name), depth: depth + 1 });
    }
  }

  // Deduplicate while preserving first occurrence order.
  return [...new Set(hits)];
}

/** Cheap check — exits on first hit. */
async function hasPrimaryManifest(dir: string): Promise<boolean> {
  if (!(await isDir(dir))) return false;

  for (const name of EXACT_MANIFEST_NAMES) {
    if (await fileExists(resolve(dir, name))) return true;
  }

  // Extension match — readdir once, scan names.
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return false;
  }
  for (const name of entries) {
    for (const ext of MANIFEST_EXTENSIONS) {
      if (name.endsWith(ext)) return true;
    }
  }
  return false;
}
