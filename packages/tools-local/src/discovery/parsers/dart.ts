import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiscoveryWarning, ManifestSection } from '@toolcairn/types';
import { parse as parseYaml } from 'yaml';
import type { ParseResult, Parser } from '../types.js';
import { fileExists } from '../util/fs.js';

interface Pubspec {
  name?: string;
  dependencies?: Record<string, string | { version?: string; sdk?: string; path?: string }>;
  dev_dependencies?: Record<string, string | { version?: string; sdk?: string; path?: string }>;
}

interface PubspecLockPackage {
  version?: string;
  dependency?: string;
}

interface PubspecLock {
  packages?: Record<string, PubspecLockPackage>;
}

function isSkippableDep(value: unknown): boolean {
  if (typeof value === 'object' && value !== null) {
    const v = value as { sdk?: string; path?: string };
    if (v.sdk || v.path) return true;
  }
  return false;
}

function extractDeps(
  obj: Pubspec['dependencies'],
  section: ManifestSection,
  resolved: Map<string, string>,
  out: ParseResult['tools'],
  manifestFile: string,
  workspaceRel: string,
): void {
  if (!obj) return;
  for (const [name, value] of Object.entries(obj)) {
    if (isSkippableDep(value)) continue;
    const constraint = typeof value === 'string' ? value : value.version;
    out.push({
      name,
      ecosystem: 'pub',
      version_constraint: constraint,
      resolved_version: resolved.get(name),
      section,
      manifest_file: manifestFile,
      workspace_path: workspaceRel,
    });
  }
}

export const parseDart: Parser = async ({ workspace_dir, workspace_rel }): Promise<ParseResult> => {
  const warnings: DiscoveryWarning[] = [];
  const tools: ParseResult['tools'] = [];

  const pubspecPath = join(workspace_dir, 'pubspec.yaml');
  if (!(await fileExists(pubspecPath))) return { ecosystem: 'pub', tools, warnings };

  let pubspec: Pubspec;
  try {
    pubspec = parseYaml(await readFile(pubspecPath, 'utf-8')) as Pubspec;
  } catch (err) {
    warnings.push({
      scope: 'parser:dart',
      path: pubspecPath,
      message: `Failed to parse pubspec.yaml: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { ecosystem: 'pub', tools, warnings };
  }

  const resolved = new Map<string, string>();
  const lockPath = join(workspace_dir, 'pubspec.lock');
  if (await fileExists(lockPath)) {
    try {
      const lock = parseYaml(await readFile(lockPath, 'utf-8')) as PubspecLock;
      for (const [name, pkg] of Object.entries(lock.packages ?? {})) {
        if (pkg.version) resolved.set(name, pkg.version);
      }
    } catch (err) {
      warnings.push({
        scope: 'parser:dart',
        path: lockPath,
        message: `Failed to parse pubspec.lock: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const manifestFile = workspace_rel ? `${workspace_rel}/pubspec.yaml` : 'pubspec.yaml';
  extractDeps(pubspec.dependencies, 'dep', resolved, tools, manifestFile, workspace_rel);
  extractDeps(pubspec.dev_dependencies, 'dev', resolved, tools, manifestFile, workspace_rel);

  return { ecosystem: 'pub', tools, warnings };
};
