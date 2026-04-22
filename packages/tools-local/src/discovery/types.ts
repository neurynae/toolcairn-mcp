import type { DiscoveryWarning, Ecosystem, ManifestSection } from '@toolcairn/types';

/** A dependency detected by an ecosystem parser, pre-dedup, pre-resolve. */
export interface DetectedTool {
  /** Name as declared in the manifest. */
  name: string;
  ecosystem: Ecosystem;
  /** Raw version range/constraint from the manifest, e.g. "^14.0.0". */
  version_constraint?: string;
  /** Exact version from the lockfile, e.g. "14.2.3". */
  resolved_version?: string;
  section: ManifestSection;
  /** Path relative to project_root of the manifest file this came from. */
  manifest_file: string;
  /** Workspace path this dep belongs to, relative to project_root. "" for root. */
  workspace_path: string;
}

/** Return shape of every ecosystem parser. */
export interface ParseResult {
  ecosystem: Ecosystem;
  tools: DetectedTool[];
  warnings: DiscoveryWarning[];
}

/** Input to a parser: a single (workspace, ecosystem) slot. */
export interface ParserInput {
  /** Absolute path to the workspace directory containing the manifest. */
  workspace_dir: string;
  /** Path relative to project_root for building manifest_file / workspace_path. */
  workspace_rel: string;
  /** Absolute project root (for resolving relative paths in errors). */
  project_root: string;
}

export type Parser = (input: ParserInput) => Promise<ParseResult>;

export type { DiscoveryWarning, Ecosystem, ManifestSection } from '@toolcairn/types';
