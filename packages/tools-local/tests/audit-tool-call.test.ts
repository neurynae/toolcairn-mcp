import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigAuditEntry } from '@toolcairn/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendToolCallAudit,
  joinAuditPath,
  mutateConfig,
  readLiveAudit,
} from '../src/config-store/index.js';
import { handleReadProjectConfig } from '../src/handlers/read-project-config.js';

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'toolcairn-toolcall-'));
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

function makeToolCallEntry(over: Partial<ConfigAuditEntry> = {}): ConfigAuditEntry {
  return {
    action: 'tool_call',
    tool: '__call__:search_tools',
    timestamp: new Date().toISOString(),
    reason: 'search_tools: build a queue',
    mcp_tool: 'search_tools',
    duration_ms: 25,
    status: 'ok',
    ...over,
  };
}

async function unwrap(result: Awaited<ReturnType<typeof handleReadProjectConfig>>) {
  const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
  return JSON.parse(text) as { ok: boolean; data?: Record<string, unknown> };
}

describe('appendToolCallAudit', () => {
  it('bootstraps a config skeleton and appends the entry on first call', async () => {
    const entry = makeToolCallEntry({
      query_id: 'q-1',
      candidates: ['bullmq', 'bee-queue'],
      metadata: { query: 'redis-backed job queue' },
    });

    await appendToolCallAudit(projectRoot, entry);

    const auditPath = joinAuditPath(projectRoot);
    const raw = await readFile(auditPath, 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0] ?? '{}') as ConfigAuditEntry;
    expect(parsed.action).toBe('tool_call');
    expect(parsed.mcp_tool).toBe('search_tools');
    expect(parsed.query_id).toBe('q-1');
    expect(parsed.candidates).toEqual(['bullmq', 'bee-queue']);
  });

  it('coexists with mutateConfig writes under the same lock', async () => {
    await mutateConfig(
      projectRoot,
      (cfg) => {
        cfg.project.name = 'pkg';
      },
      { action: 'init', tool: '__project__', reason: 'first' },
    );

    await appendToolCallAudit(
      projectRoot,
      makeToolCallEntry({ query_id: 'q-2', mcp_tool: 'get_stack', tool: '__call__:get_stack' }),
    );

    const entries = await readLiveAudit(projectRoot);
    expect(entries.length).toBe(2);
    expect(entries[0]?.action).toBe('init');
    expect(entries[1]?.action).toBe('tool_call');
    expect(entries[1]?.query_id).toBe('q-2');
  });
});

describe('read_project_config — pending_outcomes', () => {
  it('surfaces unresolved recommendation query_ids', async () => {
    // Seed a config so read_project_config returns 'ready' rather than 'not_initialized'.
    await mutateConfig(
      projectRoot,
      (cfg) => {
        cfg.project.name = 'demo';
      },
      { action: 'init', tool: '__project__', reason: 'seed' },
    );

    // 1. search_tools returned 2 query_ids.
    await appendToolCallAudit(
      projectRoot,
      makeToolCallEntry({
        query_id: 'q-search-A',
        candidates: ['ioredis'],
        metadata: { query: 'redis client' },
      }),
    );
    await appendToolCallAudit(
      projectRoot,
      makeToolCallEntry({
        query_id: 'q-search-B',
        mcp_tool: 'get_stack',
        tool: '__call__:get_stack',
        candidates: ['next.js', 'fastify', 'postgres'],
        metadata: { use_case: 'web app' },
      }),
    );
    // 2. report_outcome arrives for the first one only.
    await appendToolCallAudit(
      projectRoot,
      makeToolCallEntry({
        query_id: 'q-search-A',
        mcp_tool: 'report_outcome',
        tool: 'ioredis',
        outcome: 'success',
        reason: 'report_outcome: ioredis → success',
      }),
    );

    const result = await handleReadProjectConfig({ project_root: projectRoot });
    const parsed = await unwrap(result);
    expect(parsed.ok).toBe(true);
    const data = parsed.data as { pending_outcomes: Array<{ query_id: string }> };
    expect(data.pending_outcomes.length).toBe(1);
    expect(data.pending_outcomes[0]?.query_id).toBe('q-search-B');
  });

  it('drops outcomes older than the 7-day TTL', async () => {
    await mutateConfig(
      projectRoot,
      (cfg) => {
        cfg.project.name = 'demo';
      },
      { action: 'init', tool: '__project__', reason: 'seed' },
    );

    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await appendToolCallAudit(
      projectRoot,
      makeToolCallEntry({
        query_id: 'q-old',
        timestamp: old,
        candidates: ['some-tool'],
      }),
    );

    const result = await handleReadProjectConfig({ project_root: projectRoot });
    const parsed = await unwrap(result);
    const data = parsed.data as { pending_outcomes: unknown[] };
    expect(data.pending_outcomes).toEqual([]);
  });

  it('ignores errored search calls — no nag for failed recommendations', async () => {
    await mutateConfig(
      projectRoot,
      (cfg) => {
        cfg.project.name = 'demo';
      },
      { action: 'init', tool: '__project__', reason: 'seed' },
    );

    await appendToolCallAudit(
      projectRoot,
      makeToolCallEntry({
        query_id: 'q-err',
        status: 'error',
        candidates: [],
      }),
    );

    const result = await handleReadProjectConfig({ project_root: projectRoot });
    const parsed = await unwrap(result);
    const data = parsed.data as { pending_outcomes: unknown[] };
    expect(data.pending_outcomes).toEqual([]);
  });
});
