import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Ecosystem } from '@toolcairn/types';
import { fileExists } from './util/fs.js';

/** Manifest presence → ecosystem. Lockfile or manifest either triggers detection. */
const ECOSYSTEM_MANIFESTS: Record<Ecosystem, string[]> = {
  npm: ['package.json'],
  pypi: ['pyproject.toml', 'requirements.txt', 'requirements-dev.txt', 'setup.py', 'Pipfile'],
  cargo: ['Cargo.toml'],
  go: ['go.mod'],
  rubygems: ['Gemfile'],
  maven: ['pom.xml'],
  gradle: ['build.gradle', 'build.gradle.kts', 'gradle.lockfile'],
  composer: ['composer.json'],
  hex: ['mix.exs'],
  pub: ['pubspec.yaml'],
  nuget: ['packages.config'],
  'swift-pm': ['Package.swift'],
};

/** Any file extension that pattern-matches an ecosystem (e.g. *.csproj for nuget). */
const ECOSYSTEM_EXTENSIONS: Record<string, Ecosystem> = {
  '.csproj': 'nuget',
  '.fsproj': 'nuget',
};

/**
 * Detect which ecosystems have manifests in the given directory.
 * Does not recurse — caller invokes per workspace.
 */
export async function detectEcosystems(workspaceDir: string): Promise<Ecosystem[]> {
  const found = new Set<Ecosystem>();

  // Check well-known filenames
  for (const [ecosystem, files] of Object.entries(ECOSYSTEM_MANIFESTS) as Array<
    [Ecosystem, string[]]
  >) {
    for (const file of files) {
      if (await fileExists(join(workspaceDir, file))) {
        found.add(ecosystem);
        break;
      }
    }
  }

  // Check extension patterns (e.g. *.csproj)
  try {
    const entries = await readdir(workspaceDir);
    for (const entry of entries) {
      for (const [ext, ecosystem] of Object.entries(ECOSYSTEM_EXTENSIONS)) {
        if (entry.endsWith(ext)) {
          found.add(ecosystem);
          break;
        }
      }
    }
  } catch {
    // unreadable dir — skip
  }

  return Array.from(found);
}
