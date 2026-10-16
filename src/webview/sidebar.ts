import type { DisplayStatus, HistoryEntry, IncomingMessage, OutgoingMessage } from '../sidebar-messages';
import type { PluginConfiguration, SyncConfiguration, SyncMode } from '../types';

// 侧边栏 Webview 的脚本：只按扩展发来的结果渲染并转发用户操作，任何业务判定都不放在这里。
// 外部文本一律经 textContent / createElement 进入页面，不使用 innerHTML。

declare function acquireVsCodeApi(): { postMessage(message: IncomingMessage): void };

const vscode = acquireVsCodeApi();
const CONFIGURATION_FIELDS = ['repositoryUrl', 'branch', 'gitUserName', 'gitUserEmail'] as const;

const toggleEnabled = element<HTMLButtonElement>('toggleEnabled');
const editRepository = element<HTMLButtonElement>('editRepository');
const configurationDialog = element<HTMLDialogElement>('configurationDialog');
const configurationForm = element<HTMLFormElement>('configurationForm');
const cancelConfiguration = element<HTMLButtonElement>('cancelConfiguration');
const saveConfiguration = element<HTMLButtonElement>('saveConfiguration');
const modeButtons = [element<HTMLButtonElement>('modeBackup'), element<HTMLButtonElement>('modeSync')];
const choicePanel = element('choicePanel');
const chooseLocal = element<HTMLButtonElement>('chooseLocal');
const chooseCloud = element<HTMLButtonElement>('chooseCloud');
const profilePanel = element('profilePanel');
const resolveProfiles = element<HTMLButtonElement>('resolveProfiles');
const mainPage = element('mainPage');
const historyPage = element('historyPage');
const historyBody = element('historyBody');
const historyError = element('historyError');
const historyRefreshing = element('historyRefreshing');
const historyMore = element<HTMLButtonElement>('historyMore');
const historyBack = element<HTMLButtonElement>('historyBack');
const historyRefresh = element<HTMLButtonElement>('historyRefresh');
const openRepository = element<HTMLButtonElement>('openRepository');
const syncMark = element('syncMark');
const syncResult = element('syncResult');
const tagMenu = element('tagMenu');

let configuration: Partial<PluginConfiguration> = {};
let enabled = false;
let lastSyncAt: string | undefined;
let historyLimit = 30;
let historyPageSize = 30;
let historyLimitMax = 10_000;
let historyBusy = false;
/** 用户点了刷新，要等这次整份加载给出列表或错误后才收起按钮动画。 */
let historyRefreshPending = false;
/** 「已刷新」展示期间，后续的非刷新渲染不要把它提前藏掉。 */
let historyRefreshHold = false;
let historyRefreshResultTimer: number | undefined;

historyBack.onclick = () => showHistoryPage(false);
historyRefresh.onclick = () => requestHistory(historyLimit, true);
openRepository.onclick = () => vscode.postMessage({ type: 'openRepository' });
historyMore.onclick = () => {
  if (historyBusy) return;
  historyMore.disabled = true;
  vscode.postMessage({ type: 'loadMoreHistory' });
};
addEventListener('click', closeTagMenu);
addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeTagMenu();
});
addEventListener('scroll', closeTagMenu, true);

chooseLocal.onclick = () => resolveConflict('local');
chooseCloud.onclick = () => resolveConflict('cloud');
resolveProfiles.onclick = () => {
  resolveProfiles.disabled = true;
  vscode.postMessage({ type: 'resolveProfiles' });
};
toggleEnabled.onclick = () => {
  toggleEnabled.disabled = true;
  vscode.postMessage({ type: 'toggleEnabled', enabled: !enabled });
};
input('debounceSeconds').addEventListener('change', () => commitInterval('debounceSeconds', 5));
input('pollIntervalSeconds').addEventListener('change', () => commitInterval('pollIntervalSeconds', 30));
for (const button of modeButtons) {
  button.onclick = () => {
    for (const other of modeButtons) other.disabled = true;
    vscode.postMessage({ type: 'setMode', mode: button.dataset.mode as SyncMode });
  };
}

editRepository.onclick = () => {
  for (const id of CONFIGURATION_FIELDS) input(id).value = configuration[id] ?? '';
  configurationDialog.showModal();
};
cancelConfiguration.onclick = () => configurationDialog.close();
configurationForm.onsubmit = (event) => {
  event.preventDefault();
  if (configuration.debounceSeconds === undefined || configuration.pollIntervalSeconds === undefined) return;
  const next: SyncConfiguration = { repositoryUrl: '', branch: '', gitUserName: '', gitUserEmail: '' };
  for (const id of CONFIGURATION_FIELDS) next[id] = input(id).value;
  const automation = {
    debounceSeconds: configuration.debounceSeconds,
    pollIntervalSeconds: configuration.pollIntervalSeconds,
  };
  saveConfiguration.disabled = true;
  cancelConfiguration.disabled = true;
  vscode.postMessage({ type: 'save', configuration: next, automation });
};

