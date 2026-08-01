import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { ConfigurationStore, hasEmbeddedCredentials } from './configuration';
import { RuntimeStatus, SyncConfiguration } from './types';

interface AutomationSettings {
  autoSync: boolean;
  debounceSeconds: number;
  pollIntervalSeconds: number;
}

type IncomingMessage =
  | { type: 'save'; configuration: SyncConfiguration; automation: AutomationSettings }
  | { type: 'sync' }
  | { type: 'applyPending' };

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  public constructor(
    private readonly configurationStore: ConfigurationStore,
    private readonly status: () => RuntimeStatus,
    private readonly onSync: () => Promise<void>,
    private readonly onApplyPending: () => Promise<void>
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
      if (message.type === 'save') {
        if (hasEmbeddedCredentials(message.configuration.repositoryUrl)) {
          const proceed = await vscode.window.showWarningMessage(
            '仓库 URL 中包含明文凭据，建议使用 SSH 或系统凭据管理器。仍要保存吗？',
            { modal: true },
            '仍要保存'
          );
          if (proceed !== '仍要保存') return;
        }
        await this.configurationStore.save(message.configuration);
        const settings = vscode.workspace.getConfiguration('profileGitSync');
        await Promise.all([
          settings.update('autoSync', message.automation.autoSync, vscode.ConfigurationTarget.Global),
          settings.update('debounceSeconds', message.automation.debounceSeconds, vscode.ConfigurationTarget.Global),
          settings.update('pollIntervalSeconds', message.automation.pollIntervalSeconds, vscode.ConfigurationTarget.Global)
        ]);
        void vscode.window.showInformationMessage('同步配置已保存。');
        await this.pushState();
      } else if (message.type === 'sync') {
        await this.onSync();
      } else {
        await this.onApplyPending();
      }
    });
    void this.pushState();
  }

  public async pushState(): Promise<void> {
    await this.view?.webview.postMessage({
      type: 'state',
      configuration: this.configurationStore.get(),
      automation: this.getAutomationSettings(),
      status: this.status()
    });
  }

  private getAutomationSettings(): AutomationSettings {
    const settings = vscode.workspace.getConfiguration('profileGitSync');
    return {
      autoSync: settings.get<boolean>('autoSync', true),
      debounceSeconds: settings.get<number>('debounceSeconds', 60),
      pollIntervalSeconds: settings.get<number>('pollIntervalSeconds', 600)
    };
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
<label for="repositoryUrl">Git 仓库地址</label><input id="repositoryUrl" placeholder="git@github.com:user/settings.git">
<label for="branch">分支</label><input id="branch">
<div class="row"><div><label for="gitUserName">Git 用户名（可选）</label><input id="gitUserName" placeholder="留空使用本机配置"></div><div><label for="gitUserEmail">Git 邮箱（可选）</label><input id="gitUserEmail" type="email" placeholder="留空使用本机配置"></div></div>
<label class="check-label" for="autoSync"><input id="autoSync" type="checkbox">启用自动同步</label>
<div class="row"><div><label for="debounceSeconds">本地检测间隔（秒）</label><input id="debounceSeconds" type="number" min="5" step="5"></div><div><label for="pollIntervalSeconds">远程轮询间隔（秒）</label><input id="pollIntervalSeconds" type="number" min="30" step="30"></div></div>
<button id="save">保存</button><button id="sync" class="secondary">立即同步</button><button id="apply" class="secondary">安全应用</button>
<p class="muted">Git 身份留空时使用本机配置；认证始终使用本机 SSH 或凭据管理器。AI 无法使用或结果无效时，会采用固定提交信息和本机优先的冲突兜底，保证同步继续。多窗口中只有 leader 执行 Git 与 AI 操作。</p>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();const ids=['repositoryUrl','branch','gitUserName','gitUserEmail'];
document.getElementById('save').onclick=()=>{const configuration={};for(const id of ids)configuration[id]=document.getElementById(id).value;const automation={autoSync:document.getElementById('autoSync').checked,debounceSeconds:Number(document.getElementById('debounceSeconds').value),pollIntervalSeconds:Number(document.getElementById('pollIntervalSeconds').value)};vscode.postMessage({type:'save',configuration,automation})};
document.getElementById('sync').onclick=()=>vscode.postMessage({type:'sync'});document.getElementById('apply').onclick=()=>vscode.postMessage({type:'applyPending'});
addEventListener('message',({data})=>{if(data.type!=='state')return;for(const id of ids)document.getElementById(id).value=data.configuration[id]??'';document.getElementById('autoSync').checked=data.automation.autoSync;document.getElementById('debounceSeconds').value=String(data.automation.debounceSeconds);document.getElementById('pollIntervalSeconds').value=String(data.automation.pollIntervalSeconds);const s=data.status;document.getElementById('phase').textContent=s.phase+' · '+s.role;document.getElementById('detail').textContent='窗口 '+s.activeWindows+' · Profiles '+s.profiles.join('、')+(s.message?' · '+s.message:'');document.getElementById('syncPhase').textContent=s.phase;const dot=document.getElementById('syncDot');dot.className='dot '+syncClass(s.phase);const last=document.getElementById('lastSyncAt');if(s.lastSyncAt){const date=new Date(s.lastSyncAt);last.textContent=Number.isNaN(date.getTime())?'时间无效':date.toLocaleString();last.title=s.lastSyncAt}else{last.textContent='尚未同步';last.removeAttribute('title')}});
function syncClass(phase){if(phase==='失败')return'error';if(['正在扫描','正在拉取','等待 AI','正在提交','正在推送'].includes(phase))return'running';if(['等待其他窗口关闭','存在冲突'].includes(phase))return'warning';if(phase==='空闲')return'success';return''}
</script></body></html>`;
  }
}

function parseMessage(raw: unknown): IncomingMessage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (value.type === 'sync') return { type: 'sync' };
  if (value.type === 'applyPending') return { type: 'applyPending' };
  if (value.type !== 'save' || !value.configuration || typeof value.configuration !== 'object' || !value.automation || typeof value.automation !== 'object') return undefined;
  const configuration = value.configuration as Record<string, unknown>;
  const strings = ['repositoryUrl', 'branch', 'gitUserName', 'gitUserEmail'];
  if (!strings.every((key) => typeof configuration[key] === 'string')) return undefined;
  if (/\r|\n/.test(configuration.repositoryUrl as string) || !/^[A-Za-z0-9._/-]+$/.test(configuration.branch as string)) return undefined;
  const automation = value.automation as Record<string, unknown>;
  if (typeof automation.autoSync !== 'boolean') return undefined;
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
