import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiscoveryWarning } from '@toolcairn/types';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { fileExists } from '../util/fs.js';
import { expandWorkspaceGlobs, toRelPosix } from './glob.js';

/** Workspace declaration kinds we look for (in priority order per-dir). */
const WORKSPACE_FILES = [
  'pnpm-workspace.yaml',
  'package.json', // yarn / npm workspaces
  'Cargo.toml', // [workspace] members
  'go.work', // Go workspaces
  'turbo.json', // often implies pnpm workspaces — don't add globs itself
  'nx.json',
  'lerna.json',
] as const;

interface PackageJson {
  workspaces?: string[] | { packages?: string[] };
}

interface PnpmWorkspace {
  packages?: string[];
}

interface CargoWorkspaceToml {
  workspace?: { members?: string[] };
}

interface LernaJson {
  packages?: string[];
}

interface NxJson {
  workspaceLayout?: { projectsDir?: string };
}

/**
 * Discover all workspace roots inside a project.
 * Always includes the root itself. Then walks recursive workspace declarations up to `maxDepth`.
 * Returns absolute paths of every directory that should be scanned for manifests.
 */
export async function discoverWorkspaces(
  projectRoot: string,
  maxDepth = 5,
): Promise<{ paths: string[]; warnings: DiscoveryWarning[] }> {
  const warnings: DiscoveryWarning[] = [];
  const discovered = new Set<string>([projectRoot]);
  const visited = new Set<string>();

  const queue: Array<{ dir: string; depth: number }> = [{ dir: projectRoot, depth: 0 }];

  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    if (visited.has(dir) || depth > maxDepth) continue;
    visited.add(dir);

    const globs = await readWorkspaceGlobs(dir, warnings);
    if (globs.length === 0) continue;

    const expanded = await expandWorkspaceGlobs(dir, globs);
    for (const sub of expanded) {
      if (!discovered.has(sub)) {
        discovered.add(sub);
        queue.push({ dir: sub, depth: depth + 1 });
      }
    }
  }

  return { paths: [...discovered].sort(), warnings };
}

async function readWorkspaceGlobs(dir: string, warnings: DiscoveryWarning[]): Promise<string[]> {
  const globs: string[] = [];

  // pnpm-workspace.yaml
  const pnpmPath = join(dir, 'pnpm-workspace.yaml');
  if (await fileExists(pnpmPath)) {
    try {
      const doc = parseYaml(await readFile(pnpmPath, 'utf-8')) as PnpmWorkspace;
      if (Array.isArray(doc.packages)) globs.push(...doc.packages);
    } catch (err) {
      warnings.push({
        scope: 'workspace:pnpm',
        path: pnpmPath,
        message: `Failed to parse pnpm-workspace.yaml: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // package.json workspaces (npm / yarn)
  const pkgPath = join(dir, 'package.json');
  if (await fileExists(pkgPath)) {
    try {
      const doc = JSON.parse(await readFile(pkgPath, 'utf-8')) as PackageJson;
      if (Array.isArray(doc.workspaces)) {
        globs.push(...doc.workspaces);
      } else if (doc.workspaces && Array.isArray(doc.workspaces.packages)) {
        globs.push(...doc.workspaces.packages);
      }
    } catch (err) {
      warnings.push({
        scope: 'workspace:package-json',
        path: pkgPath,
        message: `Failed to parse package.json#workspaces: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Cargo.toml [workspace] members
  const cargoPath = join(dir, 'Cargo.toml');
  if (await fileExists(cargoPath)) {
    try {
      const doc = parseToml(await readFile(cargoPath, 'utf-8')) as CargoWorkspaceToml;
      if (Array.isArray(doc.workspace?.members)) globs.push(...doc.workspace.members);
    } catch (err) {
      warnings.push({
        scope: 'workspace:cargo',
        path: cargoPath,
        message: `Failed to parse Cargo workspace: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // go.work
  const goWorkPath = join(dir, 'go.work');
  if (await fileExists(goWorkPath)) {
    try {
      const raw = await readFile(goWorkPath, 'utf-8');
      const useMatch = raw.match(/use\s*\(([^)]*)\)/s);
      if (useMatch?.[1]) {
        for (const line of useMatch[1].split('\n')) {
          const trimmed = line.trim().replace(/^['"]|['"]$/g, '');
          if (trimmed && !trimmed.startsWith('//')) globs.push(trimmed);
        }
      } else {
        for (const line of raw.split('\n')) {
          const m = line.match(/^\s*use\s+(.+)$/);
          if (m?.[1]) globs.push(m[1].trim().replace(/^['"]|['"]$/g, ''));
        }
      }
    } catch (err) {
      warnings.push({
        scope: 'workspace:go',
        path: goWorkPath,
        message: `Failed to parse go.work: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // lerna.json
  const lernaPath = join(dir, 'lerna.json');
  if (await fileExists(lernaPath)) {
    try {
      const doc = JSON.parse(await readFile(lernaPath, 'utf-8')) as LernaJson;
      if (Array.isArray(doc.packages)) globs.push(...doc.packages);
    } catch (err) {
      warnings.push({
        scope: 'workspace:lerna',
        path: lernaPath,
        message: `Failed to parse lerna.json: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // nx.json — defaults to "packages/*" when projectsDir unset
  const nxPath = join(dir, 'nx.json');
  if (await fileExists(nxPath)) {
    try {
      const doc = JSON.parse(await readFile(nxPath, 'utf-8')) as NxJson;
      const base = doc.workspaceLayout?.projectsDir ?? 'packages';
      globs.push(`${base}/*`);
    } catch (err) {
      warnings.push({
        scope: 'workspace:nx',
        path: nxPath,
        message: `Failed to parse nx.json: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return globs;
}

/**
 * Given a set of absolute workspace paths, produce `{path, manifest, ecosystem}`
 * entries for each workspace that has at least one manifest. Consumed by scanProject
 * to populate `project.subprojects`.
 */
export function summariseSubprojects(
  projectRoot: string,
  workspaces: string[],
): Array<{ workspace_path: string; rel: string }> {
  return workspaces.map((abs) => ({ workspace_path: abs, rel: toRelPosix(projectRoot, abs) }));
}
