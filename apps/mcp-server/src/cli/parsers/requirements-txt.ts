import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function parseRequirementsTxt(dir: string): string[] {
  for (const filename of ['requirements.txt', 'requirements-dev.txt', 'requirements/base.txt']) {
    const path = join(dir, filename);
    try {
      const lines = readFileSync(path, 'utf8').split('\n');
      return lines
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && !l.startsWith('-r'))
        .map((l) => l.split(/[>=<!;[\s]/)[0]?.trim() ?? '')
        .filter(Boolean);
    } catch {
      continue;
    }
  }
  return [];
}
