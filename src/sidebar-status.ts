import { BlockReason, LinkState, ProfileMismatch, StageName, SyncMode, SyncState } from './types';

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
    case 'export-history': return '正在导出历史配置';
  }
}

export function modeLabel(mode: SyncMode): string {
  return mode === 'sync' ? '同步模式' : '备份模式';
}

export function modeNote(mode: SyncMode): string {
  return mode === 'sync'
    ? '同步模式会把仓库内容写回本机并按云端清单装卸扩展；不会新建或删除 Profile。与 IDE 内置 Settings Sync 同时开启时，两者可能互相覆盖。'
    : '备份模式只把本机配置提交到仓库，不会写回本机，适合已经开启 IDE 内置 Settings Sync 的宿主。';
}

export function blockReasonLabel(reason: BlockReason): string {
  switch (reason) {
    case 'dirty-windows': return '有窗口存在未保存的配置文件，保存后会自动继续。';
    case 'unreadable-windows': return '有窗口状态无法确认，已暂停同步。';
    case 'profiles-mismatch': return '本机与云端的 Profile 不一致，已暂停同步，请处理后继续。';
    case 'unrelated': return '本地配置同步仓库与远端仓库不同源，已停止同步，避免覆盖云端配置。';
    case 'both-changed': return '本机与云端都有改动，已暂停同步，请选择以哪一方为准。';
    case 'local-changed': return '同步期间本机配置发生了变化，本轮未写回，稍后会重新开始一轮。';
    case 'exclusive-lock': return '另一窗口正在执行同步，稍后将自动重试。';
  }
}

/** Profile 差异的提示文案：summary 用于状态说明，detail 说明两种处理方式，action 是需要用户确认的那一种。 */
export function profileMismatchText(mismatch: ProfileMismatch): { summary: string; detail: string; action: string } {
  const names = mismatch.names.join('、');
  if (mismatch.kind === 'cloud-only') {
    return {
      summary: `云端有本机没有的 Profile：${names}，已暂停同步。`,
      detail: '插件不会自动新建 Profile。在本机新建同名 Profile 后会自动套用云端配置并继续同步；'
        + '也可以从云端删除这些 Profile，其他机器上的同名 Profile 不受影响，历史提交中仍可找回。不处理则一直暂停。',
      action: '从云端删除',
    };
  }
  return {
    summary: `本机的 Profile 已在云端被删除：${names}，已暂停同步。`,
    detail: '插件不会删除本机 Profile。如果不再需要，请在本机手动删除这些 Profile，删除后会自动继续同步；'
      + '也可以选择保留，保留的 Profile 会随本机下次改动重新上传到云端。不处理则一直暂停。',
    action: '保留本机 Profile',
  };
}
