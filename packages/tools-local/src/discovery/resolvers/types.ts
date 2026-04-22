/** Enriched per-tool identity the resolver derives from local installation. */
export interface ResolvedToolIdentity {
  /**
   * Canonical package name from the installed package's own manifest.
   * For npm, this is node_modules/<dep-key>/package.json#name — which
   * may differ from the dep-key (e.g. aliased installs: `"my": "npm:real@1"`).
   */
  canonical_package_name?: string;
  /**
   * Repository URL extracted from the installed package's manifest,
   * normalised to https://github.com/org/repo (no git+ prefix, no .git suffix).
   */
  github_url?: string;
  /** Exact installed version, when known locally (from lockfile or installed manifest). */
  resolved_version?: string;
}
