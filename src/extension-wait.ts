import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { parseExtensionIds, selectMissingExtensionIds, selectRemovableExtensionIds } from './extension-manifest';

export { parseExtensionIds, selectMissingExtensionIds, selectRemovableExtensionIds } from './extension-manifest';

const SELF_EXTENSION_ID = 'saltcoreyan.my-setting-sync';
// 安装占用跨窗口独占锁，总时长封顶；失败项本进程内不再重试，避免每轮同步反复阻塞。
const EXTENSION_INSTALL_BUDGET_MS = 180_000;
const EXTENSION_INSTALL_EACH_MS = 45_000;
const EXTENSION_UNINSTALL_EACH_MS = 45_000;
const EXTENSION_WAIT_MS = 60_000;
const skippedInstallIds = new Set<string>();
const skippedUninstallIds = new Set<string>();

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

function getInstalledIds(targetIds: readonly string[]): string[] {
  return targetIds.filter((id) => Boolean(vscode.extensions.getExtension(id)));
}

function getPendingIds(targetIds: readonly string[]): string[] {
  return targetIds.filter((id) => !vscode.extensions.getExtension(id));
}

export async function installAndWaitForExtensions(
  targetIds: readonly string[],
  options: WaitForExtensionsOptions = {},
): Promise<WaitForExtensionsResult> {
  const unique = [...new Set(targetIds)];
  const skipIds = [SELF_EXTENSION_ID];
  const onProgress = options.onProgress;
  const started = Date.now();
  const budgetMs = options.timeoutMs ?? EXTENSION_INSTALL_BUDGET_MS;
  const missing = selectMissingExtensionIds(unique, getInstalledIds(unique), skipIds);
  const retryable = missing.filter((id) => !skippedInstallIds.has(id));

  for (const [index, id] of retryable.entries()) {
    const remaining = budgetMs - (Date.now() - started);
    if (remaining <= 0) break;
    onProgress?.(`正在安装扩展（${index + 1}/${retryable.length}）：${id}`);
    try {
      await raceTimeout(
        Promise.resolve(vscode.commands.executeCommand('workbench.extensions.installExtension', id)),
        Math.min(EXTENSION_INSTALL_EACH_MS, remaining),
        `安装超时：${id}`,
      );
    } catch {
      skippedInstallIds.add(id);
    }
  }

  const pendingAfterInstall = selectMissingExtensionIds(unique, getInstalledIds(unique), skipIds);
  const waiting = pendingAfterInstall.filter((id) => !skippedInstallIds.has(id));
  const failed = pendingAfterInstall.filter((id) => skippedInstallIds.has(id));
  const waitBudget = Math.min(EXTENSION_WAIT_MS, Math.max(0, budgetMs - (Date.now() - started)));
  if (waiting.length === 0 || waitBudget <= 0) {
    return { converged: failed.length === 0 && waiting.length === 0, pending: [...waiting, ...failed] };
  }

  const waited = await waitForExtensions(waiting, { ...options, timeoutMs: waitBudget });
  return {
    converged: waited.converged && failed.length === 0,
    pending: [...waited.pending, ...failed],
  };
}

/**
 * 卸载云端已经移除的扩展。
 * installedIds 必须来自本机扩展清单文件，内置扩展不在其中，不会被误卸载；
 * targetIds 为空时不执行任何卸载，避免云端缺少扩展信息时清空本机。
 */
export async function uninstallRemovedExtensions(
  targetIds: readonly string[],
  installedIds: readonly string[],
  options: WaitForExtensionsOptions = {},
): Promise<string[]> {
  const removable = selectRemovableExtensionIds(installedIds, targetIds, [SELF_EXTENSION_ID])
    .filter((id) => !skippedUninstallIds.has(id));
  const onProgress = options.onProgress;
  const started = Date.now();
  const budgetMs = options.timeoutMs ?? EXTENSION_INSTALL_BUDGET_MS;
  const failed: string[] = [];

  for (const [index, id] of removable.entries()) {
    const remaining = budgetMs - (Date.now() - started);
    if (remaining <= 0) {
      failed.push(id);
      continue;
    }
    onProgress?.(`正在卸载扩展（${index + 1}/${removable.length}）：${id}`);
    try {
      await raceTimeout(
        Promise.resolve(vscode.commands.executeCommand('workbench.extensions.uninstallExtension', id)),
        Math.min(EXTENSION_UNINSTALL_EACH_MS, remaining),
        `卸载超时：${id}`,
      );
    } catch {
      skippedUninstallIds.add(id);
      failed.push(id);
    }
  }
  return failed;
}

export function waitForExtensions(
  targetIds: readonly string[],
  options: WaitForExtensionsOptions = {}
): Promise<WaitForExtensionsResult> {
  const unique = [...new Set(targetIds)];
  // 等待过程占用跨窗口独占锁，超时不能太长，否则其他窗口的同步会长时间被阻塞。
  const timeoutMs = options.timeoutMs ?? EXTENSION_WAIT_MS;
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
      onProgress?.(`剩余 ${current.length} 个扩展待安装…`);
    };

    const disposable = vscode.extensions.onDidChange(report);
    const poll = setInterval(report, pollIntervalMs);
    const timeout = setTimeout(() => {
      finish({ converged: false, pending: getPendingIds(unique) });
    }, timeoutMs);

    onProgress?.(`剩余 ${pending.length} 个扩展待安装…`);
    report();
  });
}

function raceTimeout(promise: Promise<unknown>, timeoutMs: number, message: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export const testing = {
  resetSkippedInstallIds(): void {
    skippedInstallIds.clear();
    skippedUninstallIds.clear();
  },
};
