import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withAuditLog } from './audit-logger.js';

let projectRoot: string;
let originalCwd: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  projectRoot = await mkdtemp(join(tmpdir(), 'toolcairn-audmw-'));
  // Bootstrap a minimal config skeleton so resolveProjectRoot finds it.
  const { mutateConfig } = await import('@toolcairn/tools-local');
  await mutateConfig(
    projectRoot,
    (cfg) => {
      cfg.project.name = 'mw-test';
    },
    { action: 'init', tool: '__project__', reason: 'mw-bootstrap' },
  );
  process.chdir(projectRoot);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(projectRoot, { recursive: true, force: true });
});

function jsonResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}

async function readAuditLines(): Promise<Record<string, unknown>[]> {
  const { joinAuditPath } = await import('@toolcairn/tools-local');
  const raw = await readFile(joinAuditPath(projectRoot), 'utf-8');
  return raw
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function waitForAuditLines(
  min: number,
  timeoutMs = 2000,
): Promise<Record<string, unknown>[]> {
  const start = Date.now();
  // Audit append is fire-and-forget; poll briefly until the new line shows up.
  while (Date.now() - start < timeoutMs) {
    const lines = await readAuditLines();
    if (lines.length >= min) return lines;
    await new Promise((r) => setTimeout(r, 25));
  }
  return readAuditLines();
}

describe('withAuditLog middleware', () => {
  it('appends a tool_call audit entry for search_tools and injects next_action', async () => {
    const handler = withAuditLog('search_tools', async () =>
      jsonResult({
        ok: true,
        data: { query_id: 'q-mw-1', status: 'complete', results: [{ name: 'ioredis' }] },
      }),
    );

    const result = await handler({ query: 'redis client' });
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    const parsed = JSON.parse(text) as { data: Record<string, unknown> };

    // next_action reminder injected
    expect(typeof parsed.data.next_action).toBe('string');
    expect(parsed.data.next_action).toContain('q-mw-1');
    expect(parsed.data.next_action).toContain('report_outcome');

    // Audit entry persisted (after the fire-and-forget completes)
    const lines = await waitForAuditLines(2);
    const lastTwo = lines.slice(-1);
    expect(lastTwo[0]?.action).toBe('tool_call');
    expect(lastTwo[0]?.mcp_tool).toBe('search_tools');
    expect(lastTwo[0]?.query_id).toBe('q-mw-1');
    expect(Array.isArray(lastTwo[0]?.candidates)).toBe(true);
    expect((lastTwo[0]?.candidates as string[])?.[0]).toBe('ioredis');
  });

  it('records report_outcome with outcome and replaced_by', async () => {
    const handler = withAuditLog('report_outcome', async () =>
      jsonResult({ ok: true, data: { recorded: true } }),
    );

    await handler({
      query_id: 'q-mw-2',
      chosen_tool: 'node-cron',
      outcome: 'replaced',
      replaced_by: 'agenda',
    });

    const lines = await waitForAuditLines(2);
    const reportEntry = lines.find((l) => l.mcp_tool === 'report_outcome');
    expect(reportEntry).toBeDefined();
    expect(reportEntry?.tool).toBe('node-cron');
    expect(reportEntry?.outcome).toBe('replaced');
    expect(reportEntry?.replaced_by).toBe('agenda');
    expect(reportEntry?.query_id).toBe('q-mw-2');
  });

  it('does not inject next_action for non-recommendation tools', async () => {
    const handler = withAuditLog('compare_tools', async () =>
      jsonResult({ ok: true, data: { query_id: 'q-mw-3', recommendation: 'go with A' } }),
    );

    const result = await handler({ tool_a: 'a', tool_b: 'b' });
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    const parsed = JSON.parse(text) as { data: Record<string, unknown> };
    expect(parsed.data.next_action).toBeUndefined();
  });

  it('marks status=error for failed handler results without throwing', async () => {
    const handler = withAuditLog('search_tools', async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'boom' }) }],
      isError: true,
    }));

    await handler({ query: 'will fail' });

    const lines = await waitForAuditLines(2);
    const last = lines.at(-1);
    expect(last?.status).toBe('error');
  });
});
