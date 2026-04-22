import { access, readdir, stat } from 'node:fs/promises';

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Directories that discovery + language-detect never descend into. */
export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.nuxt',
  'target', // rust, java
  'vendor', // go, ruby, composer
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.pytest_cache',
  '.mypy_cache',
  'bin',
  'obj', // dotnet
  '.gradle',
  '.idea',
  '.vscode',
  '.DS_Store',
  'coverage',
  '.cache',
  '.pnpm-store',
]);

/** Yields absolute paths of every dir the walker should consider. */
export async function* walkDirs(root: string, maxDepth = 6): AsyncGenerator<string> {
  yield root;
  yield* walkDirsInner(root, 0, maxDepth);
}

async function* walkDirsInner(
  dir: string,
  depth: number,
  maxDepth: number,
): AsyncGenerator<string> {
  if (depth >= maxDepth) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (IGNORED_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('.') && !['.github', '.claude', '.toolcairn'].includes(entry.name)) {
      continue;
    }
    const full = `${dir}/${entry.name}`;
    yield full;
    yield* walkDirsInner(full, depth + 1, maxDepth);
  }
}
