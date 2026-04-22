import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiscoveryWarning } from '@toolcairn/types';
import type { ParseResult, Parser } from '../types.js';
import { fileExists } from '../util/fs.js';

/**
 * Parses Gemfile.lock GEM section:
 *   GEM
 *     remote: https://rubygems.org/
 *     specs:
 *       rails (7.1.2)
 *       actionmailer (7.1.2)
 */
function parseGemfileLock(raw: string): Array<{ name: string; version: string }> {
  const out: Array<{ name: string; version: string }> = [];
  const lines = raw.split('\n');
  let inSpecs = false;
  for (const line of lines) {
    if (line.trim() === 'specs:') {
      inSpecs = true;
      continue;
    }
    if (inSpecs) {
      if (!line.startsWith('    ')) {
        inSpecs = false;
        continue;
      }
      // 4-space indented = top-level spec; 6-space indented = transitive dep
      const match = line.match(/^ {4}([A-Za-z0-9_\-.]+) \(([^)]+)\)/);
      if (match?.[1] && match[2]) out.push({ name: match[1], version: match[2] });
    }
  }
  return out;
}

/**
 * Parses Gemfile — Ruby DSL:
 *   gem 'rails', '~> 7.1'
 *   gem "devise"
 *   group :development do
 *     gem "rspec-rails"
 *   end
 */
function parseGemfile(raw: string): Array<{ name: string; constraint?: string; dev: boolean }> {
  const out: Array<{ name: string; constraint?: string; dev: boolean }> = [];
  const lines = raw.split('\n');
  let groupDepth = 0;
  let inDevGroup = false;
  for (const rawLine of lines) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (!line) continue;
    const groupMatch = line.match(/^group\s+(:[\w,\s:]+?)\s*do\s*$/);
    if (groupMatch && groupMatch[1]) {
      groupDepth++;
      inDevGroup = /\b(development|test)\b/.test(groupMatch[1]);
      continue;
    }
    if (line === 'end' && groupDepth > 0) {
      groupDepth--;
      if (groupDepth === 0) inDevGroup = false;
      continue;
    }
    const gemMatch = line.match(/^gem\s+(['"])([A-Za-z0-9_\-.]+)\1(?:\s*,\s*(['"])([^'"]+)\3)?/);
    if (gemMatch?.[2]) {
      out.push({ name: gemMatch[2], constraint: gemMatch[4], dev: inDevGroup });
    }
  }
  return out;
}

export const parseRuby: Parser = async ({ workspace_dir, workspace_rel }): Promise<ParseResult> => {
  const warnings: DiscoveryWarning[] = [];
  const tools: ParseResult['tools'] = [];

  const lockPath = join(workspace_dir, 'Gemfile.lock');
  const gemfilePath = join(workspace_dir, 'Gemfile');

  // Prefer lockfile
  if (await fileExists(lockPath)) {
    try {
      const raw = await readFile(lockPath, 'utf-8');
      const manifestFile = workspace_rel ? `${workspace_rel}/Gemfile.lock` : 'Gemfile.lock';
      // To know dep vs transitive, we also need Gemfile. Just mark all as 'dep' for now.
      const declared = new Set<string>();
      if (await fileExists(gemfilePath)) {
        try {
          const gemRaw = await readFile(gemfilePath, 'utf-8');
          for (const gem of parseGemfile(gemRaw)) declared.add(gem.name);
        } catch {
          /* non-fatal */
        }
      }
      for (const spec of parseGemfileLock(raw)) {
        // Skip if gemspec doesn't declare and we have a Gemfile — transitive
        if (declared.size > 0 && !declared.has(spec.name)) continue;
        tools.push({
          name: spec.name,
          ecosystem: 'rubygems',
          version_constraint: undefined,
          resolved_version: spec.version,
          section: 'dep',
          manifest_file: manifestFile,
          workspace_path: workspace_rel,
        });
      }
      if (tools.length > 0) return { ecosystem: 'rubygems', tools, warnings };
    } catch (err) {
      warnings.push({
        scope: 'parser:ruby',
        path: lockPath,
        message: `Failed to parse Gemfile.lock: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Fallback: Gemfile
  if (await fileExists(gemfilePath)) {
    try {
      const raw = await readFile(gemfilePath, 'utf-8');
      const manifestFile = workspace_rel ? `${workspace_rel}/Gemfile` : 'Gemfile';
      for (const gem of parseGemfile(raw)) {
        tools.push({
          name: gem.name,
          ecosystem: 'rubygems',
          version_constraint: gem.constraint,
          section: gem.dev ? 'dev' : 'dep',
          manifest_file: manifestFile,
          workspace_path: workspace_rel,
        });
      }
      warnings.push({
        scope: 'parser:ruby',
        path: manifestFile,
        message: 'No Gemfile.lock — resolved_version unavailable.',
      });
    } catch (err) {
      warnings.push({
        scope: 'parser:ruby',
        path: gemfilePath,
        message: `Failed to parse Gemfile: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { ecosystem: 'rubygems', tools, warnings };
};
