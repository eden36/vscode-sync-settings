import { BlockReason, LinkState, StageName, SyncMode, SyncState } from './types';

export type DisplayPhase = '已关闭' | '未配置' | '未同步' | '同步中' | '已同步' | '同步失败' | '需要处理';
export type DisplayTone = 'success' | 'running' | 'warning' | 'error' | 'muted';

/** 对外只暴露这七个状态；内部的步骤和阻塞原因降级为详情文案。 */
export function displayPhase(sync: SyncState, link: LinkState): DisplayPhase {
  switch (sync.kind) {
    case 'disabled': return '已关闭';
    case 'unconfigured': return '未配置';
    case 'running': return '同步中';
    case 'blocked': return '需要处理';
    case 'failed': return '同步失败';
    case 'idle': return link === 'in-sync' ? '已同步' : '未同步';
  }
}

export function displayIcon(sync: SyncState, link: LinkState): string {
  switch (sync.kind) {
    case 'disabled': return '$(circle-slash)';
    case 'unconfigured': return '$(gear)';
    case 'running': return '$(sync~spin)';
    case 'blocked': return '$(question)';
    case 'failed': return '$(warning)';
    case 'idle': return link === 'in-sync' ? '$(check)' : '$(circle-outline)';
  }
}

/** 侧边栏圆点的配色，与状态栏图标同源，避免两处各自判断。 */
export function displayTone(sync: SyncState, link: LinkState): DisplayTone {
  switch (sync.kind) {
    case 'disabled': return 'muted';
    case 'unconfigured': return 'muted';
    case 'running': return 'running';
    case 'blocked': return 'warning';
    case 'failed': return 'error';
    case 'idle': return link === 'in-sync' ? 'success' : 'muted';
  }
}

export function stageLabel(stage: StageName): string {
  switch (stage) {
    case 'snapshot': return '正在扫描本机配置';
    case 'scan-secrets': return '正在检查凭据';
    case 'prepare': return '正在准备本地仓库';
    case 'pull': return '正在拉取远端配置';
    case 'decide': return '正在判定同步策略';
    case 'choose': return '正在对比两侧配置';
    case 'ai': return '正在等待 AI 处理';
    case 'push': return '正在提交并推送到远端';
    case 'apply': return '正在写回本机配置';
    case 'extensions': return '正在同步扩展';
    case 'finalize': return '正在记录同步基准';
  }
}

export function modeLabel(mode: SyncMode): string {
  return mode === 'sync' ? '同步模式' : '备份模式';
}

export function modeNote(mode: SyncMode): string {
  return mode === 'sync'
    ? '同步模式会把仓库内容写回本机；与 IDE 内置 Settings Sync 同时开启时，两者可能互相覆盖。'
    : '备份模式只把本机配置提交到仓库，不会写回本机，适合已经开启 IDE 内置 Settings Sync 的宿主。';
}

export function blockReasonLabel(reason: BlockReason): string {
  switch (reason) {
    case 'dirty-windows': return '有窗口存在未保存的配置文件，保存后会自动继续。';
    case 'unreadable-windows': return '有窗口状态无法确认，已暂停同步。';
    case 'other-windows': return 'Profile 增删需要在只剩一个窗口时应用，关闭其他窗口后会自动继续。';
    case 'unrelated': return '本地配置同步仓库与远端仓库不同源，已停止同步，避免覆盖云端配置。';
    case 'both-changed': return '本机与云端都有改动，已暂停同步，请选择以哪一方为准。';
    case 'local-changed': return '同步期间本机配置发生了变化，本轮未写回，稍后会重新开始一轮。';
    case 'exclusive-lock': return '另一窗口正在执行同步，稍后将自动重试。';
  }
}

export function formatRelativeSyncTime(value: string, now = Date.now()): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return '时间无效';
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return '刚刚';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}小时前`;
  return `${Math.floor(elapsed / 86_400_000)}天前`;
}
