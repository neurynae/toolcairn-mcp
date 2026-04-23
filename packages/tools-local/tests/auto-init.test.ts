import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { autoInitProject } from '../src/auto-init.js';
import type { BatchResolveFn } from '../src/discovery/index.js';

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'toolcairn-autoinit-'));
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

async function writeProjectFile(rel: string, content: string) {
  const full = join(projectRoot, rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content, 'utf-8');
}

/** Stub batchResolve that resolves `react` and nothing else. */
const partialResolveStub: BatchResolveFn = async (items) => {
  const methods = new Map<string, 'tool_name_exact' | 'none'>();
  const githubUrls = new Map<string, string>();
  const results = items.map((input) => {
    if (input.name === 'react') {
      methods.set(`${input.ecosystem}:${input.name}`, 'tool_name_exact');
      githubUrls.set(`${input.ecosystem}:${input.name}`, 'https://github.com/facebook/react');
      return {
        input,
        matched: true,
        match_method: 'tool_name_exact' as const,
        tool: {
          canonical_name: 'react',
          github_url: 'https://github.com/facebook/react',
          categories: ['ui-framework'],
        },
      };
    }
    methods.set(`${input.ecosystem}:${input.name}`, 'none');
    return { input, matched: false, match_method: 'none' as const };
  });
  return { results, warnings: [], methods, githubUrls };
};

/** Stub that simulates a full batch-resolve outage (warning + all-unmatched). */
const offlineResolveStub: BatchResolveFn = async (items) => {
  const methods = new Map();
  return {
    results: items.map((input) => ({ input, matched: false, match_method: 'none' as const })),
    warnings: [
      {
        scope: 'batch-resolve',
        message: 'batch-resolve network failure: offline. Tools classified as non_oss.',
      },
    ],
    methods,
    githubUrls: new Map(),
  };
};

describe('autoInitProject', () => {
  it('writes config.json, surfaces unknown_tools, stamps first-turn directive', async () => {
    await writeProjectFile(
      'package.json',
      JSON.stringify({
        name: 'app',
        dependencies: {
          react: '^18.0.0',
          'my-custom-lib': '^1.0.0',
        },
      }),
    );
    // Give `my-custom-lib` a resolvable github_url via the installed manifest
    // so it qualifies as an unknown_in_graph candidate.
    await writeProjectFile(
      'node_modules/my-custom-lib/package.json',
      JSON.stringify({
        name: 'my-custom-lib',
        version: '1.0.0',
        repository: { type: 'git', url: 'https://github.com/example/my-custom-lib' },
      }),
    );

    const result = await autoInitProject({
      projectRoot,
      agent: 'claude',
      batchResolve: partialResolveStub,
      reason: 'test',
    });

    expect(result.bootstrapped).toBe(true);
    expect(result.config_path).toBe('.toolcairn/config.json');
    expect(result.scan_summary.project_name).toBe('app');
    // react is indexed; my-custom-lib is unknown with github_url.
    const unknownNames = result.unknown_tools.map((t) => t.name).sort();
    expect(unknownNames).toEqual(['my-custom-lib']);
    expect(result.unknown_tools[0]?.github_url).toBe('https://github.com/example/my-custom-lib');
    expect(result.unknown_tools[0]?.suggested).toBe(false);

    // Persisted to disk.
    const written = JSON.parse(
      await readFile(join(projectRoot, '.toolcairn', 'config.json'), 'utf-8'),
    );
    expect(written.version).toBe('1.2');
    expect(written.tools.unknown_in_graph).toHaveLength(1);
    expect(written.tools.unknown_in_graph[0].name).toBe('my-custom-lib');
  });

  it('skips unknown_in_graph population when batch-resolve is offline', async () => {
    await writeProjectFile(
      'package.json',
      JSON.stringify({
        name: 'offline-app',
        dependencies: { react: '^18.0.0', lodash: '^4.0.0' },
      }),
    );

    const result = await autoInitProject({
      projectRoot,
      agent: 'claude',
      batchResolve: offlineResolveStub,
      reason: 'offline test',
    });

    // Even though everything came back non_oss, we must not flood staging.
    expect(result.unknown_tools).toEqual([]);

    const written = JSON.parse(
      await readFile(join(projectRoot, '.toolcairn', 'config.json'), 'utf-8'),
    );
    expect(written.tools.unknown_in_graph).toEqual([]);
  });

  it('preserves suggested=true flags across re-scans', async () => {
    await writeProjectFile(
      'package.json',
      JSON.stringify({
        name: 'app',
        dependencies: { 'my-custom-lib': '^1.0.0' },
      }),
    );
    await writeProjectFile(
      'node_modules/my-custom-lib/package.json',
      JSON.stringify({
        name: 'my-custom-lib',
        version: '1.0.0',
        repository: 'https://github.com/example/my-custom-lib',
      }),
    );

    // First pass — unknown, not yet suggested.
    await autoInitProject({
      projectRoot,
      agent: 'claude',
      batchResolve: partialResolveStub,
    });

    // Simulate the agent draining + marking the suggestion sent.
    const cfgPath = join(projectRoot, '.toolcairn', 'config.json');
    const cfg = JSON.parse(await readFile(cfgPath, 'utf-8'));
    cfg.tools.unknown_in_graph[0].suggested = true;
    cfg.tools.unknown_in_graph[0].suggested_at = new Date().toISOString();
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2));

    // Second pass — the same tool must stay marked as suggested.
    const second = await autoInitProject({
      projectRoot,
      agent: 'claude',
      batchResolve: partialResolveStub,
    });
    expect(second.unknown_tools).toEqual([]); // only undrained ones bubble up

    const after = JSON.parse(await readFile(cfgPath, 'utf-8'));
    expect(after.tools.unknown_in_graph[0].suggested).toBe(true);
  });
});
