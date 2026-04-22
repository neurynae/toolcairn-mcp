import { readFile } from 'node:fs/promises';
import { createMcpLogger } from '@toolcairn/errors';
import { XMLParser } from 'fast-xml-parser';
import { fileExists } from '../util/fs.js';
import type { ResolvedToolIdentity } from './types.js';
import { normaliseGitHubUrl } from './url-normalise.js';

const logger = createMcpLogger({ name: '@toolcairn/tools:resolver:pom' });

interface Pom {
  project?: {
    groupId?: string;
    artifactId?: string;
    version?: string;
    url?: string;
    scm?: { url?: string; connection?: string; developerConnection?: string };
  };
}

/**
 * Parse a cached .pom file (Maven or Gradle — same schema) and derive
 * canonical_package_name + github_url.
 *
 * Canonical form for Java/Kotlin artifacts is `groupId:artifactId`, which is
 * what the upstream parsers emit as the `name`. If that matches what the
 * caller already had, canonical_package_name is omitted.
 */
export async function parsePomIdentity(
  path: string,
  depName: string,
): Promise<ResolvedToolIdentity> {
  if (!(await fileExists(path))) return {};
  try {
    const raw = await readFile(path, 'utf-8');
    const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: true });
    const doc = parser.parse(raw) as Pom;
    const project = doc.project;
    if (!project) return {};
    const out: ResolvedToolIdentity = {};
    const canonical =
      project.groupId && project.artifactId
        ? `${project.groupId}:${project.artifactId}`
        : undefined;
    if (canonical && canonical !== depName) out.canonical_package_name = canonical;
    if (project.version) out.resolved_version = project.version;
    const candidateUrls = [
      project.scm?.url,
      project.scm?.connection,
      project.scm?.developerConnection,
      project.url,
    ];
    for (const u of candidateUrls) {
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
      'Failed to parse .pom',
    );
    return {};
  }
}
