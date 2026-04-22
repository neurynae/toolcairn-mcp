import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiscoveryWarning, ManifestSection } from '@toolcairn/types';
import { parse as parseYaml } from 'yaml';
import type { ParseResult, Parser } from '../types.js';
import { fileExists } from '../util/fs.js';

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

interface PnpmLockPackage {
  version?: string;
}

interface PnpmLock {
  importers?: Record<
    string,
    {
      dependencies?: Record<string, { version?: string } | string>;
      devDependencies?: Record<string, { version?: string } | string>;
      peerDependencies?: Record<string, { version?: string } | string>;
      optionalDependencies?: Record<string, { version?: string } | string>;
    }
  >;
  packages?: Record<string, PnpmLockPackage>;
}

interface NpmLockDep {
  version?: string;
  resolved?: string;
  dev?: boolean;
  optional?: boolean;
  peer?: boolean;
}

interface NpmLock {
  packages?: Record<string, NpmLockDep>;
  dependencies?: Record<string, NpmLockDep>;
}

const SECTION_MAP: Array<[keyof PackageJson, ManifestSection]> = [
  ['dependencies', 'dep'],
  ['devDependencies', 'dev'],
  ['peerDependencies', 'peer'],
  ['optionalDependencies', 'optional'],
];

/** Extracts raw `X.Y.Z` version from a pnpm key like "/@scope/name@1.2.3(peer@...)". */
function stripPnpmRange(raw: string): string | undefined {
  // pnpm v6/v7 entries in `packages` look like "/react@18.2.0(peer@...)".
  const atIdx = raw.lastIndexOf('@');
  if (atIdx <= 0) return undefined;
  const tail = raw.slice(atIdx + 1);
  const parenIdx = tail.indexOf('(');
  return parenIdx >= 0 ? tail.slice(0, parenIdx) : tail || undefined;
}

/** Resolves a dep's version from pnpm-lock importers + packages. */
function resolvePnpmVersion(
  lock: PnpmLock,
  importerKey: string,
  section: 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies',
  depName: string,
): string | undefined {
  const importer = lock.importers?.[importerKey];
  const entry = importer?.[section]?.[depName];
  if (!entry) return undefined;
  if (typeof entry === 'string') return entry;
  if (entry.version) {
    // pnpm v8+: version field contains the raw version; strip any "(peer...)" suffix
    const parenIdx = entry.version.indexOf('(');
    return parenIdx >= 0 ? entry.version.slice(0, parenIdx) : entry.version;
  }
  return undefined;
}

/** Resolves from package-lock.json (npm v7+ `packages` object keyed by "node_modules/X"). */
function resolveNpmLockVersion(lock: NpmLock, depName: string): string | undefined {
  const key = `node_modules/${depName}`;
  return lock.packages?.[key]?.version ?? lock.dependencies?.[depName]?.version;
}

export const parseNpm: Parser = async ({ workspace_dir, workspace_rel }): Promise<ParseResult> => {
  const warnings: DiscoveryWarning[] = [];
  const tools: ParseResult['tools'] = [];

  const manifestPath = join(workspace_dir, 'package.json');
  if (!(await fileExists(manifestPath))) {
    return { ecosystem: 'npm', tools, warnings };
  }

  let manifest: PackageJson;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as PackageJson;
  } catch (err) {
    warnings.push({
      scope: 'parser:npm',
      path: manifestPath,
      message: `Failed to parse package.json: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { ecosystem: 'npm', tools, warnings };
  }

  // Try to load a lockfile for resolved versions. Prefer pnpm > npm > yarn.
  let pnpmLock: PnpmLock | undefined;
  let npmLock: NpmLock | undefined;

  const pnpmLockPath = join(workspace_dir, 'pnpm-lock.yaml');
  const npmLockPath = join(workspace_dir, 'package-lock.json');

  if (await fileExists(pnpmLockPath)) {
    try {
      pnpmLock = parseYaml(await readFile(pnpmLockPath, 'utf-8')) as PnpmLock;
    } catch (err) {
      warnings.push({
        scope: 'parser:npm',
        path: pnpmLockPath,
        message: `Failed to parse pnpm-lock.yaml, falling back to manifest: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else if (await fileExists(npmLockPath)) {
    try {
      npmLock = JSON.parse(await readFile(npmLockPath, 'utf-8')) as NpmLock;
    } catch (err) {
      warnings.push({
        scope: 'parser:npm',
        path: npmLockPath,
        message: `Failed to parse package-lock.json, falling back to manifest: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else if (!(await fileExists(join(workspace_dir, 'yarn.lock')))) {
    warnings.push({
      scope: 'parser:npm',
      path: manifestPath,
      message: 'No lockfile present — resolved_version will be absent.',
    });
  }

  const manifestFile = workspace_rel ? `${workspace_rel}/package.json` : 'package.json';
  // In pnpm-lock, the root importer is "." and sub-workspaces use their relative paths.
  const pnpmImporterKey = workspace_rel || '.';

  for (const [field, section] of SECTION_MAP) {
    const deps = manifest[field] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const [name, constraint] of Object.entries(deps)) {
      let resolved: string | undefined;
      if (pnpmLock) {
        resolved = resolvePnpmVersion(
          pnpmLock,
          pnpmImporterKey,
          field as Exclude<typeof field, 'workspaces' | 'name'>,
          name,
        );
      } else if (npmLock) {
        resolved = resolveNpmLockVersion(npmLock, name);
      }

      tools.push({
        name,
        ecosystem: 'npm',
        version_constraint: constraint,
        resolved_version: resolved,
        section,
        manifest_file: manifestFile,
        workspace_path: workspace_rel,
      });
    }
  }

  // Avoid unused-symbol warnings — stripPnpmRange is reserved for future "packages" fallback.
  void stripPnpmRange;

  return { ecosystem: 'npm', tools, warnings };
};
