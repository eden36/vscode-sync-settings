import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { ConfigurationStore } from './configuration';
import { hasEmbeddedCredentials, isValidBranch } from './configuration-record';
import { displayPhase, displayTone, modeLabel, modeNote, stageLabel } from './sidebar-status';
import { RuntimeStatus, SyncConfiguration, SyncMode } from './types';

interface AutomationSettings {
  debounceSeconds: number;
  pollIntervalSeconds: number;
  includeProfileAssociations: boolean;
}

type IncomingMessage =
  | { type: 'ready' }
  | { type: 'save'; configuration: SyncConfiguration; automation: AutomationSettings }
  | { type: 'toggleEnabled'; enabled: boolean }
  | { type: 'setMode'; mode: SyncMode };

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
        } else if (message.type === 'setMode') {
          await this.applyMode(message.mode);
          await this.pushState();
        } else if (message.type === 'save') {
          if (hasEmbeddedCredentials(message.configuration.repositoryUrl)) {
            void vscode.window.showErrorMessage('配置同步仓库地址不能包含明文凭据，请使用 SSH 或系统凭据管理器。');
            return;
          }
          await this.configurationStore.save({
            ...this.configurationStore.get(),
            ...message.configuration,
            ...message.automation,
            includeProfileAssociations: true,
          });
          await this.onConfigurationSaved();
          await this.view?.webview.postMessage({ type: 'configuration-saved' });
          await this.pushState();
        }
      } catch (error) {
        // 处理失败时必须回显并刷新，否则侧边栏会一直停在中间态。
        if (message.type === 'save') await this.view?.webview.postMessage({ type: 'save-failed' });
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        await this.pushState();
      }
    });
    void this.pushState();
  }

  public async pushState(): Promise<void> {
    const status = this.status();
    const configuration = this.configurationStore.get();
    // 状态判定全部在此完成，内联脚本只负责按结果渲染。
    await this.view?.webview.postMessage({
      type: 'state',
      configuration,
      enabled: this.isEnabled(),
      modeLabel: modeLabel(configuration.mode),
      modeNote: modeNote(configuration.mode),
      status: {
        ...status,
        displayPhase: displayPhase(status.sync, status.link),
        tone: displayTone(status.sync, status.link),
        stage: status.sync.kind === 'running' ? stageLabel(status.sync.stage) : undefined,
      }
    });
  }

  private async applyMode(mode: SyncMode): Promise<void> {
    const current = this.configurationStore.get();
    if (current.mode === mode) return;
    // 切到同步模式后云端内容会覆盖本机配置文件，属于破坏性变更，必须先确认。
    if (mode === 'sync') {
      const confirmed = await vscode.window.showWarningMessage(
        '切换到同步模式',
        {
          modal: true,
          detail: '同步模式会把仓库中的配置写回本机，覆盖本机对应的配置文件与扩展清单。若同时开启了 IDE 内置 Settings Sync，两者可能互相覆盖。',
        },
        '切换到同步模式',
      );
      if (confirmed !== '切换到同步模式') return;
    }
    await this.configurationStore.save({ ...current, mode });
    await this.onConfigurationSaved();
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:var(--vscode-font-family);padding:12px;color:var(--vscode-foreground)}label{display:block;margin:10px 0 4px}
input,select{box-sizing:border-box;width:100%;padding:6px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border)}
button{margin:12px 6px 0 0;padding:7px 11px;border:0;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}
button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
button:disabled{cursor:default;opacity:.6}
.toggle-row{display:flex;align-items:center;gap:10px;margin-top:12px}.toggle-row span{flex:none}
button.toggle-switch{position:relative;width:38px;height:22px;margin:0;padding:0;border-radius:11px;background:var(--vscode-button-secondaryBackground);transition:background .15s ease}
button.toggle-switch::after{content:'';position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:var(--vscode-button-foreground);transition:transform .15s ease}
button.toggle-switch.enabled{background:var(--vscode-testing-iconPassed)}button.toggle-switch.enabled::after{transform:translateX(16px)}
.mode-switch{display:grid;grid-template-columns:1fr 1fr;gap:1px;margin-top:14px;background:var(--vscode-panel-border);border:1px solid var(--vscode-panel-border)}
.mode-switch button{margin:0;padding:7px 6px;background:var(--vscode-sideBar-background);color:var(--vscode-foreground)}.mode-switch button.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.sync-summary{display:grid;grid-template-columns:1fr 1fr 1fr;gap:1px;margin-bottom:10px;background:var(--vscode-panel-border)}
.sync-metric{min-width:0;padding:10px;background:var(--vscode-sideBar-background)}.metric-label{display:block;margin-bottom:5px;opacity:.7;font-size:11px}.metric-value{display:flex;align-items:center;gap:6px;font-weight:600;overflow-wrap:anywhere}
.dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--vscode-descriptionForeground)}.dot.muted{background:var(--vscode-descriptionForeground)}.dot.success{background:var(--vscode-testing-iconPassed)}.dot.running{background:var(--vscode-progressBar-background)}.dot.warning{background:var(--vscode-editorWarning-foreground)}.dot.error{background:var(--vscode-testing-iconFailed)}
.status{padding:10px;background:var(--vscode-textBlockQuote-background);border-left:3px solid var(--vscode-focusBorder)}.muted{opacity:.75;font-size:12px}.row{display:grid;grid-template-columns:1fr 1fr;gap:8px}.repository-details{display:grid;gap:8px;margin-top:14px}.repository-item{display:grid;gap:3px}.repository-item span{opacity:.7;font-size:11px}.repository-item strong{font-weight:400;overflow-wrap:anywhere}.configuration-dialog{max-width:calc(100vw - 32px);width:420px;padding:16px;border:1px solid var(--vscode-editorWidget-border);background:var(--vscode-editorWidget-background);color:var(--vscode-editorWidget-foreground)}.configuration-dialog::backdrop{background:rgba(0,0,0,.45)}.configuration-dialog h2{margin:0 0 8px;font-size:15px}.dialog-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:4px}.dialog-actions button{margin:0}
</style></head><body>
<div class="sync-summary">
  <div class="sync-metric"><span class="metric-label">同步状态</span><span class="metric-value"><span id="syncDot" class="dot"></span><span id="syncPhase">正在加载</span></span></div>
  <div class="sync-metric"><span class="metric-label">上次同步</span><span id="lastSyncAt" class="metric-value">尚未同步</span></div>
  <div class="sync-metric"><span class="metric-label">运行模式</span><span id="syncMode" class="metric-value">正在加载</span></div>
