import { SyncReport } from './types';

/** 把一轮同步的观察结果汇成一句状态说明；文案顺序固定，便于用户比对多次同步。 */
export function finalSyncMessage(report: SyncReport): string {
  const notes: string[] = [];
  if (report.adoptedCloud) {
    notes.push('已按云端配置覆盖本机', '本机原配置已备份到扩展运行目录');
  } else if (report.resolvedConflict) {
    notes.push(
      report.snapshotChoice === 'cloud' ? '已按你的选择用云端配置覆盖本机' : '已按你的选择用本机配置覆盖云端',
      '另一份配置已备份到扩展运行目录',
    );
  } else if (report.snapshotChoice === 'cloud') {
    notes.push('已按云端配置覆盖本机');
  }
  if (report.profileMessage) notes.push(report.profileMessage);
  if (report.extensionsDeferred) notes.push('当前窗口不在默认 Profile，扩展将在默认 Profile 的窗口中同步');
  if (report.extensionsInstalling?.length) notes.push(`已请求安装 ${report.extensionsInstalling.length} 个扩展，可在扩展面板查看进度`);
  if (report.extensionsUninstalling?.length) notes.push(`已请求卸载扩展：${report.extensionsUninstalling.join('、')}`);
  if (!report.changedFileCount && !notes.length && !report.extensionsFailed?.length) {
    if (report.recoveredFromDivergence) return '已重新对齐上次未推送成功的提交，配置已是最新。';
    return report.recoveredPendingChanges ? '已清理上次中断的暂存状态，配置已是最新。' : '配置已是最新。';
  }
  if (report.usedAiFallback) notes.push('AI 不可用或结果无效，已使用兜底策略');
  if (report.recoveredPendingChanges) notes.push('已清理上次中断的暂存状态');
  if (report.recoveredFromDivergence) notes.push('已重新对齐上次未推送成功的提交');
  if (report.extensionsFailed?.length) {
    notes.push(`部分扩展无法安装或卸载，已跳过：${report.extensionsFailed.join('、')}`);
  }
  const done = report.mode === 'backup' ? '备份完成' : '同步完成';
  return notes.length ? `${done}（${notes.join('；')}）。` : `${done}。`;
}
