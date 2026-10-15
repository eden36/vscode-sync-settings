import * as vscode from 'vscode';

const SELF_EXTENSION_ID = 'saltcoreyan.my-setting-sync';
// 失败项本进程内不再重发；重启 IDE 后会再试一次。
const failedInstallIds = new Set<string>();
const failedUninstallIds = new Set<string>();
// 命令还没返回的装卸，重发只会重复下载。
const runningIds = new Set<string>();

export interface ExtensionRequestResult {
  /** 本轮发出或仍在进行的安装。 */
  installing: string[];
  uninstalling: string[];
  /** 本进程内装卸命令失败过的扩展（市场里没有、平台不支持等），不再重发。 */
  failed: string[];
}

/**
 * 只向 IDE 发出装卸命令，不等结果：大扩展下载可能要几分钟，等待会一直占着跨窗口独占锁。
 * 装好与否由下一轮按扩展清单判断，清单文件的变化本身会触发下一轮。
 * 命令异步失败时清单不会变化，不会有下一轮来报告失败，因此用 onFailure 通知调用方再发起一轮。
 */
export function requestExtensionChanges(
  install: readonly string[],
  uninstall: readonly string[],
  onFailure?: () => void,
): ExtensionRequestResult {
  const failed: string[] = [];
  const send = (command: string, ids: readonly string[], failures: Set<string>): string[] => {
    const sent: string[] = [];
    for (const id of ids) {
      const key = id.toLowerCase();
      if (key === SELF_EXTENSION_ID) continue;
      if (failures.has(key)) {
        failed.push(id);
        continue;
      }
      sent.push(id);
      if (runningIds.has(key)) continue;
      runningIds.add(key);
      void Promise.resolve(vscode.commands.executeCommand(command, id)).then(
        () => runningIds.delete(key),
        () => {
          runningIds.delete(key);
          failures.add(key);
          onFailure?.();
        },
      );
    }
    return sent;
  };
  return {
    uninstalling: send('workbench.extensions.uninstallExtension', uninstall, failedUninstallIds),
    installing: send('workbench.extensions.installExtension', install, failedInstallIds),
    failed,
  };
}

export const testing = {
  reset(): void {
    failedInstallIds.clear();
    failedUninstallIds.clear();
    runningIds.clear();
  },
};
