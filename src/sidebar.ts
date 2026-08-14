import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { ConfigurationStore } from './configuration';
import { hasEmbeddedCredentials, isValidBranch } from './configuration-record';
import { displaySyncPhase } from './sidebar-status';
import { RuntimeStatus, SyncConfiguration } from './types';

interface AutomationSettings {
  autoSync: boolean;
  debounceSeconds: number;
  pollIntervalSeconds: number;
  includeProfileAssociations: boolean;
}

type IncomingMessage =
  | { type: 'ready' }
  | { type: 'save'; configuration: SyncConfiguration; automation: AutomationSettings }
  | { type: 'sync' }
  | { type: 'rebuild' };

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  public constructor(
    private readonly configurationStore: ConfigurationStore,
    private readonly status: () => RuntimeStatus,
    private readonly onSync: () => Promise<void>,
    private readonly onConfigurationSaved: () => Promise<void>,
    private readonly onRebuild: () => Promise<void>,
  ) {}

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage(async (raw: unknown) => {
      const message = parseMessage(raw);
      if (!message) {
        void vscode.window.showErrorMessage('侧边栏提交了无效参数。');
        return;
      }
      try {
        if (message.type === 'ready') {
          await this.pushState();
        } else if (message.type === 'save') {
          if (hasEmbeddedCredentials(message.configuration.repositoryUrl)) {
            void vscode.window.showErrorMessage('配置同步仓库地址不能包含明文凭据，请使用 SSH 或系统凭据管理器。');
            return;
          }
          await this.configurationStore.save({ ...message.configuration, ...message.automation });
          await this.onConfigurationSaved();
          await this.pushState();
        } else if (message.type === 'rebuild') {
          await this.onRebuild();
        } else {
          await this.onSync();
        }
      } catch (error) {
        // 处理失败时必须回显并刷新，否则侧边栏会一直停在中间态。
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        await this.pushState();
      }
    });
    void this.pushState();
  }

  public async pushState(): Promise<void> {
    const status = this.status();
    await this.view?.webview.postMessage({
      type: 'state',
      configuration: this.configurationStore.get(),
      status: { ...status, displayPhase: displaySyncPhase(status.phase, status.lastSyncAt) }
    });
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:var(--vscode-font-family);padding:12px;color:var(--vscode-foreground)}label{display:block;margin:10px 0 4px}
input,select{box-sizing:border-box;width:100%;padding:6px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border)}input[type=checkbox]{width:auto;margin:0 7px 0 0}.check-label{display:flex;align-items:center;margin-top:12px}
button{margin:12px 6px 0 0;padding:7px 11px;border:0;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}
button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.sync-summary{display:grid;grid-template-columns:1fr 1fr;gap:1px;margin-bottom:10px;background:var(--vscode-panel-border)}
.sync-metric{min-width:0;padding:10px;background:var(--vscode-sideBar-background)}.metric-label{display:block;margin-bottom:5px;opacity:.7;font-size:11px}.metric-value{display:flex;align-items:center;gap:6px;font-weight:600;overflow-wrap:anywhere}
.dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--vscode-descriptionForeground)}.dot.success{background:var(--vscode-testing-iconPassed)}.dot.running{background:var(--vscode-progressBar-background)}.dot.warning{background:var(--vscode-editorWarning-foreground)}.dot.error{background:var(--vscode-testing-iconFailed)}
.status{padding:10px;background:var(--vscode-textBlockQuote-background);border-left:3px solid var(--vscode-focusBorder)}.muted{opacity:.75;font-size:12px}.row{display:grid;grid-template-columns:1fr 1fr;gap:8px}
</style></head><body>
<div class="sync-summary">
  <div class="sync-metric"><span class="metric-label">同步状态</span><span class="metric-value"><span id="syncDot" class="dot"></span><span id="syncPhase">正在加载</span></span></div>
  <div class="sync-metric"><span class="metric-label">上次同步</span><span id="lastSyncAt" class="metric-value">尚未同步</span></div>
