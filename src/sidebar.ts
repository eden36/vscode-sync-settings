import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { ConfigurationStore } from './configuration';
import { hasEmbeddedCredentials } from './configuration-record';
import {
  HISTORY_LIMIT_MAX,
  HISTORY_PAGE_SIZE,
  HistoryEntry,
  OutgoingMessage,
  parseMessage,
} from './sidebar-messages';
import { displayPhase, displayTone, modeLabel, modeNote, profileMismatchText, stageLabel } from './sidebar-status';
import { ProfileMismatch, RuntimeStatus, SyncMode } from './types';

const HISTORY_MESSAGES: string[] = ['loadHistory', 'loadMoreHistory', 'restoreCommit', 'createTag', 'deleteTag'];

/** 历史页面上的操作全部转交扩展执行，侧边栏只做参数校验与转发。 */
export interface HistoryHandlers {
  load: (limit: number, refresh: boolean) => Promise<void>;
  loadMore: () => Promise<void>;
  restore: (hash: string) => Promise<void>;
  createTag: (hash: string) => Promise<void>;
  deleteTag: (hash: string, tag: string) => Promise<void>;
}

export interface SidebarOptions {
  /** 扩展安装目录，用于定位随包发布的 Webview 脚本与样式。 */
  extensionUri: vscode.Uri;
  configurationStore: ConfigurationStore;
  status: () => RuntimeStatus;
  onConfigurationSaved: () => Promise<void>;
  isEnabled: () => boolean;
  setEnabled: (enabled: boolean) => Promise<void>;
  onResolveConflict: (resolution: 'local' | 'cloud') => Promise<void>;
  /** 当前等待处理的 Profile 差异，来自跨窗口共享的运行状态，follower 窗口同样能看到。 */
  profileMismatch: () => ProfileMismatch | undefined;
  onResolveProfiles: () => Promise<void>;
  history: HistoryHandlers;
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private ready = false;
  private failure?: string;
  /** 面板尚未打开过时收到的打开历史请求，等视图就绪后补发。 */
  private historyRequested = false;

  public constructor(private readonly options: SidebarOptions) {}

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      // 只放行随包发布的两处资源目录，Webview 读不到扩展目录里的其他文件。
      localResourceRoots: [
        vscode.Uri.joinPath(this.options.extensionUri, 'media'),
        vscode.Uri.joinPath(this.options.extensionUri, 'dist', 'webview'),
      ],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage(async (raw: unknown) => {
      const message = parseMessage(raw);
      if (!message) {
        void vscode.window.showErrorMessage('侧边栏提交了无效参数。');
        return;
      }
      // 初始化尚未完成时状态与配置都还是默认值，此时改开关会写到一份还没读出来的配置上。
      if (!this.ready && message.type !== 'ready') {
        void vscode.window.showInformationMessage(this.failure ?? '配置同步正在初始化，请稍候。');
        return;
      }
      try {
        if (message.type === 'ready') {
          await this.pushState();
          if (this.historyRequested && this.ready) {
            this.historyRequested = false;
            await this.showHistoryPage();
          }
        } else if (message.type === 'toggleEnabled') {
          await this.options.setEnabled(message.enabled);
          await this.pushState();
        } else if (message.type === 'resolveConflict') {
          await this.options.onResolveConflict(message.resolution);
          await this.pushState();
        } else if (message.type === 'resolveProfiles') {
          await this.options.onResolveProfiles();
          await this.pushState();
        } else if (message.type === 'setMode') {
          await this.applyMode(message.mode);
          await this.pushState();
        } else if (message.type === 'loadHistory') {
          await this.options.history.load(message.limit, message.refresh);
        } else if (message.type === 'loadMoreHistory') {
          await this.options.history.loadMore();
        } else if (message.type === 'restoreCommit') {
          await this.options.history.restore(message.hash);
        } else if (message.type === 'createTag') {
          await this.options.history.createTag(message.hash);
        } else if (message.type === 'deleteTag') {
          await this.options.history.deleteTag(message.hash, message.tag);
        } else if (message.type === 'save') {
          if (hasEmbeddedCredentials(message.configuration.repositoryUrl)) {
            void vscode.window.showErrorMessage('配置同步仓库地址不能包含明文凭据，请使用 SSH 或系统凭据管理器。');
            return;
          }
          await this.options.configurationStore.save({
            ...this.options.configurationStore.get(),
            ...message.configuration,
            ...message.automation,
          });
          await this.options.onConfigurationSaved();
          await this.post({ type: 'configuration-saved' });
          await this.pushState();
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        // 处理失败时必须回显并刷新，否则侧边栏会一直停在中间态。
        if (message.type === 'save') await this.post({ type: 'save-failed' });
        // 历史页面的失败显示在页面内，弹窗会盖住用户正在看的列表。
        if (HISTORY_MESSAGES.includes(message.type)) {
          await this.postHistoryError(detail);
          await this.postHistoryBusy(false);
          return;
        }
        void vscode.window.showErrorMessage(detail);
        await this.pushState();
      }
    });
    void this.pushState();
  }