addEventListener('message', ({ data }: MessageEvent<OutgoingMessage>) => {
  switch (data.type) {
    case 'failure':
      setText('phase', '启动失败');
      setText('detail', data.message);
      setText('syncPhase', '启动失败');
      element('syncDot').hidden = false;
      element('syncDot').className = 'dot error';
      syncMark.hidden = true;
      syncResult.hidden = true;
      syncResult.textContent = '';
      syncResult.removeAttribute('title');
      setText('lastSyncAt', '—');
      setText('syncMode', '—');
      return;
    case 'configuration-saved':
      saveConfiguration.disabled = false;
      cancelConfiguration.disabled = false;
      configurationDialog.close();
      return;
    case 'save-failed':
      saveConfiguration.disabled = false;
      cancelConfiguration.disabled = false;
      return;
    case 'history-open':
      historyPageSize = data.pageSize;
      historyLimit = data.pageSize;
      historyLimitMax = data.limitMax;
      showHistoryPage(true);
      renderHistoryLoading();
      return;
    case 'history-close':
      showHistoryPage(false);
      return;
    case 'history-list':
      renderHistory(data.entries, data.hasMore, data.refreshing, data.append);
      return;
    case 'history-error':
      renderHistoryError(data.message);
      return;
    case 'history-busy':
      applyHistoryBusy(data.busy);
      return;
    case 'state':
      configuration = data.configuration;
      enabled = data.enabled;
      renderState(data.modeLabel, data.modeNote, data.status);
      return;
  }
});

vscode.postMessage({ type: 'ready' });
setInterval(renderLastSyncAt, 60_000);

function renderState(modeLabel: string, modeNote: string, status: DisplayStatus): void {
  toggleEnabled.className = enabled ? 'toggle-switch enabled' : 'toggle-switch';
  toggleEnabled.setAttribute('aria-checked', String(enabled));
  toggleEnabled.setAttribute('aria-label', enabled ? '停止同步' : '开启同步');
  toggleEnabled.disabled = false;
  setText('repositorySummary', configuration.repositoryUrl || '未配置远程仓库');
  setText('branchSummary', configuration.branch || '未配置分支');
  for (const button of modeButtons) {
    const active = button.dataset.mode === configuration.mode;
    button.className = active ? 'active' : '';
    button.setAttribute('aria-pressed', String(active));
    button.disabled = false;
  }
  renderIntervals();
  setText('syncMode', modeLabel);
  setText('modeNote', modeNote);

  setText('phase', `${status.displayPhase} · ${status.role}`);
  const notes = [`窗口 ${status.activeWindows}`, `Profiles ${status.profiles.join('、')}`];
  if (status.stage) notes.push(status.stage);
  if (status.message) notes.push(status.message);
  setText('detail', notes.join(' · '));
  setText('syncPhase', status.stepText ?? status.displayPhase);
  element('syncDot').hidden = status.transferring === true;
  element('syncDot').className = `dot ${status.tone}`;
  syncMark.hidden = status.transferring !== true;
  syncResult.hidden = status.transferring === true || !status.transferResultText;
  syncResult.textContent = status.transferResultText ?? '';
  if (status.transferResultText) syncResult.title = status.transferResultText;
  else syncResult.removeAttribute('title');
  choicePanel.hidden = !status.needsChoice;
  chooseLocal.disabled = false;
  chooseCloud.disabled = false;
  profilePanel.hidden = !status.profileChoice;
  element('profileSummary').textContent = status.profileChoice?.summary ?? '';
  element('profileDetail').textContent = status.profileChoice?.detail ?? '';
  resolveProfiles.textContent = status.profileChoice?.action ?? '';
  resolveProfiles.disabled = false;
  lastSyncAt = status.lastSyncAt;
  renderLastSyncAt();
}

function setText(id: string, text: string): void {
  const node = element(id);
  node.textContent = text;
  if (text) node.title = text;
  else node.removeAttribute('title');
}

function renderIntervals(): void {
  setIntervalValue('debounceSeconds', configuration.debounceSeconds);
  setIntervalValue('pollIntervalSeconds', configuration.pollIntervalSeconds);
}

