import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function parsePackageJson(dir: string): string[] {
  const path = join(dir, 'package.json');
  try {
    const raw = readFileSync(path, 'utf8');
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const deps: string[] = [];
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const section = pkg[key];
      if (section && typeof section === 'object') {
        deps.push(...Object.keys(section as Record<string, unknown>));
      }
    }
    return [...new Set(deps)];
  } catch {
    return [];
  }
}