</div>
<div class="status"><strong id="phase">正在加载</strong><div id="detail" class="muted"></div></div>
<div class="toggle-row"><span>同步开关</span><button id="toggleEnabled" class="toggle-switch" type="button" role="switch" aria-checked="false" aria-label="正在加载"></button></div>
<p class="muted">关闭后不创建本地仓库、不访问远程仓库，也不写回本机配置。</p>
<div class="mode-switch" role="group" aria-label="运行模式"><button id="modeBackup" type="button" data-mode="backup" aria-pressed="false">备份模式</button><button id="modeSync" type="button" data-mode="sync" aria-pressed="false">同步模式</button></div>
<p id="modeNote" class="muted"></p>
<div class="repository-details"><div class="repository-item"><span>远程仓库</span><strong id="repositorySummary">正在加载</strong></div><div class="repository-item"><span>分支</span><strong id="branchSummary">正在加载</strong></div></div>
<button id="editRepository" type="button">修改远程仓库</button>
<dialog id="configurationDialog" class="configuration-dialog"><form id="configurationForm" novalidate><h2>配置同步仓库</h2><label for="repositoryUrl">配置同步仓库地址</label><input id="repositoryUrl" placeholder="git@github.com:user/settings.git"><label for="branch">分支</label><input id="branch"><div class="row"><div><label for="gitUserName">Git 用户名（可选）</label><input id="gitUserName" placeholder="留空使用本机配置"></div><div><label for="gitUserEmail">Git 邮箱（可选）</label><input id="gitUserEmail" type="email" placeholder="留空使用本机配置"></div></div><div class="row"><div><label for="debounceSeconds">本地检测间隔（秒）</label><input id="debounceSeconds" type="number" min="5" step="5"></div><div><label for="pollIntervalSeconds">远程轮询间隔（秒）</label><input id="pollIntervalSeconds" type="number" min="30" step="30"></div></div><p class="muted">保存后会自动同步。同步模式下首次接入会以云端配置覆盖本机，原有配置会先备份；备份模式只把本机配置上传到仓库。</p><div class="dialog-actions"><button id="cancelConfiguration" class="secondary" type="button">取消</button><button id="saveConfiguration" type="submit">保存更改</button></div></form></dialog>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();const ids=['repositoryUrl','branch','gitUserName','gitUserEmail'];const toggleEnabled=document.getElementById('toggleEnabled');const editRepository=document.getElementById('editRepository');const configurationDialog=document.getElementById('configurationDialog');const configurationForm=document.getElementById('configurationForm');const cancelConfiguration=document.getElementById('cancelConfiguration');const saveConfiguration=document.getElementById('saveConfiguration');const modeButtons=[document.getElementById('modeBackup'),document.getElementById('modeSync')];let configuration={};let enabled=false;let lastSyncAt;
toggleEnabled.onclick=()=>{toggleEnabled.disabled=true;vscode.postMessage({type:'toggleEnabled',enabled:!enabled})};
for(const button of modeButtons)button.onclick=()=>{for(const other of modeButtons)other.disabled=true;vscode.postMessage({type:'setMode',mode:button.dataset.mode})};
editRepository.onclick=()=>{for(const id of ids)document.getElementById(id).value=configuration[id]??'';document.getElementById('debounceSeconds').value=String(configuration.debounceSeconds??'');document.getElementById('pollIntervalSeconds').value=String(configuration.pollIntervalSeconds??'');configurationDialog.showModal()};
cancelConfiguration.onclick=()=>configurationDialog.close();
configurationForm.onsubmit=(event)=>{event.preventDefault();const next={};for(const id of ids)next[id]=document.getElementById(id).value;const automation={includeProfileAssociations:true,debounceSeconds:Number(document.getElementById('debounceSeconds').value),pollIntervalSeconds:Number(document.getElementById('pollIntervalSeconds').value)};saveConfiguration.disabled=true;cancelConfiguration.disabled=true;vscode.postMessage({type:'save',configuration:next,automation})};
addEventListener('message',({data})=>{if(data.type==='configuration-saved'){saveConfiguration.disabled=false;cancelConfiguration.disabled=false;configurationDialog.close();return}if(data.type==='save-failed'){saveConfiguration.disabled=false;cancelConfiguration.disabled=false;return}if(data.type!=='state')return;configuration=data.configuration;enabled=data.enabled===true;toggleEnabled.className=enabled?'toggle-switch enabled':'toggle-switch';toggleEnabled.setAttribute('aria-checked',String(enabled));toggleEnabled.setAttribute('aria-label',enabled?'停止同步':'开启同步');toggleEnabled.disabled=false;document.getElementById('repositorySummary').textContent=configuration.repositoryUrl||'未配置远程仓库';document.getElementById('branchSummary').textContent=configuration.branch||'未配置分支';for(const button of modeButtons){const active=button.dataset.mode===configuration.mode;button.className=active?'active':'';button.setAttribute('aria-pressed',String(active));button.disabled=false}document.getElementById('syncMode').textContent=data.modeLabel;document.getElementById('modeNote').textContent=data.modeNote;const s=data.status;document.getElementById('phase').textContent=s.displayPhase+' · '+s.role;const notes=['窗口 '+s.activeWindows,'Profiles '+s.profiles.join('、')];if(s.stage)notes.push(s.stage);if(s.message)notes.push(s.message);document.getElementById('detail').textContent=notes.join(' · ');document.getElementById('syncPhase').textContent=s.displayPhase;document.getElementById('syncDot').className='dot '+s.tone;lastSyncAt=s.lastSyncAt;renderLastSyncAt()});
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
  if (value.type === 'setMode') {
    return value.mode === 'backup' || value.mode === 'sync' ? { type: 'setMode', mode: value.mode } : undefined;
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
