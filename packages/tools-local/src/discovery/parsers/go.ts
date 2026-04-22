import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiscoveryWarning } from '@toolcairn/types';
import type { ParseResult, Parser } from '../types.js';
import { fileExists } from '../util/fs.js';

/**
 * Parses go.mod — line-oriented format:
 *   require (
 *       github.com/foo/bar v1.2.3
 *       github.com/baz/qux v0.5.1 // indirect
 *   )
 * Or single-line: require github.com/foo/bar v1.2.3
 */
function parseGoMod(raw: string): Array<{ name: string; version: string; indirect: boolean }> {
  const out: Array<{ name: string; version: string; indirect: boolean }> = [];
  const lines = raw.split('\n');
  let inRequireBlock = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    const commentTail = rawLine.match(/\/\/\s*(.*)$/)?.[1] ?? '';
    const indirect = /\bindirect\b/.test(commentTail);
    if (!line) continue;
    if (line === 'require (') {
      inRequireBlock = true;
      continue;
    }
    if (line === ')') {
      inRequireBlock = false;
      continue;
    }
    if (line.startsWith('require ')) {
      // single-line require github.com/x v1.0.0
      const parts = line.slice(8).trim().split(/\s+/);
      if (parts[0] && parts[1]) out.push({ name: parts[0], version: parts[1], indirect });
      continue;
    }
    if (inRequireBlock) {
      const parts = line.split(/\s+/);
      if (parts[0] && parts[1]) out.push({ name: parts[0], version: parts[1], indirect });
    }
  }
  return out;
}

export const parseGo: Parser = async ({ workspace_dir, workspace_rel }): Promise<ParseResult> => {
  const warnings: DiscoveryWarning[] = [];
  const tools: ParseResult['tools'] = [];

  const modPath = join(workspace_dir, 'go.mod');
  if (!(await fileExists(modPath))) return { ecosystem: 'go', tools, warnings };

  try {
    const raw = await readFile(modPath, 'utf-8');
    const manifestFile = workspace_rel ? `${workspace_rel}/go.mod` : 'go.mod';
    for (const dep of parseGoMod(raw)) {
      tools.push({
        name: dep.name,
        ecosystem: 'go',
        version_constraint: dep.version,
        resolved_version: dep.version, // go.mod pins exact version
        section: dep.indirect ? 'optional' : 'dep',
        manifest_file: manifestFile,
        workspace_path: workspace_rel,
      });
    }
  } catch (err) {
    warnings.push({
      scope: 'parser:go',
      path: modPath,
      message: `Failed to parse go.mod: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return { ecosystem: 'go', tools, warnings };
};
