import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mutateConfig, readConfig } from '../src/config-store/index.js';
import { handleUpdateProjectConfig } from '../src/handlers/update-project-config.js';

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'toolcairn-mark-'));
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

/** Unwrap the stringified payload returned by okResult/errResult helpers. */
function parse(result: { content: Array<{ text: string }>; isError?: boolean }) {
  const textBlock = result.content[0];
  expect(textBlock).toBeDefined();
  const envelope = JSON.parse(textBlock!.text) as {
    ok?: boolean;
    data?: Record<string, unknown>;
    error?: string;
    message?: string;
  };
  return {
    body: (envelope.data ?? envelope) as Record<string, unknown>,
    isError: result.isError,
    ok: envelope.ok,
  };
}

async function seedConfigWithUnknown(names: string[]) {
  await mutateConfig(
    projectRoot,
    (cfg) => {
      cfg.project.name = 'marker-test';
      cfg.tools.unknown_in_graph = names.map((name) => ({
        name,
        ecosystem: 'npm',
        github_url: `https://github.com/example/${name}`,
        discovered_at: new Date().toISOString(),
        suggested: false,
      }));
    },
    { action: 'init', tool: '__project__', reason: 'seed' },
  );
}

describe('update_project_config action=mark_suggestions_sent', () => {
  it('flips suggested=true for listed names and leaves others untouched', async () => {
    await seedConfigWithUnknown(['libA', 'libB', 'libC']);

    const res = await handleUpdateProjectConfig({
      project_root: projectRoot,
      action: 'mark_suggestions_sent',
      data: { tool_names: ['libA', 'libC'] },
    });
    const { body, isError } = parse(res);
    expect(isError).toBeFalsy();
    expect(body.marked_count).toBe(2);
    expect(body.undrained_unknown_count).toBe(1);

    const { config } = await readConfig(projectRoot);
    const list = config!.tools.unknown_in_graph ?? [];
    const byName = Object.fromEntries(list.map((t) => [t.name, t]));
    expect(byName.libA?.suggested).toBe(true);
    expect(byName.libC?.suggested).toBe(true);
    expect(byName.libB?.suggested).toBe(false);
    expect(byName.libA?.suggested_at).toBeDefined();
  });

  it('is idempotent — re-marking already-sent names does nothing and counts zero newly-marked', async () => {
    await seedConfigWithUnknown(['libA']);
    await handleUpdateProjectConfig({
      project_root: projectRoot,
      action: 'mark_suggestions_sent',
      data: { tool_names: ['libA'] },
    });
    const second = await handleUpdateProjectConfig({
      project_root: projectRoot,
      action: 'mark_suggestions_sent',
      data: { tool_names: ['libA'] },
    });
    const { body } = parse(second);
    expect(body.marked_count).toBe(0); // already marked
    expect(body.undrained_unknown_count).toBe(0);
  });

  it('silently skips names that are not in unknown_in_graph', async () => {
    await seedConfigWithUnknown(['libA']);
    const res = await handleUpdateProjectConfig({
      project_root: projectRoot,
      action: 'mark_suggestions_sent',
      data: { tool_names: ['libA', 'ghost-lib'] },
    });
    const { body, isError } = parse(res);
    expect(isError).toBeFalsy();
    expect(body.marked_count).toBe(1);
  });

  it('errors when tool_names is missing or empty', async () => {
    await seedConfigWithUnknown(['libA']);
    const res = await handleUpdateProjectConfig({
      project_root: projectRoot,
      action: 'mark_suggestions_sent',
      data: {},
    });
    const { isError } = parse(res);
    expect(isError).toBe(true);
  });
});
