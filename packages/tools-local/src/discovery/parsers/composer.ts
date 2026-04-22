import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiscoveryWarning, ManifestSection } from '@toolcairn/types';
import type { ParseResult, Parser } from '../types.js';
import { fileExists } from '../util/fs.js';

interface ComposerJson {
  require?: Record<string, string>;
  'require-dev'?: Record<string, string>;
}

interface ComposerLockPackage {
  name?: string;
  version?: string;
}

interface ComposerLock {
  packages?: ComposerLockPackage[];
  'packages-dev'?: ComposerLockPackage[];
}

/** Skips PHP platform pseudo-packages that aren't real deps. */
function isPhpPlatform(name: string): boolean {
  return name === 'php' || name.startsWith('ext-') || name.startsWith('lib-');
}

export const parseComposer: Parser = async ({
  workspace_dir,
  workspace_rel,
}): Promise<ParseResult> => {
  const warnings: DiscoveryWarning[] = [];
  const tools: ParseResult['tools'] = [];

  const lockPath = join(workspace_dir, 'composer.lock');
  const manifestPath = join(workspace_dir, 'composer.json');

  // Prefer lockfile
  if (await fileExists(lockPath)) {
    try {
      const lock = JSON.parse(await readFile(lockPath, 'utf-8')) as ComposerLock;
      const manifestFile = workspace_rel ? `${workspace_rel}/composer.lock` : 'composer.lock';
      for (const [pkgs, section] of [
        [lock.packages ?? [], 'dep'] as const,
        [lock['packages-dev'] ?? [], 'dev'] as const,
      ]) {
        for (const pkg of pkgs) {
          if (!pkg.name || isPhpPlatform(pkg.name)) continue;
          tools.push({
            name: pkg.name,
            ecosystem: 'composer',
            version_constraint: undefined,
            resolved_version: pkg.version,
            section: section as ManifestSection,
            manifest_file: manifestFile,
            workspace_path: workspace_rel,
          });
        }
      }
      if (tools.length > 0) return { ecosystem: 'composer', tools, warnings };
    } catch (err) {
      warnings.push({
        scope: 'parser:composer',
        path: lockPath,
        message: `Failed to parse composer.lock: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Fallback: composer.json
  if (await fileExists(manifestPath)) {
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as ComposerJson;
      const manifestFile = workspace_rel ? `${workspace_rel}/composer.json` : 'composer.json';
      for (const [obj, section] of [
        [manifest.require, 'dep'] as const,
        [manifest['require-dev'], 'dev'] as const,
      ]) {
        for (const [name, constraint] of Object.entries(obj ?? {})) {
          if (isPhpPlatform(name)) continue;
          tools.push({
            name,
            ecosystem: 'composer',
            version_constraint: constraint,
            section: section as ManifestSection,
            manifest_file: manifestFile,
            workspace_path: workspace_rel,
          });
        }
      }
    } catch (err) {
      warnings.push({
        scope: 'parser:composer',
        path: manifestPath,
        message: `Failed to parse composer.json: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { ecosystem: 'composer', tools, warnings };
};
