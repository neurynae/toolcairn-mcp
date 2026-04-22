import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiscoveryWarning, ManifestSection } from '@toolcairn/types';
import { XMLParser } from 'fast-xml-parser';
import type { ParseResult, Parser } from '../types.js';
import { fileExists } from '../util/fs.js';

interface MavenDep {
  groupId?: string;
  artifactId?: string;
  version?: string;
  scope?: string;
  optional?: string | boolean;
}

interface MavenPom {
  project?: {
    dependencies?: { dependency?: MavenDep | MavenDep[] };
    dependencyManagement?: { dependencies?: { dependency?: MavenDep | MavenDep[] } };
  };
}

function scopeToSection(scope: string | undefined, optional: boolean): ManifestSection {
  if (optional) return 'optional';
  switch (scope) {
    case 'test':
    case 'provided':
      return 'dev';
    default:
      return 'dep';
  }
}

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export const parseMaven: Parser = async ({
  workspace_dir,
  workspace_rel,
}): Promise<ParseResult> => {
  const warnings: DiscoveryWarning[] = [];
  const tools: ParseResult['tools'] = [];

  const pomPath = join(workspace_dir, 'pom.xml');
  if (!(await fileExists(pomPath))) return { ecosystem: 'maven', tools, warnings };

  let doc: MavenPom;
  try {
    const raw = await readFile(pomPath, 'utf-8');
    const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: true });
    doc = parser.parse(raw) as MavenPom;
  } catch (err) {
    warnings.push({
      scope: 'parser:maven',
      path: pomPath,
      message: `Failed to parse pom.xml: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { ecosystem: 'maven', tools, warnings };
  }

  const manifestFile = workspace_rel ? `${workspace_rel}/pom.xml` : 'pom.xml';
  const deps = toArray(doc.project?.dependencies?.dependency);
  const managedDeps = toArray(doc.project?.dependencyManagement?.dependencies?.dependency);
  let hasUnresolvedVariable = false;

  for (const dep of [...deps, ...managedDeps]) {
    if (!dep.groupId || !dep.artifactId) continue;
    const name = `${dep.groupId}:${dep.artifactId}`;
    const version = typeof dep.version === 'string' ? dep.version : undefined;
    if (version && version.includes('${')) hasUnresolvedVariable = true;
    const optional = dep.optional === true || dep.optional === 'true';
    tools.push({
      name,
      ecosystem: 'maven',
      version_constraint: version,
      resolved_version: version && !version.includes('${') ? version : undefined,
      section: scopeToSection(dep.scope, optional),
      manifest_file: manifestFile,
      workspace_path: workspace_rel,
    });
  }

  if (hasUnresolvedVariable) {
    warnings.push({
      scope: 'parser:maven',
      path: pomPath,
      message:
        'Some dependencies use ${...} variable interpolation which is not resolved — version info may be incomplete.',
    });
  }

  return { ecosystem: 'maven', tools, warnings };
};
