import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiscoveryWarning } from '@toolcairn/types';
import type { ParseResult, Parser } from '../types.js';
import { fileExists } from '../util/fs.js';

/**
 * mix.lock format (Elixir):
 *   %{
 *     "phoenix": {:hex, :phoenix, "1.7.10", "hash", [...], [...]},
 *     "ecto": {:hex, :ecto, "3.11.0", "hash", [...]}
 *   }
 *
 * We just need name + version — extract via regex.
 */
function parseMixLock(raw: string): Array<{ name: string; version: string }> {
  const out: Array<{ name: string; version: string }> = [];
  const pattern = /"([^"]+)":\s*\{\s*:hex\s*,\s*:[A-Za-z_][A-Za-z0-9_]*\s*,\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    if (match[1] && match[2]) out.push({ name: match[1], version: match[2] });
  }
  return out;
}

/**
 * mix.exs deps/0 block (fallback if no mix.lock):
 *   defp deps do
 *     [
 *       {:phoenix, "~> 1.7"},
 *       {:ecto, "~> 3.11", only: [:dev]}
 *     ]
 *   end
 */
function parseMixExs(raw: string): Array<{ name: string; constraint?: string; dev: boolean }> {
  const out: Array<{ name: string; constraint?: string; dev: boolean }> = [];
  const pattern =
    /\{:([a-z_][a-z0-9_]*)\s*,\s*"([^"]+)"(?:[^}]*only:\s*(?:\[?:?([a-z_]+))?[^}]*)?\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    if (match[1]) {
      const onlyScope = match[3];
      out.push({
        name: match[1],
        constraint: match[2],
        dev: onlyScope === 'dev' || onlyScope === 'test',
      });
    }
  }
  return out;
}

export const parseMix: Parser = async ({ workspace_dir, workspace_rel }): Promise<ParseResult> => {
  const warnings: DiscoveryWarning[] = [];
  const tools: ParseResult['tools'] = [];

  const lockPath = join(workspace_dir, 'mix.lock');
  if (await fileExists(lockPath)) {
    try {
      const raw = await readFile(lockPath, 'utf-8');
      const manifestFile = workspace_rel ? `${workspace_rel}/mix.lock` : 'mix.lock';
      for (const dep of parseMixLock(raw)) {
        tools.push({
          name: dep.name,
          ecosystem: 'hex',
          version_constraint: undefined,
          resolved_version: dep.version,
          section: 'dep',
          manifest_file: manifestFile,
          workspace_path: workspace_rel,
        });
      }
      if (tools.length > 0) return { ecosystem: 'hex', tools, warnings };
    } catch (err) {
      warnings.push({
        scope: 'parser:mix',
        path: lockPath,
        message: `Failed to parse mix.lock: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const exsPath = join(workspace_dir, 'mix.exs');
  if (await fileExists(exsPath)) {
    try {
      const raw = await readFile(exsPath, 'utf-8');
      const manifestFile = workspace_rel ? `${workspace_rel}/mix.exs` : 'mix.exs';
      for (const dep of parseMixExs(raw)) {
        tools.push({
          name: dep.name,
          ecosystem: 'hex',
          version_constraint: dep.constraint,
          section: dep.dev ? 'dev' : 'dep',
          manifest_file: manifestFile,
          workspace_path: workspace_rel,
        });
      }
    } catch (err) {
      warnings.push({
        scope: 'parser:mix',
        path: exsPath,
        message: `Failed to parse mix.exs: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { ecosystem: 'hex', tools, warnings };
};
