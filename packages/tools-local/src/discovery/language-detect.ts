import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { ProjectLanguage } from '@toolcairn/types';
import { IGNORED_DIRS } from './util/fs.js';

/** File extension → language name. Only extensions with clear 1:1 mapping. */
const EXT_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.py': 'Python',
  '.pyi': 'Python',
  '.rs': 'Rust',
  '.go': 'Go',
  '.rb': 'Ruby',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.kts': 'Kotlin',
  '.scala': 'Scala',
  '.php': 'PHP',
  '.ex': 'Elixir',
  '.exs': 'Elixir',
  '.erl': 'Erlang',
  '.dart': 'Dart',
  '.cs': 'C#',
  '.fs': 'F#',
  '.vb': 'Visual Basic',
  '.swift': 'Swift',
  '.c': 'C',
  '.h': 'C',
  '.cpp': 'C++',
  '.cxx': 'C++',
  '.cc': 'C++',
  '.hpp': 'C++',
  '.m': 'Objective-C',
  '.mm': 'Objective-C',
  '.lua': 'Lua',
  '.r': 'R',
  '.jl': 'Julia',
  '.nim': 'Nim',
  '.zig': 'Zig',
  '.clj': 'Clojure',
  '.cljs': 'Clojure',
  '.hs': 'Haskell',
  '.elm': 'Elm',
  '.ml': 'OCaml',
  '.mli': 'OCaml',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
  '.astro': 'Astro',
};

/**
 * Walk the tree once, counting files per language globally and per workspace.
 * A workspace is any directory passed in `workspaceRels` (relative, POSIX-normalised).
 * Root workspace is represented as "" and always included.
 *
 * The walker skips IGNORED_DIRS (node_modules, target, dist, etc.) — a file inside
 * node_modules is never counted.
 */
export async function detectLanguages(
  projectRoot: string,
  workspaceRels: string[],
): Promise<ProjectLanguage[]> {
  const globalCounts = new Map<string, number>();
  const perWorkspace = new Map<string, Map<string, number>>(); // workspace_rel → lang → count

  // Sort workspace rels longest-first so deeper workspaces claim their files before parents.
  const sortedRels = [...workspaceRels, '']
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .sort((a, b) => b.length - a.length);
  for (const rel of sortedRels) perWorkspace.set(rel, new Map());

  await walk(projectRoot, projectRoot, globalCounts, perWorkspace, sortedRels);

  return [...globalCounts.entries()]
    .map(([name, file_count]) => {
      const workspaces = sortedRels
        .filter((rel) => (perWorkspace.get(rel)?.get(name) ?? 0) > 0)
        .map((rel) => rel || '.');
      return { name, file_count, workspaces };
    })
    .filter((l) => l.file_count > 0)
    .sort((a, b) => b.file_count - a.file_count);
}

async function walk(
  root: string,
  dir: string,
  global: Map<string, number>,
  perWorkspace: Map<string, Map<string, number>>,
  workspaceRels: string[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.github') {
      if (!['.toolcairn', '.claude'].includes(entry.name)) continue;
    }
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, full, global, perWorkspace, workspaceRels);
    } else if (entry.isFile()) {
      const ext = pickExtension(entry.name);
      if (!ext) continue;
      const lang = EXT_TO_LANGUAGE[ext];
      if (!lang) continue;
      global.set(lang, (global.get(lang) ?? 0) + 1);
      // Find the deepest workspace that owns this file
      const relFile = relative(root, full).split(sep).join('/');
      for (const wsRel of workspaceRels) {
        if (wsRel === '' || relFile === wsRel || relFile.startsWith(`${wsRel}/`)) {
          const m = perWorkspace.get(wsRel);
          if (m) m.set(lang, (m.get(lang) ?? 0) + 1);
          break;
        }
      }
    }
  }
}

function pickExtension(filename: string): string | null {
  const idx = filename.lastIndexOf('.');
  if (idx < 0 || idx === 0) return null;
  return filename.slice(idx).toLowerCase();
}