  /** 初始化完成、状态可信后才开始推送。 */
  public markReady(): void {
    this.ready = true;
  }

  /** 初始化失败时把原因显示在侧边栏，否则用户只会一直看到「正在加载」。 */
  public async fail(message: string): Promise<void> {
    this.failure = message;
    await this.pushState();
  }

  public async pushState(): Promise<void> {
    if (this.failure !== undefined) {
      await this.post({ type: 'failure', message: this.failure });
      return;
    }
    if (!this.ready) return;
    const status = this.options.status();
    const configuration = this.options.configurationStore.get();
    const mismatch = status.sync.kind === 'blocked' && status.sync.reason === 'profiles-mismatch'
      ? this.options.profileMismatch()
      : undefined;
    // 状态判定全部在此完成，Webview 脚本只负责按结果渲染。
    await this.post({
      type: 'state',
      configuration,
      enabled: this.options.isEnabled(),
      modeLabel: modeLabel(configuration.mode),
      modeNote: modeNote(configuration.mode),
      status: {
        ...status,
        displayPhase: displayPhase(status.sync, status.link),
        tone: displayTone(status.sync, status.link),
        ...(status.sync.kind === 'running' ? { stage: stageLabel(status.sync.stage) } : {}),
        // 判定放在这里：Webview 脚本只按结果显示或隐藏选择面板。
        needsChoice: status.sync.kind === 'blocked' && status.sync.reason === 'both-changed',
        ...(mismatch ? { profileChoice: profileMismatchText(mismatch) } : {}),
      },
    });
  }

  /** 切到历史页面并让侧边栏获得焦点：入口在标题栏与命令面板，用户点完要能直接看到页面。 */
  public async openHistoryPage(): Promise<void> {
    if (!this.view) {
      // 命令面板可能在面板从未打开过时触发，此时视图还没解析，先唤起容器再由 ready 补发。
      this.historyRequested = true;
      await vscode.commands.executeCommand('workbench.view.extension.profileGitSync');
      return;
    }
    this.view.show(true);
    await this.showHistoryPage();
  }

  public async closeHistoryPage(): Promise<void> {
    await this.post({ type: 'history-close' });
  }

  /** append 为真时 entries 只是新增的一页，Webview 需要追加渲染而不是整份替换。 */
  public async postHistoryList(
    entries: HistoryEntry[],
    options: { refreshing: boolean; hasMore: boolean; append: boolean },
  ): Promise<void> {
    await this.post({ type: 'history-list', entries, ...options });
  }

  public async postHistoryError(message: string): Promise<void> {
    await this.post({ type: 'history-error', message });
  }

  /** 还原与标签操作期间禁用页面按钮，避免同一条提交被连点两次。 */
  public async postHistoryBusy(busy: boolean): Promise<void> {
    await this.post({ type: 'history-busy', busy });
  }

  private async showHistoryPage(): Promise<void> {
    await this.post({ type: 'history-open', pageSize: HISTORY_PAGE_SIZE, limitMax: HISTORY_LIMIT_MAX });
    await this.options.history.load(HISTORY_PAGE_SIZE, true);
  }

  private async applyMode(mode: SyncMode): Promise<void> {
    const current = this.options.configurationStore.get();
    if (current.mode === mode) return;
    // 切到同步模式后云端内容会覆盖本机配置文件，属于破坏性变更，必须先确认。
    if (mode === 'sync') {
      const confirmed = await vscode.window.showWarningMessage(
        '切换到同步模式',
        {
          modal: true,
          detail: '同步模式会把仓库中的配置写回本机，覆盖本机对应的配置文件；本机尚未同步过时，首轮会整份采用云端配置。'
            + '扩展会按云端清单安装，本机有而云端清单没有的扩展会被卸载。本机原配置会先备份到扩展运行目录。'
            + '插件不会新建或删除 Profile，两侧 Profile 不一致时会暂停并请你处理。'
            + '若同时开启了 IDE 内置 Settings Sync，两者可能互相覆盖。',
        },
        '切换到同步模式',
      );
      if (confirmed !== '切换到同步模式') return;
    }
    await this.options.configurationStore.save({ ...current, mode });
    await this.options.onConfigurationSaved();
  }

