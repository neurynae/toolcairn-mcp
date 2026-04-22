import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiscoveryWarning, ManifestSection } from '@toolcairn/types';
import { parse as parseToml } from 'smol-toml';
import type { ParseResult, Parser } from '../types.js';
import { fileExists } from '../util/fs.js';

interface CargoToml {
  package?: { name?: string };
  dependencies?: Record<string, string | { version?: string }>;
  'dev-dependencies'?: Record<string, string | { version?: string }>;
  'build-dependencies'?: Record<string, string | { version?: string }>;
  workspace?: {
    dependencies?: Record<string, string | { version?: string }>;
    members?: string[];
  };
}

interface CargoLock {
  package?: Array<{ name?: string; version?: string }>;
}

const SECTION_MAP: Array<[keyof CargoToml, ManifestSection]> = [
  ['dependencies', 'dep'],
  ['dev-dependencies', 'dev'],
  ['build-dependencies', 'build'],
];

function extractDeps(
  obj: Record<string, string | { version?: string }> | undefined,
  section: ManifestSection,
  resolved: Map<string, string>,
  out: ParseResult['tools'],
  manifestFile: string,
  workspaceRel: string,
): void {
  if (!obj) return;
  for (const [name, value] of Object.entries(obj)) {
    const constraint = typeof value === 'string' ? value : value.version;
    out.push({
      name,
      ecosystem: 'cargo',
      version_constraint: constraint,
      resolved_version: resolved.get(name),
      section,
      manifest_file: manifestFile,
      workspace_path: workspaceRel,
    });
  }
}

export const parseCargo: Parser = async ({
  workspace_dir,
  workspace_rel,
}): Promise<ParseResult> => {
  const warnings: DiscoveryWarning[] = [];
  const tools: ParseResult['tools'] = [];

  const manifestPath = join(workspace_dir, 'Cargo.toml');
  if (!(await fileExists(manifestPath))) return { ecosystem: 'cargo', tools, warnings };

  let manifest: CargoToml;
  try {
    manifest = parseToml(await readFile(manifestPath, 'utf-8')) as CargoToml;
  } catch (err) {
    warnings.push({
      scope: 'parser:cargo',
      path: manifestPath,
      message: `Failed to parse Cargo.toml: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { ecosystem: 'cargo', tools, warnings };
  }

  const resolved = new Map<string, string>();
  const lockPath = join(workspace_dir, 'Cargo.lock');
  if (await fileExists(lockPath)) {
    try {
      const lock = parseToml(await readFile(lockPath, 'utf-8')) as CargoLock;
      for (const pkg of lock.package ?? []) {
        if (pkg.name && pkg.version) resolved.set(pkg.name, pkg.version);
      }
    } catch (err) {
      warnings.push({
        scope: 'parser:cargo',
        path: lockPath,
        message: `Failed to parse Cargo.lock: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const manifestFile = workspace_rel ? `${workspace_rel}/Cargo.toml` : 'Cargo.toml';

  for (const [field, section] of SECTION_MAP) {
    extractDeps(
      manifest[field] as Record<string, string | { version?: string }> | undefined,
      section,
      resolved,
      tools,
      manifestFile,
      workspace_rel,
    );
  }

  // Workspace-level dependencies (shared across members)
  extractDeps(
    manifest.workspace?.dependencies,
    'dep',
    resolved,
    tools,
    manifestFile,
    workspace_rel,
  );

  return { ecosystem: 'cargo', tools, warnings };
};
