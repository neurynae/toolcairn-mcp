import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { DiscoveryWarning } from '@toolcairn/types';
import { XMLParser } from 'fast-xml-parser';
import type { ParseResult, Parser } from '../types.js';
import { fileExists } from '../util/fs.js';

interface PackageRef {
  '@_Include'?: string;
  '@_Version'?: string;
  '@_PrivateAssets'?: string;
}

interface CsProj {
  Project?: {
    ItemGroup?:
      | { PackageReference?: PackageRef | PackageRef[] }
      | Array<{ PackageReference?: PackageRef | PackageRef[] }>;
  };
}

interface PackagesConfig {
  packages?: {
    package?: PackageRef | PackageRef[];
  };
}

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export const parseDotnet: Parser = async ({
  workspace_dir,
  workspace_rel,
}): Promise<ParseResult> => {
  const warnings: DiscoveryWarning[] = [];
  const tools: ParseResult['tools'] = [];

  let entries: string[] = [];
  try {
    entries = await readdir(workspace_dir);
  } catch {
    return { ecosystem: 'nuget', tools, warnings };
  }

  const csprojFiles = entries.filter((f) => f.endsWith('.csproj') || f.endsWith('.fsproj'));
  const xmlParser = new XMLParser({ ignoreAttributes: false });

  for (const proj of csprojFiles) {
    const path = join(workspace_dir, proj);
    try {
      const raw = await readFile(path, 'utf-8');
      const doc = xmlParser.parse(raw) as CsProj;
      const itemGroups = Array.isArray(doc.Project?.ItemGroup)
        ? (doc.Project?.ItemGroup ?? [])
        : doc.Project?.ItemGroup
          ? [doc.Project.ItemGroup]
          : [];
      const manifestFile = workspace_rel
        ? `${workspace_rel}/${relative(workspace_dir, path)}`
        : relative(workspace_dir, path);
      for (const group of itemGroups) {
        for (const ref of toArray(group.PackageReference)) {
          const name = ref['@_Include'];
          if (!name) continue;
          const version = ref['@_Version'];
          tools.push({
            name,
            ecosystem: 'nuget',
            version_constraint: version,
            resolved_version: version,
            section: ref['@_PrivateAssets'] ? 'build' : 'dep',
            manifest_file: manifestFile,
            workspace_path: workspace_rel,
          });
        }
      }
    } catch (err) {
      warnings.push({
        scope: 'parser:dotnet',
        path,
        message: `Failed to parse ${proj}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Legacy packages.config (full framework)
  const pkgConfigPath = join(workspace_dir, 'packages.config');
  if (await fileExists(pkgConfigPath)) {
    try {
      const raw = await readFile(pkgConfigPath, 'utf-8');
      const doc = xmlParser.parse(raw) as PackagesConfig;
      const manifestFile = workspace_rel ? `${workspace_rel}/packages.config` : 'packages.config';
      for (const pkg of toArray(doc.packages?.package)) {
        const name = pkg['@_Include'];
        if (!name) continue;
        tools.push({
          name,
          ecosystem: 'nuget',
          version_constraint: pkg['@_Version'],
          resolved_version: pkg['@_Version'],
          section: 'dep',
          manifest_file: manifestFile,
          workspace_path: workspace_rel,
        });
      }
    } catch (err) {
      warnings.push({
        scope: 'parser:dotnet',
        path: pkgConfigPath,
        message: `Failed to parse packages.config: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { ecosystem: 'nuget', tools, warnings };
};
