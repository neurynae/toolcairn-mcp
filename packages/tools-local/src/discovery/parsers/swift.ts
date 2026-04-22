import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiscoveryWarning } from '@toolcairn/types';
import type { ParseResult, Parser } from '../types.js';
import { fileExists } from '../util/fs.js';

interface PackageResolvedV1 {
  object?: {
    pins?: Array<{
      package?: string;
      state?: { version?: string; branch?: string };
    }>;
  };
  pins?: Array<{
    identity?: string;
    location?: string;
    state?: { version?: string; branch?: string };
  }>;
}

/** Extracts package identity + version from Package.resolved (v1 or v2 format). */
function parsePackageResolved(raw: string): Array<{ name: string; version?: string }> {
  let doc: PackageResolvedV1;
  try {
    doc = JSON.parse(raw) as PackageResolvedV1;
  } catch {
    return [];
  }
  const out: Array<{ name: string; version?: string }> = [];
  // v2 format
  for (const pin of doc.pins ?? []) {
    if (pin.identity) out.push({ name: pin.identity, version: pin.state?.version });
  }
  // v1 format
  for (const pin of doc.object?.pins ?? []) {
    if (pin.package) out.push({ name: pin.package, version: pin.state?.version });
  }
  return out;
}

/**
 * Swift Package.swift fallback (DSL):
 *   .package(url: "https://github.com/foo/bar.git", from: "1.0.0")
 *   .package(url: "...", .upToNextMajor(from: "2.0.0"))
 *
 * We extract the last segment of the URL as the identity and the raw version spec.
 */
function parsePackageSwift(raw: string): Array<{ name: string; constraint?: string }> {
  const out: Array<{ name: string; constraint?: string }> = [];
  const pattern = /\.package\(\s*(?:name:\s*"[^"]+"\s*,\s*)?url:\s*"([^"]+)"\s*,\s*([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const url = match[1];
    const spec = match[2]?.trim();
    if (!url) continue;
    // identity = last path segment, strip .git suffix
    const identity = url
      .split('/')
      .pop()
      ?.replace(/\.git$/, '');
    if (!identity) continue;
    out.push({ name: identity, constraint: spec });
  }
  return out;
}

export const parseSwift: Parser = async ({
  workspace_dir,
  workspace_rel,
}): Promise<ParseResult> => {
  const warnings: DiscoveryWarning[] = [];
  const tools: ParseResult['tools'] = [];

  // Prefer Package.resolved
  const resolvedPath = join(workspace_dir, 'Package.resolved');
  if (await fileExists(resolvedPath)) {
    try {
      const raw = await readFile(resolvedPath, 'utf-8');
      const manifestFile = workspace_rel ? `${workspace_rel}/Package.resolved` : 'Package.resolved';
      for (const pkg of parsePackageResolved(raw)) {
        tools.push({
          name: pkg.name,
          ecosystem: 'swift-pm',
          resolved_version: pkg.version,
          section: 'dep',
          manifest_file: manifestFile,
          workspace_path: workspace_rel,
        });
      }
      if (tools.length > 0) return { ecosystem: 'swift-pm', tools, warnings };
    } catch (err) {
      warnings.push({
        scope: 'parser:swift',
        path: resolvedPath,
        message: `Failed to parse Package.resolved: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Fallback: Package.swift
  const swiftPath = join(workspace_dir, 'Package.swift');
  if (await fileExists(swiftPath)) {
    try {
      const raw = await readFile(swiftPath, 'utf-8');
      const manifestFile = workspace_rel ? `${workspace_rel}/Package.swift` : 'Package.swift';
      for (const pkg of parsePackageSwift(raw)) {
        tools.push({
          name: pkg.name,
          ecosystem: 'swift-pm',
          version_constraint: pkg.constraint,
          section: 'dep',
          manifest_file: manifestFile,
          workspace_path: workspace_rel,
        });
      }
      warnings.push({
        scope: 'parser:swift',
        path: manifestFile,
        message: 'No Package.resolved — resolved_version unavailable.',
      });
    } catch (err) {
      warnings.push({
        scope: 'parser:swift',
        path: swiftPath,
        message: `Failed to parse Package.swift: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { ecosystem: 'swift-pm', tools, warnings };
};
