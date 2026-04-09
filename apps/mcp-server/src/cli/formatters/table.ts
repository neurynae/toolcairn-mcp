/** Minimal ASCII table formatter for CLI output */

interface TableRow {
  name: string;
  status: string;
  warnings: string;
  suggestions: string;
}

const ICONS: Record<string, string> = {
  healthy: '✅',
  warning: '⚠️ ',
  deprecated: '❌',
  unknown: '❓',
};

export function printScanTable(
  results: Array<{
    name: string;
    status: string;
    warnings: string[];
    alternatives: string[];
    complements: string[];
    quality_score: number | null;
  }>,
): void {
  const rows: TableRow[] = results.map((r) => ({
    name: r.name,
    status: `${ICONS[r.status] ?? '?'} ${r.status}`,
    warnings: r.warnings.length > 0 ? r.warnings[0]! : '—',
    suggestions:
      r.alternatives.length > 0
        ? `Replace: ${r.alternatives.slice(0, 2).join(', ')}`
        : r.complements.length > 0
          ? `Also: ${r.complements.slice(0, 2).join(', ')}`
          : '—',
  }));

  const cols: (keyof TableRow)[] = ['name', 'status', 'warnings', 'suggestions'];
  const headers: Record<keyof TableRow, string> = {
    name: 'PACKAGE',
    status: 'STATUS',
    warnings: 'WARNINGS',
    suggestions: 'SUGGESTIONS',
  };

  const widths = cols.reduce(
    (acc, col) => {
      acc[col] = Math.max(headers[col].length, ...rows.map((r) => r[col].length));
      return acc;
    },
    {} as Record<keyof TableRow, number>,
  );

  const sep = cols.map((c) => '─'.repeat(widths[c] + 2)).join('┼');
  const line = (row: TableRow | typeof headers, char = ' ') =>
    cols
      .map((c) => ` ${((row as Record<string, string>)[c] ?? '').padEnd(widths[c] ?? 0)} `)
      .join('│');

  console.log('');
  console.log('┌' + cols.map((c) => '─'.repeat(widths[c] + 2)).join('┬') + '┐');
  console.log('│' + line(headers) + '│');
  console.log('├' + sep + '┤');
  for (const row of rows) {
    console.log('│' + line(row) + '│');
  }
  console.log('└' + cols.map((c) => '─'.repeat(widths[c] + 2)).join('┴') + '┘');
  console.log('');
}
