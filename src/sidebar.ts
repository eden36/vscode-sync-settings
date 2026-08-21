import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { ConfigurationStore } from './configuration';
import { hasEmbeddedCredentials, isValidBranch, isValidTagName } from './configuration-record';
import { MAX_COMMIT_LIST } from './git-service';
import { displayPhase, displayTone, modeLabel, modeNote, stageLabel } from './sidebar-status';
import { RuntimeStatus, SyncConfiguration, SyncMode } from './types';

/** 历史页面每次向扩展索要的条数，上限由 git-service 收口。 */
export const HISTORY_PAGE_SIZE = 30;
const HISTORY_MESSAGES: string[] = ['loadHistory', 'restoreCommit', 'createTag', 'deleteTag'];

interface AutomationSettings {
  debounceSeconds: number;
  pollIntervalSeconds: number;
}

/** 历史页面上要显示的一条提交，时间格式化交给 Webview，与上次同步时间的渲染方式一致。 */
export interface HistoryEntry {
  hash: string;
  shortHash: string;
  subject: string;
  committedAt: string;
  tags: string[];
}

/** 历史页面上的操作全部转交扩展执行，侧边栏只做参数校验与转发。 */
export interface HistoryHandlers {
  load: (limit: number, refresh: boolean) => Promise<void>;
  restore: (hash: string) => Promise<void>;
  createTag: (hash: string) => Promise<void>;
  deleteTag: (hash: string, tag: string) => Promise<void>;
}