</div>
<div class="status"><strong id="phase">正在加载</strong><div id="detail" class="muted"></div></div>
<label for="repositoryUrl">配置同步仓库地址</label><input id="repositoryUrl" placeholder="git@github.com:user/settings.git">
<label for="branch">分支</label><input id="branch">
<div class="row"><div><label for="gitUserName">Git 用户名（可选）</label><input id="gitUserName" placeholder="留空使用本机配置"></div><div><label for="gitUserEmail">Git 邮箱（可选）</label><input id="gitUserEmail" type="email" placeholder="留空使用本机配置"></div></div>
<label class="check-label" for="autoSync"><input id="autoSync" type="checkbox">启用自动同步</label>
<label class="check-label" for="includeProfileAssociations"><input id="includeProfileAssociations" type="checkbox">同步工作区与 Profile 关联关系</label>
<div class="row"><div><label for="debounceSeconds">本地检测间隔（秒）</label><input id="debounceSeconds" type="number" min="5" step="5"></div><div><label for="pollIntervalSeconds">远程轮询间隔（秒）</label><input id="pollIntervalSeconds" type="number" min="30" step="30"></div></div>
<button id="save">保存</button><button id="sync" class="secondary">立即同步</button><button id="rebuild" class="secondary">重建本地仓库</button>
<p class="muted">配置变化会自动同步，冲突优先交给 AI 合并，AI 不可用时按本机优先自动处理，合并前的两份配置保留在扩展运行目录的 conflict-backups 中。本机首次接入时直接采用云端配置，原有配置会先备份。若提示本地仓库与远端不同源，点击「重建本地仓库」重新克隆即可。Profile 增删在只剩一个窗口时自动应用并重载。配置同步仓库位于扩展全局存储中，不会操作当前项目的 Git 仓库。</p>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();const ids=['repositoryUrl','branch','gitUserName','gitUserEmail'];let lastSyncAt;
document.getElementById('save').onclick=()=>{const configuration={};for(const id of ids)configuration[id]=document.getElementById(id).value;const automation={autoSync:document.getElementById('autoSync').checked,includeProfileAssociations:document.getElementById('includeProfileAssociations').checked,debounceSeconds:Number(document.getElementById('debounceSeconds').value),pollIntervalSeconds:Number(document.getElementById('pollIntervalSeconds').value)};vscode.postMessage({type:'save',configuration,automation})};
document.getElementById('sync').onclick=()=>vscode.postMessage({type:'sync'});
document.getElementById('rebuild').onclick=()=>vscode.postMessage({type:'rebuild'});
addEventListener('message',({data})=>{if(data.type!=='state')return;for(const id of ids)document.getElementById(id).value=data.configuration[id]??'';document.getElementById('autoSync').checked=data.configuration.autoSync;document.getElementById('includeProfileAssociations').checked=data.configuration.includeProfileAssociations;document.getElementById('debounceSeconds').value=String(data.configuration.debounceSeconds);document.getElementById('pollIntervalSeconds').value=String(data.configuration.pollIntervalSeconds);const s=data.status;document.getElementById('phase').textContent=s.displayPhase+' · '+s.role;document.getElementById('detail').textContent='窗口 '+s.activeWindows+' · Profiles '+s.profiles.join('、')+(s.message?' · '+s.message:'');document.getElementById('syncPhase').textContent=s.displayPhase;const dot=document.getElementById('syncDot');dot.className='dot '+syncClass(s.displayPhase);lastSyncAt=s.lastSyncAt;renderLastSyncAt()});
vscode.postMessage({type:'ready'});
setInterval(renderLastSyncAt,60_000);
function renderLastSyncAt(){const last=document.getElementById('lastSyncAt');if(!lastSyncAt){last.textContent='尚未同步';last.removeAttribute('title');return}const date=new Date(lastSyncAt);if(Number.isNaN(date.getTime())){last.textContent='时间无效';last.removeAttribute('title');return}last.textContent=date.toLocaleString()+'（'+relativeTime(date.getTime())+'）';last.title=lastSyncAt}
function relativeTime(timestamp){const elapsed=Math.max(0,Date.now()-timestamp);if(elapsed<60_000)return'刚刚';if(elapsed<3_600_000)return Math.floor(elapsed/60_000)+'分钟前';if(elapsed<86_400_000)return Math.floor(elapsed/3_600_000)+'小时前';return Math.floor(elapsed/86_400_000)+'天前'}
function syncClass(phase){if(phase==='失败')return'error';if(['正在扫描','正在拉取','等待 AI','正在提交','正在推送','正在同步扩展'].includes(phase))return'running';if(phase==='等待其他窗口关闭')return'warning';if(phase==='已同步')return'success';return''}
</script></body></html>`;
  }
}

function parseMessage(raw: unknown): IncomingMessage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (value.type === 'ready') return { type: 'ready' };
  if (value.type === 'sync') return { type: 'sync' };
  if (value.type === 'rebuild') return { type: 'rebuild' };
  if (value.type !== 'save' || !value.configuration || typeof value.configuration !== 'object' || !value.automation || typeof value.automation !== 'object') return undefined;
  const configuration = value.configuration as Record<string, unknown>;
  const strings = ['repositoryUrl', 'branch', 'gitUserName', 'gitUserEmail'];
  if (!strings.every((key) => typeof configuration[key] === 'string')) return undefined;
  if (/\r|\n/.test(configuration.repositoryUrl as string) || !isValidBranch(configuration.branch as string)) return undefined;
  const automation = value.automation as Record<string, unknown>;
  if (typeof automation.autoSync !== 'boolean' || typeof automation.includeProfileAssociations !== 'boolean') return undefined;
  if (!validInterval(automation.debounceSeconds, 5) || !validInterval(automation.pollIntervalSeconds, 30)) return undefined;
  return {
    type: 'save',
    configuration: configuration as unknown as SyncConfiguration,
    automation: automation as unknown as AutomationSettings
  };
}

function validInterval(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= 86_400;
}
