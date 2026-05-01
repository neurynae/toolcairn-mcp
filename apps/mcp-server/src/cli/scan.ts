/**
 * `npx @neurynae/toolcairn-mcp scan` — Stack Scanner
 *
 * Scans the project's installed manifests, resolves each dependency to its
 * canonical Tool node in the ToolCairn graph via the engine's three-tier
 * resolver (registry_package_keys → github_url → name fallback), and prints
 * a table showing which deps are indexed and which aren't.
 *
 * This uses the same `scanProject` pipeline as the MCP `toolcairn_init` tool,
 * so name-mismatch quirks (e.g. npm `@biomejs/biome` → graph `biome`,
 * `typescript` lowercase → graph `TypeScript`) and disambiguation (vercel/turbo
 * vs didi/turbo) are all handled correctly via the GitHub-URL match tier.
 *
 * Auth: requires the user to have authenticated via the MCP `toolcairn_auth`
 * tool first (which writes ~/.toolcairn/credentials.json). Otherwise prints
 * a helpful sign-in instruction and exits non-zero.
 */

import { ToolCairnClient, isTokenValid, loadCredentials } from '@toolcairn/remote';
import { scanProject } from '@toolcairn/tools-local';

const API_BASE = process.env.TOOLPILOT_API_URL ?? 'https://api.neurynae.com';

function printAuthRequired(): void {
  console.error(
    '\n❌ Authentication required for `scan`.\n\n' +
      '   ToolCairn tracks scan calls per-user for graph learning, so this command\n' +
      '   needs the same sign-in as the MCP server.\n\n' +
      '   First-time setup (one-shot):\n' +
      '     1. Add ToolCairn to your MCP client:\n' +
      '          claude mcp add toolcairn -- npx @neurynae/toolcairn-mcp\n' +
      '     2. Restart your client. The `toolcairn_auth login` tool will open\n' +
      '        a browser to sign in. Token is saved to ~/.toolcairn/credentials.json.\n' +
      '     3. Re-run `npx @neurynae/toolcairn-mcp scan`.\n',
  );
}

interface DisplayRow {
  name: string;
  ecosystem: string;
  inGraph: string;
  matchMethod: string;
  github: string;
}

function pad(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + ' '.repeat(width - s.length);
}

function printTable(rows: DisplayRow[]): void {
  if (rows.length === 0) {
    console.log('No dependencies detected in this project.');
    return;
  }
  const cols: Array<keyof DisplayRow> = ['name', 'ecosystem', 'inGraph', 'matchMethod', 'github'];
  const headers: Record<keyof DisplayRow, string> = {
    name: 'PACKAGE',
    ecosystem: 'ECO',
    inGraph: 'IN GRAPH',
    matchMethod: 'MATCH',
    github: 'GITHUB',
  };
  const widths = Object.fromEntries(
    cols.map((c) => [c, Math.max(headers[c].length, ...rows.map((r) => r[c].length))]),
  ) as Record<keyof DisplayRow, number>;
  const line = (r: DisplayRow | typeof headers) =>
    cols.map((c) => ` ${pad((r as Record<string, string>)[c] ?? '', widths[c])} `).join('│');
  const sep = cols.map((c) => '─'.repeat(widths[c] + 2)).join('┼');

  console.log('');
  console.log(line(headers));
  console.log(sep);
  for (const r of rows) console.log(line(r));
}

export async function runScan(argv: string[]): Promise<void> {
  const dir = argv[0] && !argv[0].startsWith('--') ? argv[0] : process.cwd();
  const jsonOutput = argv.includes('--json');

  const creds = await loadCredentials();
  if (!creds || !creds.access_token || !isTokenValid(creds)) {
    printAuthRequired();
    process.exit(1);
  }

  const client = new ToolCairnClient({
    baseUrl: API_BASE,
    apiKey: creds.client_id,
    accessToken: creds.access_token,
  });

  let scan: Awaited<ReturnType<typeof scanProject>>;
  try {
    scan = await scanProject(dir, {
      batchResolve: client.batchResolve.bind(client),
    });
  } catch (e) {
    console.error(
      `\n❌ Scan failed: ${e instanceof Error ? e.message : String(e)}\n` +
        '   Make sure you have internet access or set TOOLPILOT_API_URL for self-hosted.\n',
    );
    process.exit(1);
  }

  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(scan, null, 2)}\n`);
    return;
  }

  const rows: DisplayRow[] = scan.tools.map((t) => {
    const inGraph = t.source !== 'non_oss';
    const ecosystem = t.locations?.[0]?.ecosystem ?? '—';
    const github = t.github_url ? t.github_url.replace(/^https?:\/\/github\.com\//, '') : '—';
    return {
      name:
        t.canonical_name && t.canonical_name !== t.name
          ? `${t.name} → ${t.canonical_name}`
          : t.name,
      ecosystem,
      inGraph: inGraph ? '✅ yes' : '❌ no',
      matchMethod:
        t.source === 'toolcairn' || t.source === 'toolpilot'
          ? 'graph'
          : t.source === 'manual'
            ? 'manual'
            : 'not_indexed',
      github,
    };
  });

  printTable(rows);

  const matched = scan.tools.filter((t) => t.source !== 'non_oss').length;
  const unmatched = scan.tools.length - matched;
  console.log('');
  console.log(
    `Summary: ${matched} indexed · ${unmatched} not indexed (of ${scan.tools.length} dependencies)`,
  );
  // Dedupe warnings — workspace-walker emits one "no lockfile" per workspace.
  const uniqueWarnings = Array.from(
    new Map(scan.warnings.map((w) => [`${w.scope}|${w.message}`, w])).values(),
  );
  if (uniqueWarnings.length > 0) {
    console.log('');
    for (const w of uniqueWarnings) {
      console.log(`⚠️  [${w.scope}] ${w.message}`);
    }
  }
  console.log('');

  process.exit(unmatched > 0 ? 1 : 0);
}