type IncomingMessage =
  | { type: 'ready' }
  | { type: 'save'; configuration: SyncConfiguration; automation: AutomationSettings }
  | { type: 'toggleEnabled'; enabled: boolean }
  | { type: 'setMode'; mode: SyncMode }
  | { type: 'resolveConflict'; resolution: 'local' | 'cloud' }
  | { type: 'loadHistory'; limit: number; refresh: boolean }
  | { type: 'restoreCommit'; hash: string }
  | { type: 'createTag'; hash: string }
  | { type: 'deleteTag'; hash: string; tag: string };

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private ready = false;
  private failure?: string;
  /** 面板尚未打开过时收到的打开历史请求，等视图就绪后补发。 */
  private historyRequested = false;

  public constructor(
    private readonly configurationStore: ConfigurationStore,
    private readonly status: () => RuntimeStatus,
    private readonly onConfigurationSaved: () => Promise<void>,
    private readonly isEnabled: () => boolean,
    private readonly setEnabled: (enabled: boolean) => Promise<void>,
    private readonly onResolveConflict: (resolution: 'local' | 'cloud') => Promise<void>,
    private readonly history: HistoryHandlers,
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
          await this.setEnabled(message.enabled);
          await this.pushState();
        } else if (message.type === 'resolveConflict') {
          await this.onResolveConflict(message.resolution);
          await this.pushState();
        } else if (message.type === 'setMode') {
          await this.applyMode(message.mode);
          await this.pushState();
        } else if (message.type === 'loadHistory') {
          await this.history.load(message.limit, message.refresh);
        } else if (message.type === 'restoreCommit') {
          await this.history.restore(message.hash);
        } else if (message.type === 'createTag') {
          await this.history.createTag(message.hash);
        } else if (message.type === 'deleteTag') {
          await this.history.deleteTag(message.hash, message.tag);
        } else if (message.type === 'save') {
          if (hasEmbeddedCredentials(message.configuration.repositoryUrl)) {
            void vscode.window.showErrorMessage('配置同步仓库地址不能包含明文凭据，请使用 SSH 或系统凭据管理器。');
            return;
          }
          await this.configurationStore.save({
            ...this.configurationStore.get(),
            ...message.configuration,
            ...message.automation,
          });
          await this.onConfigurationSaved();
          await this.view?.webview.postMessage({ type: 'configuration-saved' });
          await this.pushState();
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        // 处理失败时必须回显并刷新，否则侧边栏会一直停在中间态。
        if (message.type === 'save') await this.view?.webview.postMessage({ type: 'save-failed' });
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
      await this.view?.webview.postMessage({ type: 'failure', message: this.failure });
      return;
    }
    if (!this.ready) return;
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
        // 判定放在这里：内联脚本只按结果显示或隐藏选择面板。
        needsChoice: status.sync.kind === 'blocked' && status.sync.reason === 'both-changed',
      }
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
    await this.view?.webview.postMessage({ type: 'history-close' });
  }

  public async postHistoryList(entries: HistoryEntry[], options: { refreshing: boolean; hasMore: boolean }): Promise<void> {
    await this.view?.webview.postMessage({ type: 'history-list', entries, ...options });
  }

  public async postHistoryError(message: string): Promise<void> {
    await this.view?.webview.postMessage({ type: 'history-error', message });
  }

  /** 还原与标签操作期间禁用页面按钮，避免同一条提交被连点两次。 */
  public async postHistoryBusy(busy: boolean): Promise<void> {
    await this.view?.webview.postMessage({ type: 'history-busy', busy });
  }

  private async showHistoryPage(): Promise<void> {
    await this.view?.webview.postMessage({ type: 'history-open', pageSize: HISTORY_PAGE_SIZE });
    await this.history.load(HISTORY_PAGE_SIZE, true);
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
.history-header{display:flex;align-items:center;gap:8px;margin-bottom:10px}.history-header strong{flex:1;min-width:0}
button.icon-button{margin:0;padding:3px 8px;background:transparent;color:var(--vscode-foreground);font-size:14px;line-height:1.2}button.icon-button:hover:enabled{background:var(--vscode-toolbar-hoverBackground)}
.history-list{margin:0;padding:0;list-style:none}
.history-item{display:flex;align-items:flex-start;gap:8px;padding:8px 0;border-bottom:1px solid var(--vscode-panel-border)}
.history-item>button{flex:none;margin:0;padding:4px 9px}
.history-main{flex:1;min-width:0}.history-subject{overflow-wrap:anywhere}.history-meta{margin-top:3px;opacity:.7;font-size:11px;overflow-wrap:anywhere}
.history-tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
.history-tag{padding:1px 7px;border-radius:9px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:11px;overflow-wrap:anywhere}
.history-loading{display:flex;justify-content:center;padding:28px 0}
.spinner{width:22px;height:22px;border:2px solid var(--vscode-panel-border);border-top-color:var(--vscode-progressBar-background);border-radius:50%;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.context-menu{position:fixed;z-index:10;min-width:130px;padding:4px 0;border:1px solid var(--vscode-editorWidget-border);background:var(--vscode-editorWidget-background);color:var(--vscode-editorWidget-foreground);box-shadow:0 2px 8px rgba(0,0,0,.35)}
.context-menu button{display:block;width:100%;margin:0;padding:5px 12px;background:transparent;color:inherit;text-align:left}
.context-menu button:hover:enabled{background:var(--vscode-list-hoverBackground)}
</style></head><body>
<div id="mainPage">
<div class="sync-summary">
  <div class="sync-metric"><span class="metric-label">同步状态</span><span class="metric-value"><span id="syncDot" class="dot"></span><span id="syncPhase">正在加载</span></span></div>
  <div class="sync-metric"><span class="metric-label">上次同步</span><span id="lastSyncAt" class="metric-value">尚未同步</span></div>
  <div class="sync-metric"><span class="metric-label">运行模式</span><span id="syncMode" class="metric-value">正在加载</span></div>
</div>
<div class="status"><strong id="phase">正在加载</strong><div id="detail" class="muted"></div></div>
<div id="choicePanel" class="status" hidden><strong>需要选择以哪一方为准</strong><div class="muted">本机与云端都有改动。选定一方后，另一份配置会先备份到扩展运行目录。</div><div><button id="chooseLocal" type="button">以本机为准</button><button id="chooseCloud" class="secondary" type="button">以云端为准</button></div></div>
<div class="toggle-row"><span>同步开关</span><button id="toggleEnabled" class="toggle-switch" type="button" role="switch" aria-checked="false" aria-label="正在加载"></button></div>
<p class="muted">关闭后不创建本地仓库、不访问远程仓库，也不写回本机配置。</p>
<div class="mode-switch" role="group" aria-label="运行模式"><button id="modeBackup" type="button" data-mode="backup" aria-pressed="false">备份模式</button><button id="modeSync" type="button" data-mode="sync" aria-pressed="false">同步模式</button></div>
<p id="modeNote" class="muted"></p>
<div class="repository-details"><div class="repository-item"><span>远程仓库</span><strong id="repositorySummary">正在加载</strong></div><div class="repository-item"><span>分支</span><strong id="branchSummary">正在加载</strong></div></div>
<button id="editRepository" type="button">修改远程仓库</button>
<dialog id="configurationDialog" class="configuration-dialog"><form id="configurationForm" novalidate><h2>配置同步仓库</h2><label for="repositoryUrl">配置同步仓库地址</label><input id="repositoryUrl" placeholder="git@github.com:user/settings.git"><label for="branch">分支</label><input id="branch"><div class="row"><div><label for="gitUserName">Git 用户名（可选）</label><input id="gitUserName" placeholder="留空使用本机配置"></div><div><label for="gitUserEmail">Git 邮箱（可选）</label><input id="gitUserEmail" type="email" placeholder="留空使用本机配置"></div></div><div class="row"><div><label for="debounceSeconds">本地检测间隔（秒）</label><input id="debounceSeconds" type="number" min="5" step="5"></div><div><label for="pollIntervalSeconds">远程轮询间隔（秒）</label><input id="pollIntervalSeconds" type="number" min="30" step="30"></div></div><p class="muted">保存后会自动同步。同步模式下首次接入会以云端配置覆盖本机，原有配置会先备份；备份模式只把本机配置上传到仓库。</p><div class="dialog-actions"><button id="cancelConfiguration" class="secondary" type="button">取消</button><button id="saveConfiguration" type="submit">保存更改</button></div></form></dialog>
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
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();const ids=['repositoryUrl','branch','gitUserName','gitUserEmail'];const toggleEnabled=document.getElementById('toggleEnabled');const editRepository=document.getElementById('editRepository');const configurationDialog=document.getElementById('configurationDialog');const configurationForm=document.getElementById('configurationForm');const cancelConfiguration=document.getElementById('cancelConfiguration');const saveConfiguration=document.getElementById('saveConfiguration');const modeButtons=[document.getElementById('modeBackup'),document.getElementById('modeSync')];const choicePanel=document.getElementById('choicePanel');const chooseLocal=document.getElementById('chooseLocal');const chooseCloud=document.getElementById('chooseCloud');let configuration={};let enabled=false;let lastSyncAt;
const mainPage=document.getElementById('mainPage');const historyPage=document.getElementById('historyPage');const historyBody=document.getElementById('historyBody');const historyError=document.getElementById('historyError');const historyRefreshing=document.getElementById('historyRefreshing');const historyMore=document.getElementById('historyMore');const historyBack=document.getElementById('historyBack');const historyRefresh=document.getElementById('historyRefresh');const tagMenu=document.getElementById('tagMenu');let historyPageSize=30;let historyLimit=30;let historyBusy=false;
historyBack.onclick=()=>showHistoryPage(false);
historyRefresh.onclick=()=>requestHistory(historyLimit,true);
historyMore.onclick=()=>requestHistory(historyLimit+historyPageSize,false);
addEventListener('click',closeTagMenu);
addEventListener('keydown',(event)=>{if(event.key==='Escape')closeTagMenu()});
addEventListener('scroll',closeTagMenu,true);
chooseLocal.onclick=()=>{chooseLocal.disabled=true;chooseCloud.disabled=true;vscode.postMessage({type:'resolveConflict',resolution:'local'})};
chooseCloud.onclick=()=>{chooseLocal.disabled=true;chooseCloud.disabled=true;vscode.postMessage({type:'resolveConflict',resolution:'cloud'})};
toggleEnabled.onclick=()=>{toggleEnabled.disabled=true;vscode.postMessage({type:'toggleEnabled',enabled:!enabled})};
for(const button of modeButtons)button.onclick=()=>{for(const other of modeButtons)other.disabled=true;vscode.postMessage({type:'setMode',mode:button.dataset.mode})};
editRepository.onclick=()=>{for(const id of ids)document.getElementById(id).value=configuration[id]??'';document.getElementById('debounceSeconds').value=String(configuration.debounceSeconds??'');document.getElementById('pollIntervalSeconds').value=String(configuration.pollIntervalSeconds??'');configurationDialog.showModal()};
cancelConfiguration.onclick=()=>configurationDialog.close();
configurationForm.onsubmit=(event)=>{event.preventDefault();const next={};for(const id of ids)next[id]=document.getElementById(id).value;const automation={debounceSeconds:Number(document.getElementById('debounceSeconds').value),pollIntervalSeconds:Number(document.getElementById('pollIntervalSeconds').value)};saveConfiguration.disabled=true;cancelConfiguration.disabled=true;vscode.postMessage({type:'save',configuration:next,automation})};
addEventListener('message',({data})=>{if(data.type==='failure'){document.getElementById('phase').textContent='启动失败';document.getElementById('detail').textContent=data.message;document.getElementById('syncPhase').textContent='启动失败';document.getElementById('syncDot').className='dot error';document.getElementById('lastSyncAt').textContent='—';document.getElementById('syncMode').textContent='—';return}if(data.type==='configuration-saved'){saveConfiguration.disabled=false;cancelConfiguration.disabled=false;configurationDialog.close();return}if(data.type==='save-failed'){saveConfiguration.disabled=false;cancelConfiguration.disabled=false;return}
if(data.type==='history-open'){historyPageSize=data.pageSize;historyLimit=data.pageSize;showHistoryPage(true);renderHistoryLoading();return}
if(data.type==='history-close'){showHistoryPage(false);return}
if(data.type==='history-list'){renderHistory(data.entries,data.hasMore===true,data.refreshing===true);return}
if(data.type==='history-error'){renderHistoryError(data.message);return}
if(data.type==='history-busy'){applyHistoryBusy(data.busy===true);return}
if(data.type!=='state')return;configuration=data.configuration;enabled=data.enabled===true;toggleEnabled.className=enabled?'toggle-switch enabled':'toggle-switch';toggleEnabled.setAttribute('aria-checked',String(enabled));toggleEnabled.setAttribute('aria-label',enabled?'停止同步':'开启同步');toggleEnabled.disabled=false;document.getElementById('repositorySummary').textContent=configuration.repositoryUrl||'未配置远程仓库';document.getElementById('branchSummary').textContent=configuration.branch||'未配置分支';for(const button of modeButtons){const active=button.dataset.mode===configuration.mode;button.className=active?'active':'';button.setAttribute('aria-pressed',String(active));button.disabled=false}document.getElementById('syncMode').textContent=data.modeLabel;document.getElementById('modeNote').textContent=data.modeNote;const s=data.status;document.getElementById('phase').textContent=s.displayPhase+' · '+s.role;const notes=['窗口 '+s.activeWindows,'Profiles '+s.profiles.join('、')];if(s.stage)notes.push(s.stage);if(s.message)notes.push(s.message);document.getElementById('detail').textContent=notes.join(' · ');document.getElementById('syncPhase').textContent=s.displayPhase;document.getElementById('syncDot').className='dot '+s.tone;choicePanel.hidden=s.needsChoice!==true;chooseLocal.disabled=false;chooseCloud.disabled=false;lastSyncAt=s.lastSyncAt;renderLastSyncAt()});
vscode.postMessage({type:'ready'});
setInterval(renderLastSyncAt,60_000);
function renderLastSyncAt(){const last=document.getElementById('lastSyncAt');if(!lastSyncAt){last.textContent='尚未同步';last.removeAttribute('title');return}const date=new Date(lastSyncAt);if(Number.isNaN(date.getTime())){last.textContent='时间无效';last.removeAttribute('title');return}last.textContent=date.toLocaleString()+'（'+relativeTime(date.getTime())+'）';last.title=lastSyncAt}
function relativeTime(timestamp){const elapsed=Math.max(0,Date.now()-timestamp);if(elapsed<60_000)return'刚刚';if(elapsed<3_600_000)return Math.floor(elapsed/60_000)+'分钟前';if(elapsed<86_400_000)return Math.floor(elapsed/3_600_000)+'小时前';return Math.floor(elapsed/86_400_000)+'天前'}
function showHistoryPage(open){mainPage.hidden=open;historyPage.hidden=!open;closeTagMenu()}
function requestHistory(limit,refresh){if(historyBusy)return;historyLimit=limit;vscode.postMessage({type:'loadHistory',limit,refresh})}
function renderHistoryLoading(){historyError.hidden=true;historyRefreshing.hidden=true;historyMore.hidden=true;const box=document.createElement('div');box.className='history-loading';const spinner=document.createElement('div');spinner.className='spinner';box.append(spinner);historyBody.replaceChildren(box)}
function renderHistoryError(message){historyError.textContent=message;historyError.hidden=false;historyRefreshing.hidden=true;if(!historyBody.querySelector('.history-list'))historyBody.replaceChildren()}
function renderHistory(entries,hasMore,refreshing){historyError.hidden=true;historyRefreshing.hidden=!refreshing;if(!entries.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='云端还没有本宿主的配置提交。';historyBody.replaceChildren(empty);historyMore.hidden=true;return}const list=document.createElement('ul');list.className='history-list';for(const entry of entries)list.append(historyItem(entry));historyBody.replaceChildren(list);historyMore.hidden=!hasMore;applyHistoryBusy(historyBusy)}
function historyItem(entry){const item=document.createElement('li');item.className='history-item';const main=document.createElement('div');main.className='history-main';const subject=document.createElement('div');subject.className='history-subject';subject.textContent=entry.subject;const meta=document.createElement('div');meta.className='history-meta';meta.textContent=entry.shortHash+' · '+historyTime(entry.committedAt);main.append(subject,meta);if(entry.tags.length){const tags=document.createElement('div');tags.className='history-tags';for(const tag of entry.tags){const badge=document.createElement('span');badge.className='history-tag';badge.textContent=tag;tags.append(badge)}main.append(tags)}const rollback=document.createElement('button');rollback.type='button';rollback.textContent='回滚';rollback.onclick=()=>{if(historyBusy)return;vscode.postMessage({type:'restoreCommit',hash:entry.hash})};item.append(main,rollback);item.oncontextmenu=(event)=>{event.preventDefault();openTagMenu(event,entry)};return item}
function historyTime(value){const date=new Date(value);if(Number.isNaN(date.getTime()))return'时间无效';return date.toLocaleString()+'（'+relativeTime(date.getTime())+'）'}
function openTagMenu(event,entry){if(historyBusy)return;tagMenu.replaceChildren(menuItem('新增标签…',()=>vscode.postMessage({type:'createTag',hash:entry.hash})));for(const tag of entry.tags)tagMenu.append(menuItem('删除标签 '+tag,()=>vscode.postMessage({type:'deleteTag',hash:entry.hash,tag})));tagMenu.hidden=false;tagMenu.style.left=Math.max(0,Math.min(event.clientX,innerWidth-tagMenu.offsetWidth-4))+'px';tagMenu.style.top=Math.max(0,Math.min(event.clientY,innerHeight-tagMenu.offsetHeight-4))+'px'}
function menuItem(label,run){const button=document.createElement('button');button.type='button';button.textContent=label;button.onclick=()=>{closeTagMenu();if(!historyBusy)run()};return button}
function closeTagMenu(){tagMenu.hidden=true;tagMenu.replaceChildren()}
function applyHistoryBusy(busy){historyBusy=busy;historyRefresh.disabled=busy;historyMore.disabled=busy;for(const button of historyBody.querySelectorAll('button'))button.disabled=busy}
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
  if (value.type === 'resolveConflict') {
    return value.resolution === 'local' || value.resolution === 'cloud'
      ? { type: 'resolveConflict', resolution: value.resolution }
      : undefined;
  }
  if (value.type === 'loadHistory') {
    const limit = value.limit;
    const valid = typeof limit === 'number' && Number.isInteger(limit)
      && limit >= HISTORY_PAGE_SIZE && limit <= MAX_COMMIT_LIST
      && typeof value.refresh === 'boolean';
    return valid ? { type: 'loadHistory', limit: limit as number, refresh: value.refresh as boolean } : undefined;
  }
  if (value.type === 'restoreCommit' || value.type === 'createTag' || value.type === 'deleteTag') {
    if (typeof value.hash !== 'string' || !/^[0-9a-f]{40}$/.test(value.hash)) return undefined;
    if (value.type === 'restoreCommit') return { type: 'restoreCommit', hash: value.hash };
    if (value.type === 'createTag') return { type: 'createTag', hash: value.hash };
    if (typeof value.tag !== 'string' || !isValidTagName(value.tag)) return undefined;
    return { type: 'deleteTag', hash: value.hash, tag: value.tag };
  }
  if (value.type !== 'save' || !value.configuration || typeof value.configuration !== 'object' || !value.automation || typeof value.automation !== 'object') return undefined;
  const configuration = value.configuration as Record<string, unknown>;
  const strings = ['repositoryUrl', 'branch', 'gitUserName', 'gitUserEmail'];
  if (!strings.every((key) => typeof configuration[key] === 'string')) return undefined;
  if (/\r|\n/.test(configuration.repositoryUrl as string) || !isValidBranch(configuration.branch as string)) return undefined;
  const automation = value.automation as Record<string, unknown>;
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
