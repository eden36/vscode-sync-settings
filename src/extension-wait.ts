import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { parseExtensionIds } from './extension-manifest';

export { parseExtensionIds } from './extension-manifest';

export interface WaitForExtensionsOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  onProgress?: (message: string) => void;
}

export interface WaitForExtensionsResult {
  converged: boolean;
  pending: string[];
}

export async function collectExtensionIdsFromFiles(files: string[]): Promise<string[]> {
  const ids = new Set<string>();
  for (const file of files) {
    const content = await fs.readFile(file, 'utf8').catch(() => '');
    for (const id of parseExtensionIds(content)) ids.add(id);
  }
  return [...ids];
}

function getPendingIds(targetIds: readonly string[]): string[] {
  return targetIds.filter((id) => !vscode.extensions.getExtension(id));
}

export function waitForExtensions(
  targetIds: readonly string[],
  options: WaitForExtensionsOptions = {}
): Promise<WaitForExtensionsResult> {
  const unique = [...new Set(targetIds)];
  const timeoutMs = options.timeoutMs ?? 300_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const onProgress = options.onProgress;

  const pending = getPendingIds(unique);
  if (unique.length === 0 || pending.length === 0) {
    return Promise.resolve({ converged: true, pending: [] });
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: WaitForExtensionsResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(poll);
      disposable.dispose();
      resolve(result);
    };

    const report = () => {
      const current = getPendingIds(unique);
      if (current.length === 0) {
        onProgress?.('扩展已同步完成。');
        finish({ converged: true, pending: [] });
        return;
      }
      onProgress?.(`正在同步扩展（剩余 ${current.length} 个）…`);
    };

    const disposable = vscode.extensions.onDidChange(report);
    const poll = setInterval(report, pollIntervalMs);
    const timeout = setTimeout(() => {
      finish({ converged: false, pending: getPendingIds(unique) });
    }, timeoutMs);

    onProgress?.(`正在同步扩展（剩余 ${pending.length} 个）…`);
    report();
  });
}