  /** 发往 Webview 的消息统一从这里走，让消息结构与 Webview 脚本共用同一份类型。 */
  private async post(message: OutgoingMessage): Promise<void> {
    await this.view?.webview.postMessage(message);
  }

  /** 页面只有结构；样式在 media/sidebar.css，脚本由 src/webview/sidebar.ts 打包到 dist/webview。 */
  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.options.extensionUri, 'media', 'sidebar.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.options.extensionUri, 'dist', 'webview', 'sidebar.js'));
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${styleUri.toString()}">
</head><body>
<div id="mainPage">
<div class="sync-summary">
  <div class="sync-metric"><span class="metric-label">同步状态</span><span class="metric-value"><span id="syncDot" class="dot"></span><span id="syncPhase">正在加载</span></span></div>
  <div class="sync-metric"><span class="metric-label">上次同步</span><span id="lastSyncAt" class="metric-value">尚未同步</span></div>
  <div class="sync-metric"><span class="metric-label">运行模式</span><span id="syncMode" class="metric-value">正在加载</span></div>
</div>
<div class="status"><strong id="phase">正在加载</strong><div id="detail" class="muted"></div></div>
<div id="choicePanel" class="status" hidden><strong>需要选择以哪一方为准</strong><div class="muted">本机与云端都有改动。选定一方后，另一份配置会先备份到扩展运行目录。</div><div><button id="chooseLocal" type="button">以本机为准</button><button id="chooseCloud" class="secondary" type="button">以云端为准</button></div></div>
<div id="profilePanel" class="status" hidden><strong id="profileSummary"></strong><div id="profileDetail" class="muted"></div><div><button id="resolveProfiles" class="secondary" type="button"></button></div></div>
<div class="toggle-row"><span>同步开关</span><button id="toggleEnabled" class="toggle-switch" type="button" role="switch" aria-checked="false" aria-label="正在加载"></button></div>
<p class="muted">关闭后不创建本地仓库、不访问远程仓库，也不写回本机配置。</p>
<div class="mode-switch" role="group" aria-label="运行模式"><button id="modeBackup" type="button" data-mode="backup" aria-pressed="false">备份模式</button><button id="modeSync" type="button" data-mode="sync" aria-pressed="false">同步模式</button></div>
<p id="modeNote" class="muted"></p>
<div class="repository-details"><div class="repository-item"><span>远程仓库</span><strong id="repositorySummary">正在加载</strong></div><div class="repository-item"><span>分支</span><strong id="branchSummary">正在加载</strong></div></div>
<button id="editRepository" type="button">修改远程仓库</button>
<dialog id="configurationDialog" class="configuration-dialog"><form id="configurationForm" novalidate><h2>配置同步仓库</h2><label for="repositoryUrl">配置同步仓库地址</label><input id="repositoryUrl" placeholder="git@github.com:user/settings.git"><label for="branch">分支</label><input id="branch"><div class="row"><div><label for="gitUserName">Git 用户名（可选）</label><input id="gitUserName" placeholder="留空使用本机配置"></div><div><label for="gitUserEmail">Git 邮箱（可选）</label><input id="gitUserEmail" type="email" placeholder="留空使用本机配置"></div></div><div class="row"><div><label for="debounceSeconds">本地检测间隔（秒）</label><input id="debounceSeconds" type="number" min="5" step="5"></div><div><label for="pollIntervalSeconds">远程轮询间隔（秒）</label><input id="pollIntervalSeconds" type="number" min="30" step="30"></div></div><p class="muted">保存后会自动同步。同步模式下首次接入会以云端配置覆盖本机并按云端清单装卸扩展，原有配置会先备份；备份模式只把本机配置上传到仓库。</p><div class="dialog-actions"><button id="cancelConfiguration" class="secondary" type="button">取消</button><button id="saveConfiguration" type="submit">保存更改</button></div></form></dialog>
</div>
<div id="historyPage" hidden>
  <div class="history-header"><button id="historyBack" class="icon-button" type="button" title="返回">←</button><strong>云端提交历史</strong><button id="historyRefresh" class="icon-button" type="button" title="刷新">↻</button></div>
  <div id="historyRefreshing" class="muted" hidden>正在刷新云端记录…</div>
  <div id="historyError" class="status" hidden></div>
  <div id="historyBody"></div>
  <button id="historyMore" class="secondary" type="button" hidden>加载更多</button>
  <p class="muted">在某一项上点右键可以新增或删除标签。</p>
</div>
<div id="tagMenu" class="context-menu" hidden></div>
<script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body></html>`;
  }
}
