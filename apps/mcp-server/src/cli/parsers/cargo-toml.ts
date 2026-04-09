import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function parseCargoToml(dir: string): string[] {
  const path = join(dir, 'Cargo.toml');
  try {
    const content = readFileSync(path, 'utf8');
    const deps: string[] = [];
    let inDeps = false;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (/^\[(dependencies|dev-dependencies|build-dependencies)\]/.test(trimmed)) {
        inDeps = true;
        continue;
      }
      if (trimmed.startsWith('[')) {
        inDeps = false;
        continue;
      }
      if (inDeps && trimmed && !trimmed.startsWith('#')) {
        const name = trimmed.split('=')[0]?.trim();
        if (name) deps.push(name);
      }
    }
    return deps;
  } catch {
    return [];
  }
}
