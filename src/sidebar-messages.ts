import { isValidBranch, isValidTagName } from './configuration-record';
import type { DisplayPhase, DisplayTone } from './sidebar-status';
import { PluginConfiguration, RuntimeStatus, SyncConfiguration, SyncMode } from './types';

/** 历史页面每次向扩展索要的条数，「加载更多」在此基础上累加，翻页次数不封顶。 */
export const HISTORY_PAGE_SIZE = 30;
// 翻页不设固定条数上限，但单次请求必须有上限：这一段跨信任边界，畸形消息传入超大数字会让 git log 遍历整个历史。
export const HISTORY_LIMIT_MAX = 10_000;

export interface AutomationSettings {
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

/** Webview 发给扩展的消息；跨信任边界，一律经 parseMessage 校验后使用。 */
export type IncomingMessage =
  | { type: 'ready' }
  | { type: 'save'; configuration: SyncConfiguration; automation: AutomationSettings }
  | { type: 'toggleEnabled'; enabled: boolean }
  | { type: 'setMode'; mode: SyncMode }
  | { type: 'resolveConflict'; resolution: 'local' | 'cloud' }
  /** 确认对当前 Profile 差异的处理；处理哪一组由扩展按共享状态决定，消息本身不带参数。 */
  | { type: 'resolveProfiles' }
  | { type: 'loadHistory'; limit: number; refresh: boolean }
  | { type: 'loadMoreHistory' }
  | { type: 'restoreCommit'; hash: string }
  | { type: 'createTag'; hash: string }
  | { type: 'deleteTag'; hash: string; tag: string };

/** 状态判定全部在扩展这边完成，Webview 只按这些派生字段渲染。 */
export interface DisplayStatus extends RuntimeStatus {
  displayPhase: DisplayPhase;
  tone: DisplayTone;
  stage?: string;
  needsChoice: boolean;
  /** Profile 不一致时的处理面板文案；无需处理时缺省。 */
  profileChoice?: { summary: string; detail: string; action: string };
}

/** 扩展发给 Webview 的消息。 */
export type OutgoingMessage =
  | { type: 'state'; configuration: PluginConfiguration; enabled: boolean; modeLabel: string; modeNote: string; status: DisplayStatus }
  | { type: 'failure'; message: string }
  | { type: 'configuration-saved' }
  | { type: 'save-failed' }
  | { type: 'history-open'; pageSize: number; limitMax: number }
  | { type: 'history-close' }
  /** append 为真时 entries 只是新增的一页，Webview 需要追加渲染而不是整份替换。 */
  | { type: 'history-list'; entries: HistoryEntry[]; refreshing: boolean; hasMore: boolean; append: boolean }
  | { type: 'history-error'; message: string }
  | { type: 'history-busy'; busy: boolean };

export function parseMessage(raw: unknown): IncomingMessage | undefined {
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
  if (value.type === 'resolveProfiles') return { type: 'resolveProfiles' };
  if (value.type === 'loadHistory') {
    const limit = value.limit;
    // 翻页靠 loadMoreHistory 累加，单次请求仍收在 HISTORY_LIMIT_MAX 内，同时挡掉 Infinity / NaN。
    const valid = typeof limit === 'number' && Number.isSafeInteger(limit)
      && limit >= HISTORY_PAGE_SIZE && limit <= HISTORY_LIMIT_MAX
      && typeof value.refresh === 'boolean';
    return valid ? { type: 'loadHistory', limit: limit as number, refresh: value.refresh as boolean } : undefined;
  }
  if (value.type === 'loadMoreHistory') return { type: 'loadMoreHistory' };
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
  // 只取已知字段：整个对象原样放行的话，消息里多带一个 mode 就会随保存生效，绕过切换同步模式的确认。
  return {
    type: 'save',
    configuration: {
      repositoryUrl: configuration.repositoryUrl as string,
      branch: configuration.branch as string,
      gitUserName: configuration.gitUserName as string,
      gitUserEmail: configuration.gitUserEmail as string,
    },
    automation: {
      debounceSeconds: automation.debounceSeconds,
      pollIntervalSeconds: automation.pollIntervalSeconds,
    },
  };
}

function validInterval(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= 86_400;
}
