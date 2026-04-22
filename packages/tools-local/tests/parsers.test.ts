import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCargo, parseGo, parseNpm, parsePypi } from '../src/discovery/parsers/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(here, 'fixtures', 'monorepo-mixed');

describe('parsers — smoke tests', () => {
  it('parseNpm — preserves dep vs dev section', async () => {
    const result = await parseNpm({
      workspace_dir: resolve(FIX, 'apps/web'),
      workspace_rel: 'apps/web',
      project_root: FIX,
    });
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('next');
    expect(names).toContain('react');
    expect(names).toContain('typescript');

    const typescript = result.tools.find((t) => t.name === 'typescript');
    expect(typescript?.section).toBe('dev');
    const next = result.tools.find((t) => t.name === 'next');
    expect(next?.section).toBe('dep');
  });

  it('parsePypi — handles PEP 621 + optional-dependencies', async () => {
    const result = await parsePypi({
      workspace_dir: resolve(FIX, 'apps/api'),
      workspace_rel: 'apps/api',
      project_root: FIX,
    });
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('fastapi');
    expect(names).toContain('pytest');
    expect(result.tools.find((t) => t.name === 'pytest')?.section).toBe('dev');
  });

  it('parseCargo — handles [dependencies] and [dev-dependencies] with table syntax', async () => {
    const result = await parseCargo({
      workspace_dir: resolve(FIX, 'packages/rust-core'),
      workspace_rel: 'packages/rust-core',
      project_root: FIX,
    });
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('axum');
    expect(names).toContain('tokio');
    expect(names).toContain('criterion');
    expect(result.tools.find((t) => t.name === 'criterion')?.section).toBe('dev');
  });

  it('parseGo — marks indirect deps as "optional"', async () => {
    const result = await parseGo({
      workspace_dir: resolve(FIX, 'packages/go-svc'),
      workspace_rel: 'packages/go-svc',
      project_root: FIX,
    });
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('github.com/gin-gonic/gin');
    expect(names).toContain('github.com/gorilla/mux');
    expect(result.tools.find((t) => t.name === 'github.com/gorilla/mux')?.section).toBe('optional');
    expect(result.tools.find((t) => t.name === 'github.com/gin-gonic/gin')?.section).toBe('dep');
  });
});
