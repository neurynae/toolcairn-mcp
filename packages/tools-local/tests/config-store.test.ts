import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  joinAuditPath,
  joinConfigPath,
  mutateConfig,
  readConfig,
  readLiveAudit,
} from '../src/config-store/index.js';

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'toolcairn-store-'));
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

describe('config-store.mutateConfig', () => {
  it('bootstraps a fresh v1.1 config on first call', async () => {
    const result = await mutateConfig(
      projectRoot,
      (cfg) => {
        cfg.project.name = 'alpha';
      },
      { action: 'init', tool: '__project__', reason: 'fresh' },
    );
    expect(result.bootstrapped).toBe(true);
    expect(result.config.version).toBe('1.1');
    expect(result.config.project.name).toBe('alpha');

    // Audit entry written to jsonl
    const entries = await readLiveAudit(projectRoot);
    expect(entries.length).toBe(1);
    expect(entries[0]?.action).toBe('init');
  });

  it('appends a new audit entry on each mutation', async () => {
    await mutateConfig(
      projectRoot,
      (cfg) => {
        cfg.project.name = 'beta';
      },
      { action: 'init', tool: '__project__', reason: 'first' },
    );
    await mutateConfig(
      projectRoot,
      (cfg) => {
        cfg.tools.confirmed.push({
          name: 'biome',
          source: 'toolcairn',
          chosen_at: new Date().toISOString(),
          chosen_reason: 'linter',
          alternatives_considered: [],
          locations: [],
        });
      },
      { action: 'add_tool', tool: 'biome', reason: 'added biome' },
    );

    const entries = await readLiveAudit(projectRoot);
    expect(entries.length).toBe(2);
    expect(entries[0]?.action).toBe('init');
    expect(entries[1]?.action).toBe('add_tool');

    // last_audit_entry in config.json reflects the second mutation
    const { config } = await readConfig(projectRoot);
    expect(config?.last_audit_entry?.action).toBe('add_tool');
    expect(config?.last_audit_entry?.tool).toBe('biome');
  });

  it('serialises concurrent mutations via cross-process lock', async () => {
    // Bootstrap first
    await mutateConfig(
      projectRoot,
      (cfg) => {
        cfg.project.name = 'gamma';
      },
      { action: 'init', tool: '__project__', reason: 'seed' },
    );

    // Fire N concurrent add_tool mutations — all should land
    const TOOLS = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
    await Promise.all(
      TOOLS.map((name) =>
        mutateConfig(
          projectRoot,
          (cfg) => {
            if (!cfg.tools.confirmed.some((t) => t.name === name)) {
              cfg.tools.confirmed.push({
                name,
                source: 'toolcairn',
                chosen_at: new Date().toISOString(),
                chosen_reason: 'concurrency test',
                alternatives_considered: [],
                locations: [],
              });
            }
          },
          { action: 'add_tool', tool: name, reason: 'concurrent' },
        ),
      ),
    );

    const { config } = await readConfig(projectRoot);
    const names = new Set(config?.tools.confirmed.map((t) => t.name));
    for (const t of TOOLS) expect(names.has(t)).toBe(true);

    // Exactly init + 5 concurrent entries in the audit log
    const entries = await readLiveAudit(projectRoot);
    expect(entries.length).toBe(6);
  });
});

describe('config-store.readConfig (corrupt file handling)', () => {
  it('renames a corrupt config.json to config.json.corrupt.<ts> and returns null', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(projectRoot, '.toolcairn'), { recursive: true });
    const configPath = joinConfigPath(projectRoot);
    await writeFile(configPath, '{not valid json', 'utf-8');

    const result = await readConfig(projectRoot);
    expect(result.config).toBeNull();
    expect(result.corrupt_backup_path).toBeTruthy();
    // The backup file should exist and contain the garbage.
    const backup = await readFile(result.corrupt_backup_path as string, 'utf-8');
    expect(backup).toBe('{not valid json');
  });
});

describe('config-store.mutateConfig (v1.0 → v1.1 migration)', () => {
  it('migrates a v1.0 config in place on first write and relocates audit_log', async () => {
    const configPath = joinConfigPath(projectRoot);
    const legacy = {
      version: '1.0',
      project: {
        name: 'legacy',
        language: 'TypeScript',
        framework: 'Next.js',
      },
      tools: {
        confirmed: [
          {
            name: 'next',
            source: 'toolpilot',
            chosen_at: '2025-01-01T00:00:00.000Z',
            chosen_reason: 'legacy pick',
            alternatives_considered: [],
          },
        ],
        pending_evaluation: [],
      },
      audit_log: [
        {
          action: 'init',
          tool: '__project__',
          timestamp: '2025-01-01T00:00:00.000Z',
          reason: 'legacy init',
        },
        {
          action: 'add_tool',
          tool: 'next',
          timestamp: '2025-01-01T00:01:00.000Z',
          reason: 'legacy add',
        },
      ],
    };
    // Write it without going through mutateConfig (simulating a v0.9.x-authored file)
    const fs = await import('node:fs/promises');
    await fs.mkdir(join(projectRoot, '.toolcairn'), { recursive: true });
    await writeFile(configPath, JSON.stringify(legacy, null, 2), 'utf-8');

    const result = await mutateConfig(
      projectRoot,
      (cfg) => {
        cfg.project.name = 'legacy-updated';
      },
      { action: 'update_tool', tool: '__project__', reason: 'rename' },
    );

    expect(result.migrated).toBe(true);
    expect(result.config.version).toBe('1.1');
    expect(result.config.project.name).toBe('legacy-updated');
    expect(result.config.project.languages?.[0]?.name).toBe('TypeScript');
    expect(result.config.project.frameworks?.[0]?.name).toBe('Next.js');

    // Legacy audit entries should be relocated into audit-log.jsonl,
    // plus the migration marker, plus the new update_tool entry.
    const entries = await readLiveAudit(projectRoot);
    const actions = entries.map((e) => e.action);
    expect(actions).toContain('init');
    expect(actions).toContain('add_tool');
    expect(actions).toContain('migrate');
    expect(actions).toContain('update_tool');

    // Disk doc should no longer carry `audit_log[]`
    const onDisk = JSON.parse(await readFile(configPath, 'utf-8'));
    expect(onDisk.audit_log).toBeUndefined();
    expect(onDisk.version).toBe('1.1');
  });
});

describe('config-store audit log path + content', () => {
  it('writes to .toolcairn/audit-log.jsonl next to config.json', async () => {
    await mutateConfig(
      projectRoot,
      (cfg) => {
        cfg.project.name = 'delta';
      },
      { action: 'init', tool: '__project__', reason: 'seed' },
    );

    const auditPath = joinAuditPath(projectRoot);
    const raw = await readFile(auditPath, 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0] ?? '');
    expect(parsed.action).toBe('init');
    expect(typeof parsed.timestamp).toBe('string');
  });
});
