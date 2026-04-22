import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiscoveryWarning, ManifestSection } from '@toolcairn/types';
import type { ParseResult, Parser } from '../types.js';
import { fileExists } from '../util/fs.js';

/** gradle.lockfile is deterministic: one line per dep as "group:name:version=configurations". */
function parseGradleLockfile(
  raw: string,
): Array<{ group: string; name: string; version: string; configurations: string[] }> {
  const out: Array<{ group: string; name: string; version: string; configurations: string[] }> = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([^:]+):([^:]+):([^=]+)=(.*)$/);
    if (match?.[1] && match[2] && match[3]) {
      out.push({
        group: match[1],
        name: match[2],
        version: match[3],
        configurations: (match[4] ?? '').split(',').map((s) => s.trim()),
      });
    }
  }
  return out;
}

function gradleConfigToSection(configs: string[]): ManifestSection {
  const joined = configs.join(' ').toLowerCase();
  if (joined.includes('test')) return 'dev';
  if (joined.includes('annotationprocessor') || joined.includes('kapt')) return 'build';
  return 'dep';
}

/** Shallow build.gradle(.kts) regex scan: `implementation "group:name:version"`. */
function parseBuildGradle(raw: string): Array<{ spec: string; config: string }> {
  const out: Array<{ spec: string; config: string }> = [];
  // Groovy: implementation 'group:name:version'
  // Kotlin: implementation("group:name:version")
  const patterns = [
    /(implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|annotationProcessor|kapt|ksp)\s*\(?\s*(['"])([A-Za-z0-9_.\-]+:[A-Za-z0-9_.\-]+:[^'"]+)\2/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(raw)) !== null) {
      if (match[1] && match[3]) out.push({ spec: match[3], config: match[1] });
    }
  }
  return out;
}

function configKeywordToSection(config: string): ManifestSection {
  const c = config.toLowerCase();
  if (c.startsWith('test')) return 'dev';
  if (c.includes('annotationprocessor') || c === 'kapt' || c === 'ksp') return 'build';
  return 'dep';
}

export const parseGradle: Parser = async ({
  workspace_dir,
  workspace_rel,
}): Promise<ParseResult> => {
  const warnings: DiscoveryWarning[] = [];
  const tools: ParseResult['tools'] = [];

  const lockPath = join(workspace_dir, 'gradle.lockfile');
  if (await fileExists(lockPath)) {
    try {
      const raw = await readFile(lockPath, 'utf-8');
      const manifestFile = workspace_rel ? `${workspace_rel}/gradle.lockfile` : 'gradle.lockfile';
      for (const dep of parseGradleLockfile(raw)) {
        tools.push({
          name: `${dep.group}:${dep.name}`,
          ecosystem: 'gradle',
          version_constraint: dep.version,
          resolved_version: dep.version,
          section: gradleConfigToSection(dep.configurations),
          manifest_file: manifestFile,
          workspace_path: workspace_rel,
        });
      }
      if (tools.length > 0) return { ecosystem: 'gradle', tools, warnings };
    } catch (err) {
      warnings.push({
        scope: 'parser:gradle',
        path: lockPath,
        message: `Failed to parse gradle.lockfile: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Fallback: shallow regex scan of build.gradle / build.gradle.kts
  for (const filename of ['build.gradle.kts', 'build.gradle']) {
    const path = join(workspace_dir, filename);
    if (!(await fileExists(path))) continue;
    try {
      const raw = await readFile(path, 'utf-8');
      const manifestFile = workspace_rel ? `${workspace_rel}/${filename}` : filename;
      let hasVariable = false;
      for (const dep of parseBuildGradle(raw)) {
        const parts = dep.spec.split(':');
        if (parts.length < 3 || !parts[0] || !parts[1]) continue;
        const version = parts.slice(2).join(':');
        if (version.startsWith('$') || version.includes('${')) {
          hasVariable = true;
          continue;
        }
        tools.push({
          name: `${parts[0]}:${parts[1]}`,
          ecosystem: 'gradle',
          version_constraint: version,
          section: configKeywordToSection(dep.config),
          manifest_file: manifestFile,
          workspace_path: workspace_rel,
        });
      }
      warnings.push({
        scope: 'parser:gradle',
        path: manifestFile,
        message:
          'Shallow parse of build.gradle — results may be incomplete. Add `dependencyLocking` to the project for deterministic discovery.',
      });
      if (hasVariable) {
        warnings.push({
          scope: 'parser:gradle',
          path: manifestFile,
          message: 'Some deps use variable interpolation ($ver / ${var}) — skipped.',
        });
      }
      break;
    } catch (err) {
      warnings.push({
        scope: 'parser:gradle',
        path,
        message: `Failed to read ${filename}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { ecosystem: 'gradle', tools, warnings };
};
