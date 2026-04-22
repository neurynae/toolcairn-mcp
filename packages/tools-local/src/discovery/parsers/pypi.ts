import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiscoveryWarning, ManifestSection } from '@toolcairn/types';
import { parse as parseToml } from 'smol-toml';
import type { ParseResult, Parser } from '../types.js';
import { fileExists } from '../util/fs.js';

interface PyProject {
  project?: {
    name?: string;
    dependencies?: string[];
    'optional-dependencies'?: Record<string, string[]>;
  };
  tool?: {
    poetry?: {
      name?: string;
      dependencies?: Record<string, string | { version?: string }>;
      'dev-dependencies'?: Record<string, string | { version?: string }>;
      group?: Record<string, { dependencies?: Record<string, string | { version?: string }> }>;
    };
    uv?: {
      'dev-dependencies'?: string[];
    };
  };
  'dependency-groups'?: Record<string, string[]>;
}

interface UvLockPackage {
  name?: string;
  version?: string;
}

interface UvLock {
  package?: UvLockPackage[];
}

/** Parses "fastapi>=0.100.0" / "django[argon2]<5" into {name, constraint}. */
function parseRequirementString(raw: string): { name: string; constraint?: string } | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  // Split on first of <, >, =, ~, !, [, ;, space
  const match = trimmed.match(/^([A-Za-z0-9_.\-]+)(\[[^\]]*\])?(.*)$/);
  if (!match || !match[1]) return null;
  const constraint = (match[3] ?? '').trim();
  return { name: match[1], constraint: constraint || undefined };
}

function addPoetryDeps(
  obj: Record<string, string | { version?: string }> | undefined,
  section: ManifestSection,
  out: ParseResult['tools'],
  manifestFile: string,
  workspaceRel: string,
  resolvedVersions: Map<string, string>,
): void {
  if (!obj) return;
  for (const [name, value] of Object.entries(obj)) {
    if (name === 'python') continue; // Poetry's python interpreter pin
    const constraint = typeof value === 'string' ? value : value.version;
    out.push({
      name,
      ecosystem: 'pypi',
      version_constraint: constraint,
      resolved_version: resolvedVersions.get(name.toLowerCase()),
      section,
      manifest_file: manifestFile,
      workspace_path: workspaceRel,
    });
  }
}

export const parsePypi: Parser = async ({ workspace_dir, workspace_rel }): Promise<ParseResult> => {
  const warnings: DiscoveryWarning[] = [];
  const tools: ParseResult['tools'] = [];

  // Build resolved-version map from uv.lock if present.
  const resolved = new Map<string, string>();
  const uvLockPath = join(workspace_dir, 'uv.lock');
  if (await fileExists(uvLockPath)) {
    try {
      const lock = parseToml(await readFile(uvLockPath, 'utf-8')) as UvLock;
      for (const pkg of lock.package ?? []) {
        if (pkg.name && pkg.version) resolved.set(pkg.name.toLowerCase(), pkg.version);
      }
    } catch (err) {
      warnings.push({
        scope: 'parser:pypi',
        path: uvLockPath,
        message: `Failed to parse uv.lock: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // 1) pyproject.toml (strongest signal)
  const pyprojectPath = join(workspace_dir, 'pyproject.toml');
  if (await fileExists(pyprojectPath)) {
    try {
      const doc = parseToml(await readFile(pyprojectPath, 'utf-8')) as PyProject;
      const manifestFile = workspace_rel ? `${workspace_rel}/pyproject.toml` : 'pyproject.toml';

      // PEP 621 / uv style: [project].dependencies = ["fastapi>=0.100", ...]
      for (const dep of doc.project?.dependencies ?? []) {
        const parsed = parseRequirementString(dep);
        if (!parsed) continue;
        tools.push({
          name: parsed.name,
          ecosystem: 'pypi',
          version_constraint: parsed.constraint,
          resolved_version: resolved.get(parsed.name.toLowerCase()),
          section: 'dep',
          manifest_file: manifestFile,
          workspace_path: workspace_rel,
        });
      }
      for (const [groupName, deps] of Object.entries(
        doc.project?.['optional-dependencies'] ?? {},
      )) {
        for (const dep of deps) {
          const parsed = parseRequirementString(dep);
          if (!parsed) continue;
          tools.push({
            name: parsed.name,
            ecosystem: 'pypi',
            version_constraint: parsed.constraint,
            resolved_version: resolved.get(parsed.name.toLowerCase()),
            section: groupName === 'dev' ? 'dev' : 'optional',
            manifest_file: manifestFile,
            workspace_path: workspace_rel,
          });
        }
      }

      // PEP 735 / uv style: [dependency-groups]
      for (const [groupName, deps] of Object.entries(doc['dependency-groups'] ?? {})) {
        for (const dep of deps) {
          const parsed = parseRequirementString(dep);
          if (!parsed) continue;
          tools.push({
            name: parsed.name,
            ecosystem: 'pypi',
            version_constraint: parsed.constraint,
            resolved_version: resolved.get(parsed.name.toLowerCase()),
            section: groupName === 'dev' ? 'dev' : 'optional',
            manifest_file: manifestFile,
            workspace_path: workspace_rel,
          });
        }
      }

      // Poetry style: [tool.poetry.dependencies]
      addPoetryDeps(
        doc.tool?.poetry?.dependencies,
        'dep',
        tools,
        manifestFile,
        workspace_rel,
        resolved,
      );
      addPoetryDeps(
        doc.tool?.poetry?.['dev-dependencies'],
        'dev',
        tools,
        manifestFile,
        workspace_rel,
        resolved,
      );
      for (const group of Object.values(doc.tool?.poetry?.group ?? {})) {
        addPoetryDeps(group.dependencies, 'dev', tools, manifestFile, workspace_rel, resolved);
      }

      if (tools.length > 0) return { ecosystem: 'pypi', tools, warnings };
    } catch (err) {
      warnings.push({
        scope: 'parser:pypi',
        path: pyprojectPath,
        message: `Failed to parse pyproject.toml: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // 2) Fallback: requirements.txt (+ requirements-dev.txt)
  for (const [file, section] of [
    ['requirements.txt', 'dep'] as const,
    ['requirements-dev.txt', 'dev'] as const,
    ['dev-requirements.txt', 'dev'] as const,
  ]) {
    const path = join(workspace_dir, file);
    if (!(await fileExists(path))) continue;
    try {
      const raw = await readFile(path, 'utf-8');
      const manifestFile = workspace_rel ? `${workspace_rel}/${file}` : file;
      for (const line of raw.split('\n')) {
        const parsed = parseRequirementString(line);
        if (!parsed) continue;
        tools.push({
          name: parsed.name,
          ecosystem: 'pypi',
          version_constraint: parsed.constraint,
          resolved_version: resolved.get(parsed.name.toLowerCase()),
          section,
          manifest_file: manifestFile,
          workspace_path: workspace_rel,
        });
      }
    } catch (err) {
      warnings.push({
        scope: 'parser:pypi',
        path,
        message: `Failed to read ${file}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { ecosystem: 'pypi', tools, warnings };
};
