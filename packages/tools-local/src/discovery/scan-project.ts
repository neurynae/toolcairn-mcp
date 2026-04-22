import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createMcpLogger } from '@toolcairn/errors';
import type {
  ConfirmedTool,
  DiscoveryWarning,
  Ecosystem,
  MatchMethod,
  ProjectFramework,
  ProjectLanguage,
  ProjectSubproject,
  ScanMetadata,
  ToolLocation,
  ToolSource,
} from '@toolcairn/types';
import { detectEcosystems } from './ecosystem-detect.js';
import { type BatchResolveResult, detectFrameworks } from './frameworks/detect.js';
import { detectLanguages } from './language-detect.js';
import { PARSERS } from './parsers/index.js';
import { RESOLVERS } from './resolvers/index.js';
import type { DetectedTool } from './types.js';
import { fileExists } from './util/fs.js';
import { toRelPosix } from './workspaces/glob.js';
import { discoverWorkspaces } from './workspaces/walker.js';

const logger = createMcpLogger({ name: '@toolcairn/tools:scan-project' });

/** Per-input payload for the MCP-to-engine batch-resolve call. */
export type BatchResolveItem = {
  name: string;
  ecosystem: Ecosystem;
  /**
   * Canonical package name from the INSTALLED manifest (e.g. resolves npm
   * aliased installs). Engine uses this over `name` when present.
   */
  canonical_package_name?: string;
  /**
   * Authoritative repository URL extracted from the installed package's own
   * manifest. Drives the engine's `exact_github` match tier — unambiguous
   * even when registry keys are mis-indexed.
   */
  github_url?: string;
};

/** Resolver signature — the MCP handler injects a function backed by @toolcairn/remote. */
export type BatchResolveFn = (items: BatchResolveItem[]) => Promise<{
  results: BatchResolveResult[];
  warnings: DiscoveryWarning[];
  /** Match methods per resolved entry (keyed by "ecosystem:name"). */
  methods: Map<string, MatchMethod>;
  /** GitHub urls per resolved entry (keyed by "ecosystem:name"). */
  githubUrls: Map<string, string>;
}>;

export interface ScanProjectOptions {
  /** Injected resolver. Omit to run in offline-only mode (all tools → non_oss). */
  batchResolve?: BatchResolveFn;
  /** Maximum workspace-recursion depth. */
  maxDepth?: number;
}

export interface ScanProjectResult {
  name: string;
  languages: ProjectLanguage[];
  frameworks: ProjectFramework[];
  subprojects: ProjectSubproject[];
  /** Tools shaped for direct insertion into `config.tools.confirmed`. */
  tools: ConfirmedTool[];
  warnings: DiscoveryWarning[];
  scan_metadata: ScanMetadata;
}

/**
 * Scan a project root and return everything needed to populate a v1.1 config.
 *
 * Steps:
 *   1. Discover all workspace roots (depth-capped recursive walk).
 *   2. For each workspace, detect ecosystems via manifest presence.
 *   3. Parse every (workspace, ecosystem) pair in parallel.
 *   4. Merge duplicate tools across workspaces into one ConfirmedTool with locations[].
 *   5. Detect languages (file-extension counts excluding vendor/build dirs).
 *   6. Call batchResolve to classify each (ecosystem, name) against the ToolCairn graph.
 *   7. Build frameworks[] using the batch-resolve categories + local fallback.
 */
