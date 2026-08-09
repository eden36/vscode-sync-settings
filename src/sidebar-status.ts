import { SyncPhase } from './types';

export function displaySyncPhase(phase: SyncPhase, lastSyncAt: string | undefined): string {
  if (phase === '空闲') return lastSyncAt ? '已同步' : '未同步';
  return phase;
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