function setIntervalValue(id: 'debounceSeconds' | 'pollIntervalSeconds', value: number | undefined): void {
  const field = input(id);
  if (document.activeElement === field) return;
  field.value = value === undefined ? '' : String(value);
}

/** 数字输入在离开或点步进时才提交。不合法就恢复原值，避免把空串或小于下限的数写进设置。 */
function commitInterval(field: 'debounceSeconds' | 'pollIntervalSeconds', minimum: number): void {
  const fieldElement = input(field);
  const parsed = Number(fieldElement.value);
  const current = configuration[field];
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > 86_400) {
    fieldElement.value = current === undefined ? '' : String(current);
    return;
  }
  if (parsed === current) return;
  if (configuration.debounceSeconds === undefined || configuration.pollIntervalSeconds === undefined) return;
  vscode.postMessage({
    type: 'saveAutomation',
    automation: {
      debounceSeconds: configuration.debounceSeconds,
      pollIntervalSeconds: configuration.pollIntervalSeconds,
      [field]: parsed,
    },
  });
}

function resolveConflict(resolution: 'local' | 'cloud'): void {
  chooseLocal.disabled = true;
  chooseCloud.disabled = true;
  vscode.postMessage({ type: 'resolveConflict', resolution });
}

function renderLastSyncAt(): void {
  const last = element('lastSyncAt');
  if (!lastSyncAt) {
    last.textContent = '尚未同步';
    last.title = '尚未同步';
    return;
  }
  const date = new Date(lastSyncAt);
  if (Number.isNaN(date.getTime())) {
    last.textContent = '时间无效';
    last.title = '时间无效';
    return;
  }
  const text = `${date.toLocaleString()}（${relativeTime(date.getTime())}）`;
  last.textContent = text;
  last.title = text;
}

