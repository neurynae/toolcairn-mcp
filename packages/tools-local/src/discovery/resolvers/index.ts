import type { Ecosystem } from '@toolcairn/types';
import { resolveCargoIdentity } from './cargo.js';
import { resolveComposerIdentity } from './composer.js';
import { resolveGoIdentity } from './go.js';
import { resolveGradleIdentity } from './gradle.js';
import { resolveHexIdentity } from './hex.js';
import { resolveMavenIdentity } from './maven.js';
import { resolveNpmIdentity } from './npm.js';
import { resolveNugetIdentity } from './nuget.js';
import { resolvePubIdentity } from './pub.js';
import { resolvePypiIdentity } from './pypi.js';
import { resolveRubyIdentity } from './ruby.js';
import { resolveSwiftPmIdentity } from './swift-pm.js';
import type { ResolvedToolIdentity } from './types.js';

export type ResolverHints = { resolved_version?: string };

/**
 * Per-ecosystem resolver signature. Pure local reads — no network.
 * Returns an empty identity when the installed package manifest isn't
 * locally available; the handler cascade degrades gracefully from there.
 */
export type Resolver = (
  workspaceAbs: string,
  projectRoot: string,
  depName: string,
  hints?: ResolverHints,
) => Promise<ResolvedToolIdentity> | ResolvedToolIdentity;

export const RESOLVERS: Partial<Record<Ecosystem, Resolver>> = {
  npm: resolveNpmIdentity,
  pypi: resolvePypiIdentity,
  cargo: resolveCargoIdentity,
  go: (w, p, n) => resolveGoIdentity(w, p, n),
  rubygems: resolveRubyIdentity,
  maven: resolveMavenIdentity,
  gradle: resolveGradleIdentity,
  composer: resolveComposerIdentity,
  hex: resolveHexIdentity,
  pub: resolvePubIdentity,
  nuget: resolveNugetIdentity,
  'swift-pm': resolveSwiftPmIdentity,
};

export { normaliseGitHubUrl } from './url-normalise.js';
export type { ResolvedToolIdentity } from './types.js';
