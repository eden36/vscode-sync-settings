import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SnapshotManifest } from './types';

const SENSITIVE_KEY = /["'](?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|password|passwd|client[_-]?secret|private[_-]?key|github[_-]?token|gitlab[_-]?token|bearer[_-]?token|secret|token)["']\s*:/i;

const SENSITIVE_VALUE = /(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9\-_]{20,}|sk-[A-Za-z0-9\-_]{10,}|xox[baprs]-[A-Za-z0-9\-]+)/;

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
  return SENSITIVE_KEY.test(content) || SENSITIVE_VALUE.test(content);
}
