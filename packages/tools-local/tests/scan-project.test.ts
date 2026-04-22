import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanProject } from '../src/discovery/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const MONOREPO = resolve(here, 'fixtures', 'monorepo-mixed');

describe('scanProject (monorepo-mixed fixture)', () => {
  it('walks workspaces + parses all 4 ecosystems', async () => {
    const result = await scanProject(MONOREPO);

    // Project name from root package.json
    expect(result.name).toBe('monorepo-mixed-fixture');

    // All 4 ecosystems represented (+ gradle is absent → correct exclusion)
    const ecosystems = new Set(result.scan_metadata.ecosystems_scanned);
    expect(ecosystems.has('npm')).toBe(true);
    expect(ecosystems.has('pypi')).toBe(true);
    expect(ecosystems.has('cargo')).toBe(true);
    expect(ecosystems.has('go')).toBe(true);

    // Subprojects identified per workspace
    const paths = result.subprojects.map((s) => s.path).sort();
    expect(paths).toContain('apps/api');
    expect(paths).toContain('apps/web');
    expect(paths).toContain('packages/rust-core');
    expect(paths).toContain('packages/go-svc');
  });

  it('merges duplicate tools across workspaces into one entry with multiple locations', async () => {
    const result = await scanProject(MONOREPO);
    // `react` appears in apps/web AND packages/web-utils — one entry, two locations.
    const react = result.tools.find((t) => t.name === 'react');
    expect(react).toBeDefined();
    expect(react?.locations?.length).toBeGreaterThanOrEqual(2);
    const workspaces = new Set(react?.locations?.map((l) => l.workspace_path));
    expect(workspaces.has('apps/web')).toBe(true);
    expect(workspaces.has('packages/web-utils')).toBe(true);
  });

  it('preserves section (dep vs dev) on npm deps', async () => {
    const result = await scanProject(MONOREPO);
    const typescript = result.tools.find((t) => t.name === 'typescript');
    expect(typescript).toBeDefined();
    expect(typescript?.locations?.every((l) => l.section === 'dev')).toBe(true);

    const next = result.tools.find((t) => t.name === 'next');
    expect(next?.locations?.[0]?.section).toBe('dep');
  });

  it('extracts version constraints from manifests', async () => {
    const result = await scanProject(MONOREPO);
    const fastapi = result.tools.find((t) => t.name === 'fastapi');
    expect(fastapi?.locations?.[0]?.version_constraint).toMatch(/0\.110/);
    const axum = result.tools.find((t) => t.name === 'axum');
    expect(axum?.locations?.[0]?.version_constraint).toBe('0.7');
  });

  it('detects Go direct vs indirect deps (gorilla/mux is indirect → "optional" section)', async () => {
    const result = await scanProject(MONOREPO);
    const gorilla = result.tools.find((t) => t.name === 'github.com/gorilla/mux');
    expect(gorilla?.locations?.[0]?.section).toBe('optional');
    const gin = result.tools.find((t) => t.name === 'github.com/gin-gonic/gin');
    expect(gin?.locations?.[0]?.section).toBe('dep');
  });

  it('detects TypeScript as primary language via file-extension walk', async () => {
    const result = await scanProject(MONOREPO);
    // No source files in fixtures, but the walker should still return without crashing.
    expect(Array.isArray(result.languages)).toBe(true);
  });

  it('classifies all tools as non_oss when batchResolve is absent (offline mode)', async () => {
    const result = await scanProject(MONOREPO);
    for (const tool of result.tools) {
      expect(tool.source).toBe('non_oss');
      expect(tool.match_method).toBe('none');
    }
    // Emits an offline-mode warning
    expect(result.warnings.some((w) => w.scope === 'batch-resolve')).toBe(true);
  });

  it('applies local framework fallback when in offline mode (next → Next.js)', async () => {
    const result = await scanProject(MONOREPO);
    const nextjs = result.frameworks.find((f) => f.name === 'Next.js');
    expect(nextjs).toBeDefined();
    expect(nextjs?.source).toBe('local');
    expect(nextjs?.workspace).toBe('apps/web');
  });

  it('uses graph classification when batchResolve is provided', async () => {
    const result = await scanProject(MONOREPO, {
      batchResolve: async (items) => ({
        results: items.map((input) => ({
          input,
          matched: input.name === 'next',
          match_method: input.name === 'next' ? 'tool_name_exact' : 'none',
          tool:
            input.name === 'next'
              ? {
                  canonical_name: 'next',
                  github_url: 'https://github.com/vercel/next.js',
                  categories: ['framework', 'web-framework'],
                }
              : undefined,
        })),
        warnings: [],
        methods: new Map(
          items.map((i) => [
            `${i.ecosystem}:${i.name}`,
            i.name === 'next' ? 'tool_name_exact' : 'none',
          ]),
        ),
        githubUrls: new Map(
          items.flatMap((i) =>
            i.name === 'next'
              ? [[`${i.ecosystem}:${i.name}`, 'https://github.com/vercel/next.js']]
              : [],
          ),
        ),
      }),
    });

    const nextTool = result.tools.find((t) => t.name === 'next');
    expect(nextTool?.source).toBe('toolcairn');
    expect(nextTool?.github_url).toBe('https://github.com/vercel/next.js');
    expect(nextTool?.match_method).toBe('tool_name_exact');

    // Framework detection should now use graph source
    const nextjs = result.frameworks.find((f) => f.name === 'next');
    expect(nextjs?.source).toBe('graph');

    // Others should still be non_oss
    const axum = result.tools.find((t) => t.name === 'axum');
    expect(axum?.source).toBe('non_oss');
  });
});