export async function scanProject(
  projectRoot: string,
  options: ScanProjectOptions = {},
): Promise<ScanProjectResult> {
  const start = Date.now();
  const { batchResolve, maxDepth = 5 } = options;
  const absRoot = resolve(projectRoot);
  const warnings: DiscoveryWarning[] = [];

  logger.info({ projectRoot: absRoot }, 'Starting project scan');

  // --- 1. Workspace discovery --------------------------------------------
  const { paths: workspaceAbs, warnings: wsWarnings } = await discoverWorkspaces(absRoot, maxDepth);
  warnings.push(...wsWarnings);

  // --- 2+3. Per-workspace per-ecosystem parsing --------------------------
  const allDetected: DetectedTool[] = [];
  const ecosystemsScanned = new Set<Ecosystem>();
  const parsersFailed: string[] = [];
  const subprojects: ProjectSubproject[] = [];

  // Run all parser invocations concurrently — they're pure file reads.
  const parseTasks: Promise<void>[] = [];
  for (const wsDir of workspaceAbs) {
    const wsRel = toRelPosix(absRoot, wsDir);
    const ecosystems = await detectEcosystems(wsDir);
    for (const eco of ecosystems) {
      ecosystemsScanned.add(eco);
      const parser = PARSERS[eco];
      parseTasks.push(
        parser({ workspace_dir: wsDir, workspace_rel: wsRel, project_root: absRoot })
          .then((result) => {
            allDetected.push(...result.tools);
            warnings.push(...result.warnings);
            if (result.tools.length > 0 && wsRel !== '') {
              // Track non-root workspaces that actually had tools under an ecosystem
              const existing = subprojects.find((s) => s.path === wsRel && s.ecosystem === eco);
              if (!existing) {
                subprojects.push({
                  path: wsRel,
                  manifest: primaryManifestForEcosystem(eco),
                  ecosystem: eco,
                });
              }
            }
          })
          .catch((err: unknown) => {
            parsersFailed.push(`${eco}@${wsRel || '.'}`);
            warnings.push({
              scope: `parser:${eco}`,
              path: wsRel || '.',
              message: `Parser crashed: ${err instanceof Error ? err.message : String(err)}`,
            });
          }),
      );
    }
  }
  await Promise.all(parseTasks);

  // --- 4. Merge dedupe by (ecosystem, name) → locations[] ---------------
  const mergedMap = new Map<
    string,
    {
      name: string;
      ecosystem: Ecosystem;
      locations: ToolLocation[];
      /** From local resolver — sent to engine so it can use exact_channel via the true package name. */
      canonical_package_name?: string;
      /** From local resolver — authoritative github_url the client extracted from the installed manifest. */
      local_github_url?: string;
    }
  >();
  for (const dep of allDetected) {
    const key = `${dep.ecosystem}:${dep.name}`;
    const location: ToolLocation = {
      workspace_path: dep.workspace_path,
      manifest_file: dep.manifest_file,
      section: dep.section,
      ecosystem: dep.ecosystem,
      version_constraint: dep.version_constraint,
      resolved_version: dep.resolved_version,
    };
    const existing = mergedMap.get(key);
    if (existing) {
      // Avoid dupe-location when the same parser picks up the same dep twice
      const sameLoc = existing.locations.some(
        (l) =>
          l.workspace_path === location.workspace_path &&
          l.manifest_file === location.manifest_file &&
          l.section === location.section,
      );
      if (!sameLoc) existing.locations.push(location);
    } else {
      mergedMap.set(key, { name: dep.name, ecosystem: dep.ecosystem, locations: [location] });
    }
  }

  // --- 4.5. Per-tool local identity enrichment --------------------------
  // Walk each merged entry, invoke the per-ecosystem resolver against the
  // first location whose workspace has the installed package available.
  // This is the cheapest reliable source of (canonical_package_name, github_url)
  // — read from the user's installed dep's own manifest instead of trusting
  // the server-side `package_managers` index.
  await Promise.all(
    [...mergedMap.values()].map(async (entry) => {
      const resolver = RESOLVERS[entry.ecosystem];
      if (!resolver) return;
      for (const loc of entry.locations) {
        const workspaceAbs = resolve(absRoot, loc.workspace_path);
        const hints = { resolved_version: loc.resolved_version };
        try {
          const identity = await resolver(workspaceAbs, absRoot, entry.name, hints);
          if (identity.canonical_package_name) {
            entry.canonical_package_name = identity.canonical_package_name;
          }
          if (identity.github_url) {
            entry.local_github_url = identity.github_url;
          }
          if (identity.canonical_package_name || identity.github_url) break;
        } catch (err) {
          logger.debug(
            {
              ecosystem: entry.ecosystem,
              name: entry.name,
              workspace: loc.workspace_path,
              err: err instanceof Error ? err.message : String(err),
            },
            'Resolver threw — skipping this location',
          );
        }
      }
    }),
  );

  // --- 5. Language detection ---------------------------------------------
  const workspaceRels = workspaceAbs.map((abs) => toRelPosix(absRoot, abs));
  const languages = await detectLanguages(absRoot, workspaceRels);

  // --- 6. Batch-resolve against the graph -------------------------------
  const resolveInputs = [...mergedMap.values()].map(
    ({ name, ecosystem, canonical_package_name, local_github_url }) => ({
      name,
      ecosystem,
      canonical_package_name,
      github_url: local_github_url,
    }),
  );
  const resolved = new Map<string, BatchResolveResult>();
  const methods = new Map<string, MatchMethod>();
  const githubUrls = new Map<string, string>();

  if (batchResolve && resolveInputs.length > 0) {
    try {
      const r = await batchResolve(resolveInputs);
      for (const res of r.results) {
        const key = `${res.input.ecosystem}:${res.input.name}`;
        resolved.set(key, res);
      }
      for (const [k, v] of r.methods) methods.set(k, v);
      for (const [k, v] of r.githubUrls) githubUrls.set(k, v);
      warnings.push(...r.warnings);
    } catch (err) {
      warnings.push({
        scope: 'batch-resolve',
        message: `Failed to resolve tools against graph: ${err instanceof Error ? err.message : String(err)}. Falling back to local classification.`,
      });
    }
  } else if (!batchResolve) {
    warnings.push({
      scope: 'batch-resolve',
      message:
        'No batchResolve client provided — running in offline-only mode; all tools classified as non_oss.',
    });
  }

  // --- 7. Framework detection --------------------------------------------
  const frameworks = detectFrameworks(allDetected, resolved);

  // --- 8. Assemble ConfirmedTool[] --------------------------------------
  const now = new Date().toISOString();
  const confirmed: ConfirmedTool[] = [];
  let toolsResolvedCount = 0;

  for (const { name, ecosystem, locations, local_github_url } of mergedMap.values()) {
    const key = `${ecosystem}:${name}`;
    const graph = resolved.get(key);
    const matchMethod = methods.get(key) ?? 'none';
    const matched = graph?.matched === true;
    if (matched) toolsResolvedCount++;

    const source: ToolSource = matched ? 'toolcairn' : 'non_oss';
    const canonical = graph?.tool?.canonical_name;
    const categories = graph?.tool?.categories;
    // Prefer the graph's canonical github_url (authoritative for the matched
    // Tool). When the engine has no match, fall back to the URL we pulled
    // locally from the installed package manifest — still strictly better
    // than `undefined` for agent-side reasoning.
    const github_url = githubUrls.get(key) ?? local_github_url;
    const version =
      locations.find((l) => l.resolved_version)?.resolved_version ??
      locations[0]?.version_constraint;

    confirmed.push({
      name,
      source,
      github_url,
      version,
      chosen_at: now,
      chosen_reason: 'Auto-detected from manifest during toolcairn_init scan',
      alternatives_considered: [],
      canonical_name: canonical,
      categories,
      match_method: matchMethod,
      locations,
    });
  }
  // Stable order: indexed first (alphabetical), then non-indexed (alphabetical)
  confirmed.sort((a, b) => {
    const rank = (t: ConfirmedTool) => (t.source === 'toolcairn' ? 0 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return a.name.localeCompare(b.name);
  });

  // Sort subprojects by path for deterministic output
  subprojects.sort((a, b) => a.path.localeCompare(b.path));

  const name = await inferProjectName(absRoot);
  const scan_metadata: ScanMetadata = {
    ecosystems_scanned: [...ecosystemsScanned].sort(),
    parsers_failed: parsersFailed.sort(),
    tools_resolved: toolsResolvedCount,
    tools_unresolved: confirmed.length - toolsResolvedCount,
    duration_ms: Date.now() - start,
    completed_at: now,
  };

  logger.info(
    {
      projectRoot: absRoot,
      workspaces: workspaceAbs.length,
      ecosystems: scan_metadata.ecosystems_scanned,
      tools: confirmed.length,
      resolved: toolsResolvedCount,
      languages: languages.map((l) => l.name),
      frameworks: frameworks.map((f) => f.name),
      duration_ms: scan_metadata.duration_ms,
    },
    'Project scan complete',
  );

  return {
    name,
    languages,
    frameworks,
    subprojects,
    tools: confirmed,
    warnings,
    scan_metadata,
  };
}

function primaryManifestForEcosystem(ecosystem: Ecosystem): string {
  switch (ecosystem) {
    case 'npm':
      return 'package.json';
    case 'pypi':
      return 'pyproject.toml';
    case 'cargo':
      return 'Cargo.toml';
    case 'go':
      return 'go.mod';
    case 'rubygems':
      return 'Gemfile';
    case 'maven':
      return 'pom.xml';
    case 'gradle':
      return 'build.gradle';
    case 'composer':
      return 'composer.json';
    case 'hex':
      return 'mix.exs';
    case 'pub':
      return 'pubspec.yaml';
    case 'nuget':
      return '*.csproj';
    case 'swift-pm':
      return 'Package.swift';
  }
}

async function inferProjectName(projectRoot: string): Promise<string> {
  // Prefer package.json#name, then Cargo.toml [package].name, then pyproject.toml [project].name.
  const pkgPath = resolve(projectRoot, 'package.json');
  if (await fileExists(pkgPath)) {
    try {
      const doc = JSON.parse(await readFile(pkgPath, 'utf-8')) as { name?: string };
      if (doc.name) return doc.name;
    } catch {
      /* non-fatal */
    }
  }
  return basename(projectRoot);
}
