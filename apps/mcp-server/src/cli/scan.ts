/**
 * `npx @neurynae/toolcairn-mcp scan` — Stack Scanner
 *
 * Reads dependency files from the current directory, looks them up in ToolCairn,
 * and prints: health status, deprecation warnings, and alternative tool suggestions.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { printScanTable } from './formatters/table.js';
import { parseCargoToml } from './parsers/cargo-toml.js';
import { parsePackageJson } from './parsers/package-json.js';
import { parseRequirementsTxt } from './parsers/requirements-txt.js';

const API_BASE = process.env.TOOLPILOT_API_URL ?? 'https://api.neurynae.com';

interface ScanResult {
  name: string;
  found: boolean;
  status: string;
  warnings: string[];
  alternatives: string[];
  complements: string[];
  quality_score: number | null;
}

async function callScanApi(dependencies: string[]): Promise<ScanResult[]> {
  const url = `${API_BASE}/v1/scan`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dependencies }),
  });

  if (!res.ok) {
    throw new Error(`ToolCairn API returned ${res.status}`);
  }

  const json = (await res.json()) as {
    ok: boolean;
    data?: {
      results: ScanResult[];
      summary: { healthy: number; warnings: number; unknown: number };
    };
  };

  if (!json.ok || !json.data) {
    throw new Error('Invalid API response');
  }

  return json.data.results;
}

function detectDependencies(dir: string): { deps: string[]; ecosystem: string } {
  if (existsSync(join(dir, 'package.json'))) {
    const deps = parsePackageJson(dir);
    return { deps, ecosystem: 'npm' };
  }
  if (existsSync(join(dir, 'requirements.txt')) || existsSync(join(dir, 'pyproject.toml'))) {
    const deps = parseRequirementsTxt(dir);
    return { deps, ecosystem: 'pypi' };
  }
  if (existsSync(join(dir, 'Cargo.toml'))) {
    const deps = parseCargoToml(dir);
    return { deps, ecosystem: 'cargo' };
  }
  return { deps: [], ecosystem: 'unknown' };
}

export async function runScan(argv: string[]): Promise<void> {
  const dir = argv[0] ?? process.cwd();
  const jsonOutput = argv.includes('--json');

  const { deps, ecosystem } = detectDependencies(dir);

  if (deps.length === 0) {
    console.error(
      '❌ No supported dependency file found.\n' +
        '   Supported: package.json, requirements.txt, Cargo.toml\n',
    );
    process.exit(1);
  }

  let results: ScanResult[];
  try {
    results = await callScanApi(deps);
  } catch (e) {
    console.error(
      `\n❌ Failed to reach ToolCairn API: ${e instanceof Error ? e.message : String(e)}`,
    );
    console.error(
      '   Make sure you have internet access or set TOOLPILOT_API_URL for self-hosted.\n',
    );
    process.exit(1);
  }

  if (jsonOutput) {
    return;
  }

  printScanTable(results);

  const deprecated = results.filter((r) => r.status === 'deprecated' || r.status === 'warning');
  const unknown = results.filter((r) => r.status === 'unknown');

  if (deprecated.length > 0) {
    for (const _r of deprecated) {
    }
  }

  if (unknown.length > 0) {
  }

  const _healthy = results.filter((r) => r.status === 'healthy').length;

  process.exit(deprecated.length > 0 ? 1 : 0);
}
