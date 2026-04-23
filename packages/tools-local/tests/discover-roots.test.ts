import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverProjectRoots } from '../src/discovery/discover-roots.js';

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'toolcairn-roots-'));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function writeFileEnsuringDir(path: string, content: string) {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf-8');
}

describe('discoverProjectRoots', () => {
  it('returns cwd itself when no manifest is present (fallback)', async () => {
    const result = await discoverProjectRoots(base);
    expect(result.usedFallback).toBe(true);
    expect(result.roots).toEqual([resolve(base)]);
  });

  it('detects a single-root project via package.json', async () => {
    await writeFileEnsuringDir(join(base, 'package.json'), '{"name":"solo"}');
    const result = await discoverProjectRoots(base);
    expect(result.usedFallback).toBe(false);
    expect(result.roots).toEqual([resolve(base)]);
  });

  it('detects sibling-repo roots (no parent manifest)', async () => {
    await writeFileEnsuringDir(join(base, 'api', 'package.json'), '{"name":"api"}');
    await writeFileEnsuringDir(join(base, 'web', 'package.json'), '{"name":"web"}');
    await writeFileEnsuringDir(join(base, 'worker', 'Cargo.toml'), '[package]\nname = "worker"\n');

    const result = await discoverProjectRoots(base);
    expect(result.usedFallback).toBe(false);
    expect(result.roots.sort()).toEqual(
      [resolve(base, 'api'), resolve(base, 'web'), resolve(base, 'worker')].sort(),
    );
  });

  it('dedups pnpm workspace members under the workspace root', async () => {
    await writeFileEnsuringDir(
      join(base, 'package.json'),
      JSON.stringify({ name: 'monorepo', private: true }),
    );
    await writeFileEnsuringDir(join(base, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    await writeFileEnsuringDir(join(base, 'packages', 'a', 'package.json'), '{"name":"a"}');
    await writeFileEnsuringDir(join(base, 'packages', 'b', 'package.json'), '{"name":"b"}');

    const result = await discoverProjectRoots(base);
    expect(result.roots).toEqual([resolve(base)]);
  });

  it('keeps sibling root independent of an adjacent workspace root', async () => {
    // One workspace + one standalone repo at the same level — both must survive.
    await writeFileEnsuringDir(
      join(base, 'mono', 'package.json'),
      JSON.stringify({ name: 'mono', private: true }),
    );
    await writeFileEnsuringDir(
      join(base, 'mono', 'pnpm-workspace.yaml'),
      'packages:\n  - "pkgs/*"\n',
    );
    await writeFileEnsuringDir(join(base, 'mono', 'pkgs', 'ui', 'package.json'), '{"name":"ui"}');
    await writeFileEnsuringDir(join(base, 'lambda', 'package.json'), '{"name":"lambda"}');

    const result = await discoverProjectRoots(base);
    expect(result.roots.sort()).toEqual([resolve(base, 'mono'), resolve(base, 'lambda')].sort());
  });

  it('skips node_modules and other ignored dirs', async () => {
    await writeFileEnsuringDir(join(base, 'package.json'), '{"name":"outer"}');
    await writeFileEnsuringDir(
      join(base, 'node_modules', 'react', 'package.json'),
      '{"name":"react"}',
    );
    await writeFileEnsuringDir(join(base, 'dist', 'package.json'), '{"name":"bundle"}');

    const result = await discoverProjectRoots(base);
    expect(result.roots).toEqual([resolve(base)]);
  });

  it('detects .csproj / .sln extension-matched roots', async () => {
    await writeFileEnsuringDir(join(base, 'svc', 'Api.csproj'), '<Project />');
    const result = await discoverProjectRoots(base);
    expect(result.roots).toEqual([resolve(base, 'svc')]);
  });
});
