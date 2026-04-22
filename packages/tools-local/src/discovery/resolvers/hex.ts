import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createMcpLogger } from '@toolcairn/errors';
import { fileExists } from '../util/fs.js';
import type { ResolvedToolIdentity } from './types.js';
import { normaliseGitHubUrl } from './url-normalise.js';

const logger = createMcpLogger({ name: '@toolcairn/tools:resolver:hex' });

/**
 * Elixir Mix places installed deps under `<project>/deps/<name>/`.
 * hex_metadata.config is the canonical metadata (Erlang term format). The
 * `links` field typically contains `{<<"GitHub">>, <<"url">>}`. We regex
 * the URL out — parsing full Erlang terms is overkill.
 *
 * Fallback: mix.exs sometimes sets @source_url or source_url: in the project()
 * map.
 */
function extractHexMetadataUrl(raw: string): string | undefined {
  // <<"GitHub">>, <<"https://...">>   — link in the `links` proplist
  let match = raw.match(/<<"GitHub">>\s*,\s*<<"([^"]+)">>/i);
  if (match?.[1]) return match[1];
  // Generic <<"<label>">>, <<"<url>">> where the label contains "github"
  match = raw.match(/<<"[^"]*github[^"]*">>\s*,\s*<<"(https?:\/\/[^"]+)">>/i);
  if (match?.[1]) return match[1];
  return undefined;
}

function extractMixExsUrl(raw: string): string | undefined {
  // @source_url "https://..."  or  @source_url("https://...")
  const atMatch = raw.match(/@source_url\s*\(?\s*["']([^"']+)["']/);
  if (atMatch?.[1]) return atMatch[1];
  // source_url: "https://..."
  const kwMatch = raw.match(/\bsource_url\s*:\s*["']([^"']+)["']/);
  if (kwMatch?.[1]) return kwMatch[1];
  return undefined;
}

export async function resolveHexIdentity(
  workspaceAbs: string,
  _projectRoot: string,
  depName: string,
): Promise<ResolvedToolIdentity> {
  const depDir = join(workspaceAbs, 'deps', depName);
  const out: ResolvedToolIdentity = {};

  const metaPath = join(depDir, 'hex_metadata.config');
  if (await fileExists(metaPath)) {
    try {
      const raw = await readFile(metaPath, 'utf-8');
      const url = extractHexMetadataUrl(raw);
      const normalised = normaliseGitHubUrl(url);
      if (normalised) out.github_url = normalised;
    } catch (err) {
      logger.debug(
        { err: err instanceof Error ? err.message : String(err), metaPath },
        'Failed to read hex_metadata.config',
      );
    }
  }

  // Fallback to mix.exs inside the dep if we didn't find a URL yet
  if (!out.github_url) {
    const mixPath = join(depDir, 'mix.exs');
    if (await fileExists(mixPath)) {
      try {
        const raw = await readFile(mixPath, 'utf-8');
        const url = extractMixExsUrl(raw);
        const normalised = normaliseGitHubUrl(url);
        if (normalised) out.github_url = normalised;
      } catch {
        /* silent */
      }
    }
  }

  return out;
}
