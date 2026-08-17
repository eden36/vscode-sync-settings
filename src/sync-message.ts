import { SyncReport } from './types';

/** 把一轮同步的观察结果汇成一句状态说明；文案顺序固定，便于用户比对多次同步。 */
export function finalSyncMessage(report: SyncReport): string {
  const notes: string[] = [];
  const merge = report.merge;
  if (report.adoptedCloud) {
    notes.push('已按云端配置覆盖本机', '本机原配置已备份到扩展运行目录');
  }
  if (merge?.conflicts.length) {
    if (merge.aiMerged.length) notes.push(`AI 已自动合并 ${merge.aiMerged.length} 项冲突`);
    if (merge.autoMerged.length) notes.push(`${merge.autoMerged.length} 项冲突按本机优先自动处理`);
    notes.push('冲突前的两份配置已备份到扩展运行目录');
  }
  if (report.structuralMessage) {
    return `${[report.structuralMessage.replace(/。$/, ''), ...notes].join('；')}。`;
  }
  if (!report.changedFileCount && !notes.length) {
    if (report.recoveredFromDivergence) return '已重新对齐上次未推送成功的提交，配置已是最新。';
    return report.recoveredPendingChanges ? '已清理上次中断的暂存状态，配置已是最新。' : '配置已是最新。';
  }
  if (report.usedAiFallback) notes.push('AI 不可用或结果无效，已使用兜底策略');
  if (report.recoveredPendingChanges) notes.push('已清理上次中断的暂存状态');
  if (report.recoveredFromDivergence) notes.push('已重新对齐上次未推送成功的提交');
  if (report.extensionsPending?.length) {
    notes.push(`部分扩展尚未安装完成：${report.extensionsPending.join('、')}`);
  }
  const done = report.mode === 'backup' ? '备份完成' : '同步完成';
  return notes.length ? `${done}（${notes.join('；')}）。` : `${done}。`;
}
