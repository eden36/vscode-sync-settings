import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { ConfigurationStore } from './configuration';
import { hasEmbeddedCredentials, isValidBranch } from './configuration-record';
import { displayPhase, displayTone, stageLabel } from './sidebar-status';
import { RuntimeStatus, SyncConfiguration } from './types';

interface AutomationSettings {
  debounceSeconds: number;
  pollIntervalSeconds: number;
  includeProfileAssociations: boolean;
}

type IncomingMessage =
  | { type: 'ready' }
  | { type: 'save'; configuration: SyncConfiguration; automation: AutomationSettings }
  | { type: 'toggleEnabled'; enabled: boolean };

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  public constructor(
    private readonly configurationStore: ConfigurationStore,
    private readonly status: () => RuntimeStatus,
    private readonly onConfigurationSaved: () => Promise<void>,
    private readonly isEnabled: () => boolean,
    private readonly setEnabled: (enabled: boolean) => Promise<void>,
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
        } else if (message.type === 'toggleEnabled') {
          await this.setEnabled(message.enabled);
          await this.pushState();
        } else if (message.type === 'save') {
          if (hasEmbeddedCredentials(message.configuration.repositoryUrl)) {
            void vscode.window.showErrorMessage('配置同步仓库地址不能包含明文凭据，请使用 SSH 或系统凭据管理器。');
            return;
          }
          await this.configurationStore.save({
            ...message.configuration,
            ...message.automation,
            includeProfileAssociations: true,
          });
          await this.onConfigurationSaved();
          await this.pushState();
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
    // 状态判定全部在此完成，内联脚本只负责按结果渲染。
    await this.view?.webview.postMessage({
      type: 'state',
      configuration: this.configurationStore.get(),
      enabled: this.isEnabled(),
      status: {
        ...status,
        displayPhase: displayPhase(status.sync, status.link),
        tone: displayTone(status.sync, status.link),
        stage: status.sync.kind === 'running' ? stageLabel(status.sync.stage) : undefined,
      }
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
.dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--vscode-descriptionForeground)}.dot.muted{background:var(--vscode-descriptionForeground)}.dot.success{background:var(--vscode-testing-iconPassed)}.dot.running{background:var(--vscode-progressBar-background)}.dot.warning{background:var(--vscode-editorWarning-foreground)}.dot.error{background:var(--vscode-testing-iconFailed)}
.status{padding:10px;background:var(--vscode-textBlockQuote-background);border-left:3px solid var(--vscode-focusBorder)}.muted{opacity:.75;font-size:12px}.row{display:grid;grid-template-columns:1fr 1fr;gap:8px}
</style></head><body>
<div class="sync-summary">
  <div class="sync-metric"><span class="metric-label">同步状态</span><span class="metric-value"><span id="syncDot" class="dot"></span><span id="syncPhase">正在加载</span></span></div>
  <div class="sync-metric"><span class="metric-label">上次同步</span><span id="lastSyncAt" class="metric-value">尚未同步</span></div>
</div>
<div class="status"><strong id="phase">正在加载</strong><div id="detail" class="muted"></div></div>
<label class="check-label" for="enabled"><input type="checkbox" id="enabled">启用配置同步</label>
<p class="muted">关闭后不创建本地仓库、不访问远程仓库，也不写回本机配置。</p>
<label for="repositoryUrl">配置同步仓库地址</label><input id="repositoryUrl" placeholder="git@github.com:user/settings.git">
<label for="branch">分支</label><input id="branch">
<div class="row"><div><label for="gitUserName">Git 用户名（可选）</label><input id="gitUserName" placeholder="留空使用本机配置"></div><div><label for="gitUserEmail">Git 邮箱（可选）</label><input id="gitUserEmail" type="email" placeholder="留空使用本机配置"></div></div>
<div class="row"><div><label for="debounceSeconds">本地检测间隔（秒）</label><input id="debounceSeconds" type="number" min="5" step="5"></div><div><label for="pollIntervalSeconds">远程轮询间隔（秒）</label><input id="pollIntervalSeconds" type="number" min="30" step="30"></div></div>
<button id="save">保存</button>
<p class="muted">保存后自动同步，冲突优先交给 AI 合并，AI 不可用时按本机优先自动处理，合并前的两份配置保留在扩展运行目录的 conflict-backups 中。本机首次接入时以云端配置覆盖本机，本轮不会把本机配置推到云端，原有配置会先备份。若本地缓存与远端不同源，会询问是否废弃缓存并按云端覆盖。Profile 增删在只剩一个窗口时自动应用并重载。配置同步仓库位于扩展全局存储中，不会操作当前项目的 Git 仓库。</p>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();const ids=['repositoryUrl','branch','gitUserName','gitUserEmail'];let lastSyncAt;
document.getElementById('save').onclick=()=>{const configuration={};for(const id of ids)configuration[id]=document.getElementById(id).value;const automation={includeProfileAssociations:true,debounceSeconds:Number(document.getElementById('debounceSeconds').value),pollIntervalSeconds:Number(document.getElementById('pollIntervalSeconds').value)};vscode.postMessage({type:'save',configuration,automation})};
document.getElementById('enabled').onchange=(event)=>vscode.postMessage({type:'toggleEnabled',enabled:event.target.checked});
addEventListener('message',({data})=>{if(data.type!=='state')return;document.getElementById('enabled').checked=data.enabled===true;for(const id of ids)document.getElementById(id).value=data.configuration[id]??'';document.getElementById('debounceSeconds').value=String(data.configuration.debounceSeconds);document.getElementById('pollIntervalSeconds').value=String(data.configuration.pollIntervalSeconds);const s=data.status;document.getElementById('phase').textContent=s.displayPhase+' · '+s.role;const notes=['窗口 '+s.activeWindows,'Profiles '+s.profiles.join('、')];if(s.stage)notes.push(s.stage);if(s.message)notes.push(s.message);document.getElementById('detail').textContent=notes.join(' · ');document.getElementById('syncPhase').textContent=s.displayPhase;document.getElementById('syncDot').className='dot '+s.tone;lastSyncAt=s.lastSyncAt;renderLastSyncAt()});
vscode.postMessage({type:'ready'});
setInterval(renderLastSyncAt,60_000);
function renderLastSyncAt(){const last=document.getElementById('lastSyncAt');if(!lastSyncAt){last.textContent='尚未同步';last.removeAttribute('title');return}const date=new Date(lastSyncAt);if(Number.isNaN(date.getTime())){last.textContent='时间无效';last.removeAttribute('title');return}last.textContent=date.toLocaleString()+'（'+relativeTime(date.getTime())+'）';last.title=lastSyncAt}
function relativeTime(timestamp){const elapsed=Math.max(0,Date.now()-timestamp);if(elapsed<60_000)return'刚刚';if(elapsed<3_600_000)return Math.floor(elapsed/60_000)+'分钟前';if(elapsed<86_400_000)return Math.floor(elapsed/3_600_000)+'小时前';return Math.floor(elapsed/86_400_000)+'天前'}
</script></body></html>`;
  }
}

function parseMessage(raw: unknown): IncomingMessage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (value.type === 'ready') return { type: 'ready' };
  if (value.type === 'toggleEnabled') {
    return typeof value.enabled === 'boolean' ? { type: 'toggleEnabled', enabled: value.enabled } : undefined;
  }
  if (value.type !== 'save' || !value.configuration || typeof value.configuration !== 'object' || !value.automation || typeof value.automation !== 'object') return undefined;
  const configuration = value.configuration as Record<string, unknown>;
  const strings = ['repositoryUrl', 'branch', 'gitUserName', 'gitUserEmail'];
  if (!strings.every((key) => typeof configuration[key] === 'string')) return undefined;
  if (/\r|\n/.test(configuration.repositoryUrl as string) || !isValidBranch(configuration.branch as string)) return undefined;
  const automation = value.automation as Record<string, unknown>;
  if (typeof automation.includeProfileAssociations !== 'boolean') return undefined;
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
