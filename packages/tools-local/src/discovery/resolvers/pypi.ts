import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createMcpLogger } from '@toolcairn/errors';
import { fileExists, isDir } from '../util/fs.js';
import type { ResolvedToolIdentity } from './types.js';
import { normaliseGitHubUrl } from './url-normalise.js';

const logger = createMcpLogger({ name: '@toolcairn/tools:resolver:pypi' });

/**
 * Likely site-packages locations inside a project virtualenv.
 * Windows: ".venv/Lib/site-packages/"
 * POSIX  : ".venv/lib/python<X>/site-packages/" (python<X> globbed at runtime).
 */
async function findSitePackagesDirs(workspaceAbs: string): Promise<string[]> {
  const candidates: string[] = [];
  const venvs = ['.venv', 'venv', '.virtualenv'];

  for (const venv of venvs) {
    const venvDir = join(workspaceAbs, venv);
    if (!(await isDir(venvDir))) continue;

    // Windows layout
    const winSite = join(venvDir, 'Lib', 'site-packages');
    if (await isDir(winSite)) candidates.push(winSite);

    // POSIX layout - glob the versioned python<X> dir under lib/
    const libDir = join(venvDir, 'lib');
    if (await isDir(libDir)) {
      try {
        for (const entry of await readdir(libDir)) {
          if (!entry.startsWith('python')) continue;
          const sp = join(libDir, entry, 'site-packages');
          if (await isDir(sp)) candidates.push(sp);
        }
      } catch {
        /* skip */
      }
    }
  }
  return candidates;
}

/** Normalise PEP 503 — lowercase, '_' and '.' collapsed to '-'. */
function normalisePypiName(name: string): string {
  return name.toLowerCase().replace(/[._]+/g, '-');
}

/**
 * METADATA files live under `<name>-<version>.dist-info/`. Project names in
 * the dir prefix follow PEP 503 normalisation; loose match both.
 */
async function findMetadataPath(siteDir: string, depName: string): Promise<string | null> {
  const normalised = normalisePypiName(depName);
  let entries: string[];
  try {
    entries = await readdir(siteDir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.dist-info')) continue;
    // Strip '-<version>.dist-info' to compare names
    const base = entry.replace(/-[^-]+\.dist-info$/, '');
    if (normalisePypiName(base) === normalised) {
      const metadataPath = join(siteDir, entry, 'METADATA');
      if (await fileExists(metadataPath)) return metadataPath;
    }
  }
  return null;
}

/**
 * Parse an RFC 822-style METADATA file into a Map. Only reads the header
 * block up to the first blank line (the long description after that is
 * large and useless for our needs).
 */
function parseMetadata(raw: string): { name?: string; version?: string; urls: string[] } {
  const urls: string[] = [];
  let name: string | undefined;
  let version: string | undefined;
  const lines = raw.split('\n');
  for (const line of lines) {
    if (line.trim() === '') break;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    if (key === 'Name' && !name) name = val;
    else if (key === 'Version' && !version) version = val;
    else if (key === 'Home-page') urls.push(val);
    else if (key === 'Project-URL') {
      // Format: "Label, https://..."
      const comma = val.indexOf(',');
      if (comma >= 0) urls.push(val.slice(comma + 1).trim());
      else urls.push(val);
    }
  }
  return { name, version, urls };
}

/**
 * Resolve canonical name + github_url for a pypi dep by reading its installed
 * .dist-info/METADATA. Prefers project-repo URLs over homepages. Silent no-op
 * when no venv / METADATA is present.
 */
export async function resolvePypiIdentity(
  workspaceAbs: string,
  _projectRoot: string,
  depName: string,
): Promise<ResolvedToolIdentity> {
  const siteDirs = await findSitePackagesDirs(workspaceAbs);
  for (const siteDir of siteDirs) {
    const path = await findMetadataPath(siteDir, depName);
    if (!path) continue;
    try {
      const raw = await readFile(path, 'utf-8');
      const { name, version, urls } = parseMetadata(raw);
      const out: ResolvedToolIdentity = {};
      if (name && normalisePypiName(name) !== normalisePypiName(depName)) {
        out.canonical_package_name = name;
      }
      if (version) out.resolved_version = version;
      // Walk urls looking for a github.com match — prioritise explicit repo URLs.
      for (const u of urls) {
        const normalised = normaliseGitHubUrl(u);
        if (normalised) {
          out.github_url = normalised;
          break;
        }
      }
      return out;
    } catch (err) {
      logger.debug(
        { err: err instanceof Error ? err.message : String(err), path },
        'Failed to parse METADATA',
      );
    }
  }
  return {};
}
