import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SnapshotManifest } from './types';

const SENSITIVE_KEY = /["'](?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret|private[_-]?key)["']\s*:/i;

export async function findPotentialSecrets(root: string, manifest: SnapshotManifest): Promise<string[]> {
  const matches: string[] = [];
  for (const relative of Object.keys(manifest.files)) {
    if (!/\.(?:json|jsonc|code-snippets)$/i.test(relative)) continue;
    const content = await fs.readFile(path.join(root, ...relative.split('/')), 'utf8');
    if (containsPotentialSecret(content)) matches.push(relative);
  }
  return matches;
}

export function containsPotentialSecret(content: string): boolean {
  return SENSITIVE_KEY.test(content);
}
