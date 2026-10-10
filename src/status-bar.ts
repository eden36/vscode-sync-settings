import * as vscode from 'vscode';
import { displayIcon, displayPhase, stageLabel } from './sidebar-status';
import { RuntimeStatus } from './types';

const STATUS_BAR_ID = 'profileGitSync.status';

/** 同步全过程不弹通知，状态只落在状态栏和侧边栏，避免打断用户。 */
export class SyncStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  public constructor() {
    this.item = vscode.window.createStatusBarItem(STATUS_BAR_ID, vscode.StatusBarAlignment.Right, 100);
    this.item.name = 'My Setting Sync';
    this.item.command = 'profileGitSync.openSettings';
  }

  public render(status: RuntimeStatus): void {
    const phase = displayPhase(status.sync, status.link);
    const detail = statusDetail(status);
    this.item.text = `${displayIcon(status.sync, status.link)} 配置同步`;
    this.item.tooltip = detail ? `配置同步：${phase}\n${detail}` : `配置同步：${phase}`;
    this.item.backgroundColor = status.sync.kind === 'failed'
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
    this.item.show();
  }

  public dispose(): void {
    this.item.dispose();
  }
}

/** 初始化失败后扩展无法工作，但仍要让用户看到原因和恢复方式。 */
export function reportActivationFailure(context: vscode.ExtensionContext, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const statusBar = vscode.window.createStatusBarItem(STATUS_BAR_ID, vscode.StatusBarAlignment.Right, 100);
  statusBar.name = 'My Setting Sync';
  statusBar.text = '$(error) 配置同步';
  statusBar.tooltip = `配置同步启动失败：${message}\n重载窗口后会重新尝试。`;
  statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  statusBar.show();
  context.subscriptions.push(statusBar);
  void vscode.window.showErrorMessage(`配置同步启动失败：${message}`);
}

/** 进行中的步骤在前，具体说明在后。 */
function statusDetail(status: RuntimeStatus): string | undefined {
  const lines: string[] = [];
  if (status.sync.kind === 'running') lines.push(stageLabel(status.sync.stage));
  if (status.message) lines.push(status.message);
  return lines.length ? lines.join('\n') : undefined;
}
