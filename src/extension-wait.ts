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
  /**
   * 读取本机已安装扩展的标识，必须来自扩展清单文件。
   * 不能用 vscode.extensions.getExtension 判断：被禁用的扩展在那里查不到，会被当成缺失反复安装并空等。
   */
  listInstalled: () => Promise<string[]>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  onProgress?: (message: string) => void;
}

export interface InstallExtensionsResult {
  /** 安装命令已经执行、但清单里还没出现的扩展，下一轮继续等待。 */
  pending: string[];
  /** 安装命令失败的扩展（市场里没有、平台不支持等），本进程内不再重试，也不再等待。 */
  failed: string[];
}

export async function collectExtensionIdsFromFiles(files: string[]): Promise<string[]> {
  const ids = new Set<string>();
  for (const file of files) {
    const content = await fs.readFile(file, 'utf8').catch(() => '');
    for (const id of parseExtensionIds(content)) ids.add(id);
  }
  return [...ids];
}

export async function installAndWaitForExtensions(
  targetIds: readonly string[],
  options: WaitForExtensionsOptions,
): Promise<InstallExtensionsResult> {
  const onProgress = options.onProgress;
  const started = Date.now();
  const budgetMs = options.timeoutMs ?? EXTENSION_INSTALL_BUDGET_MS;
  const missing = selectMissingExtensionIds(targetIds, await options.listInstalled(), [SELF_EXTENSION_ID]);
  const failed = missing.filter((id) => skippedInstallIds.has(id));
  const retryable = missing.filter((id) => !skippedInstallIds.has(id));
  const requested: string[] = [];

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
      requested.push(id);
    } catch {
      skippedInstallIds.add(id);
      failed.push(id);
    }
  }

  // 预算用完没来得及发起安装的，与已发起但还没落地的一样留到下一轮。
  const waiting = retryable.filter((id) => !failed.includes(id));
  const waitBudget = Math.min(EXTENSION_WAIT_MS, Math.max(0, budgetMs - (Date.now() - started)));
  if (!requested.length || waitBudget <= 0) {
    return { pending: await stillMissing(waiting, options), failed };
  }
  const pending = await waitForExtensions(waiting, { ...options, timeoutMs: waitBudget });
  return { pending, failed };
}

/**
 * 卸载云端已经移除的扩展，返回卸载失败的标识。
 * installedIds 必须来自本机扩展清单文件，内置扩展不在其中，不会被误卸载；
 * targetIds 为空时不执行任何卸载，避免云端缺少扩展信息时清空本机。
 */
export async function uninstallRemovedExtensions(
  targetIds: readonly string[],
  installedIds: readonly string[],
  options: Omit<WaitForExtensionsOptions, 'listInstalled'> = {},
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

/** 轮询扩展清单直到目标全部出现或超时，返回仍未出现的标识。 */
export async function waitForExtensions(targetIds: readonly string[], options: WaitForExtensionsOptions): Promise<string[]> {
  // 等待过程占用跨窗口独占锁，超时不能太长，否则其他窗口的同步会长时间被阻塞。
  const timeoutMs = options.timeoutMs ?? EXTENSION_WAIT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  let pending = await stillMissing(targetIds, options);
  while (pending.length && Date.now() < deadline) {
    options.onProgress?.(`剩余 ${pending.length} 个扩展待安装…`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()))));
    pending = await stillMissing(targetIds, options);
  }
  if (!pending.length && targetIds.length) options.onProgress?.('扩展已同步完成。');
  return pending;
}

async function stillMissing(targetIds: readonly string[], options: WaitForExtensionsOptions): Promise<string[]> {
  return targetIds.length ? selectMissingExtensionIds(targetIds, await options.listInstalled()) : [];
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