function relativeTime(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return '刚刚';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}小时前`;
  return `${Math.floor(elapsed / 86_400_000)}天前`;
}

function showHistoryPage(open: boolean): void {
  mainPage.hidden = open;
  historyPage.hidden = !open;
  closeTagMenu();
}

function requestHistory(limit: number, refresh: boolean): void {
  if (historyBusy || historyRefreshPending) return;
  // 渲染后 historyLimit 记的是已显示条数。不足一页时它会小于 pageSize，而扩展要求单次请求至少一页。
  historyLimit = Math.min(Math.max(limit, historyPageSize), historyLimitMax);
  if (refresh) startHistoryRefresh();
  vscode.postMessage({ type: 'loadHistory', limit: historyLimit, refresh });
}

function startHistoryRefresh(): void {
  historyRefreshPending = true;
  historyRefreshHold = false;
  window.clearTimeout(historyRefreshResultTimer);
  historyError.hidden = true;
  showHistoryStatus('正在刷新云端记录…');
  setHistoryRefreshSpin(true);
  applyHistoryBusy(historyBusy);
}

function showHistoryStatus(text: string): void {
  historyRefreshing.textContent = text;
  historyRefreshing.title = text;
  historyRefreshing.hidden = false;
}

function setHistoryRefreshSpin(spinning: boolean): void {
  historyRefresh.classList.toggle('refreshing', spinning);
  historyRefresh.setAttribute('aria-busy', String(spinning));
}

function finishHistoryRefresh(): void {
  historyRefreshPending = false;
  historyRefreshHold = true;
  setHistoryRefreshSpin(false);
  showHistoryStatus('已刷新');
  window.clearTimeout(historyRefreshResultTimer);
  historyRefreshResultTimer = window.setTimeout(() => {
    historyRefreshHold = false;
    historyRefreshing.hidden = true;
  }, 2000);
}

function clearHistoryRefresh(): void {
  historyRefreshPending = false;
  historyRefreshHold = false;
  window.clearTimeout(historyRefreshResultTimer);
  setHistoryRefreshSpin(false);
  historyRefreshing.hidden = true;
  applyHistoryBusy(historyBusy);
}

function renderHistoryLoading(): void {
  clearHistoryRefresh();
  historyError.hidden = true;
  historyMore.hidden = true;
  const box = document.createElement('div');
  box.className = 'history-loading';
  const spinner = document.createElement('div');
  spinner.className = 'spinner';
  box.append(spinner);
  historyBody.replaceChildren(box);
}

function renderHistoryError(message: string): void {
  clearHistoryRefresh();
  historyError.textContent = message;
  historyError.title = message;
  historyError.hidden = false;
  if (!historyBody.querySelector('.history-list')) historyBody.replaceChildren();
  applyHistoryBusy(historyBusy);
}

function renderHistory(entries: HistoryEntry[], hasMore: boolean, refreshing: boolean, append: boolean): void {
  historyError.hidden = true;
  if (refreshing) {
    window.clearTimeout(historyRefreshResultTimer);
    historyRefreshHold = false;
    showHistoryStatus('正在刷新云端记录…');
    setHistoryRefreshSpin(historyRefreshPending);
  } else if (historyRefreshPending && !append) {
    finishHistoryRefresh();
  } else if (!historyRefreshHold) {
    setHistoryRefreshSpin(historyRefreshPending);
    historyRefreshing.hidden = !historyRefreshPending;
  }
  const current = append ? historyBody.querySelector('.history-list') : null;
  if (current) {
    for (const entry of entries) current.append(historyItem(entry));
    historyLimit += entries.length;
  } else if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'muted history-footnote';
    empty.textContent = '云端还没有本宿主的配置提交。';
    empty.title = empty.textContent;
    historyBody.replaceChildren(empty);
    historyLimit = 0;
  } else {
    const list = document.createElement('ul');
    list.className = 'history-list';
    for (const entry of entries) list.append(historyItem(entry));
    historyBody.replaceChildren(list);
    historyLimit = entries.length;
  }
  historyMore.hidden = !hasMore;
  applyHistoryBusy(historyBusy);
}

function historyItem(entry: HistoryEntry): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'history-item';
  const main = document.createElement('div');
  main.className = 'history-main';
  const subject = document.createElement('div');
  subject.className = 'history-subject';
  subject.textContent = entry.subject;
  subject.title = entry.subject;
  const meta = document.createElement('div');
  meta.className = 'history-meta';
  const hash = document.createElement('span');
  hash.className = 'history-hash';
  hash.textContent = entry.shortHash;
  const time = document.createElement('span');
  time.className = 'history-time';
  const timeText = historyTime(entry.committedAt);
  time.textContent = timeText;
  time.title = timeText;
  meta.append(hash, time);
  main.append(subject, meta);
  if (entry.tags.length) {
    const tags = document.createElement('div');
    tags.className = 'history-tags';
    for (const tag of entry.tags) {
      const badge = document.createElement('span');
      badge.className = 'history-tag';
      badge.textContent = tag;
      badge.title = tag;
      tags.append(badge);
    }
    main.append(tags);
  }
  const rollback = document.createElement('button');
  rollback.type = 'button';
  rollback.textContent = '回滚';
  rollback.onclick = () => {
    if (historyBusy) return;
    vscode.postMessage({ type: 'restoreCommit', hash: entry.hash });
  };
  const view = document.createElement('button');
  view.type = 'button';
  view.className = 'secondary history-view';
  view.textContent = '查看';
  view.onclick = () => vscode.postMessage({ type: 'openCommit', hash: entry.hash });
  const actions = document.createElement('div');
  actions.className = 'history-actions';
  actions.append(rollback, view);
  item.append(main, actions);
  item.oncontextmenu = (event) => {
    event.preventDefault();
    openTagMenu(event, entry);
  };
  return item;
}

function historyTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间无效';
  return `${date.toLocaleString()}（${relativeTime(date.getTime())}）`;
}

function openTagMenu(event: MouseEvent, entry: HistoryEntry): void {
  if (historyBusy) return;
  tagMenu.replaceChildren(menuItem('新增标签…', () => vscode.postMessage({ type: 'createTag', hash: entry.hash })));
  for (const tag of entry.tags) {
    tagMenu.append(menuItem(`删除标签 ${tag}`, () => vscode.postMessage({ type: 'deleteTag', hash: entry.hash, tag })));
  }
  tagMenu.hidden = false;
  tagMenu.style.left = `${Math.max(0, Math.min(event.clientX, innerWidth - tagMenu.offsetWidth - 4))}px`;
  tagMenu.style.top = `${Math.max(0, Math.min(event.clientY, innerHeight - tagMenu.offsetHeight - 4))}px`;
}

function menuItem(label: string, run: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.onclick = () => {
    closeTagMenu();
    if (!historyBusy) run();
  };
  return button;
}

function closeTagMenu(): void {
  tagMenu.hidden = true;
  tagMenu.replaceChildren();
}

function applyHistoryBusy(busy: boolean): void {
  historyBusy = busy;
  historyRefresh.disabled = busy || historyRefreshPending;
  historyMore.disabled = busy;
  for (const button of historyBody.querySelectorAll('button')) button.disabled = busy;
}

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function input(id: string): HTMLInputElement {
  return element<HTMLInputElement>(id);
}
