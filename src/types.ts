export type HostKind = 'vscode' | 'cursor';

/** 同步流程内部的步骤，只用于进度展示，不参与任何判定。 */
export type StageName =
  | 'snapshot'
  | 'scan-secrets'
  | 'prepare'
  | 'pull'
  | 'decide'
  | 'merge'
  | 'ai'
  | 'push'
  | 'apply'
  | 'extensions';

/** 同步暂停的原因，决定了何时可以自动恢复。 */
export type BlockReason =
  | 'dirty-windows'
  | 'unreadable-windows'
  | 'other-windows'
  | 'unrelated'
  | 'exclusive-lock';

/**
 * 本机仓库与远端的关系，是同步流程的输出。
 * 改变仓库的动作自身产出新值，因此不需要探测磁盘，也不会与磁盘事实脱钩。
 */
export type LinkState =
  | 'no-repository'
  | 'never-synced'
  | 'in-sync'
  | 'diverged'
  | 'unrelated';

/** 扩展当前在做什么。与 LinkState 正交，两者共同决定对外显示的状态。 */
export type SyncState =
  | { kind: 'disabled' }
  | { kind: 'unconfigured' }
  | { kind: 'idle' }
  | { kind: 'running'; stage: StageName }
  | { kind: 'blocked'; reason: BlockReason }
  | { kind: 'failed' };

/** 一轮同步的结果报告；状态由调度层据此决定，流程本身不写链路状态。 */
export interface SyncOutcome {
  ok: boolean;
  retry?: boolean;
  unrelated?: boolean;
  blockReason?: BlockReason;
  /** Profile 增删因窗口数未满足而搁置，同步本身已完成。 */
  waitingForWindows?: boolean;
  extensionsPending?: string[];
  structuralApplied?: boolean;
}

/** 一轮自动合并的结果，仅用于状态提示，不参与后续判定。 */
export interface MergeReport {
  conflicts: string[];
  aiMerged: string[];
  autoMerged: string[];
  aiError?: string;
}

/** 整轮同步累积的观察结果，只用于生成最终文案与返回值。 */
export interface SyncReport {
  usedAiFallback: boolean;
  recoveredPendingChanges: boolean;
  recoveredFromDivergence: boolean;
  adoptedCloud: boolean;
  changedFileCount: number;
  /** Profile 增删需要单窗口才能应用；未应用时同步仍算完成，但要提示用户关闭其他窗口。 */
  waitingForWindows: boolean;
  structuralApplied: boolean;
  activeWindows?: number;
  structuralMessage?: string;
  extensionsPending?: string[];
  merge?: MergeReport;
}

export function createSyncReport(): SyncReport {
  return {
    usedAiFallback: false,
    recoveredPendingChanges: false,
    recoveredFromDivergence: false,
    adoptedCloud: false,
    changedFileCount: 0,
    waitingForWindows: false,
    structuralApplied: false,
  };
}

export interface SyncConfiguration {
  repositoryUrl: string;
  branch: string;
  gitUserName: string;
  gitUserEmail: string;
}

export interface PluginConfiguration extends SyncConfiguration {
  pollIntervalSeconds: number;
  debounceSeconds: number;
  includeProfileAssociations: boolean;
}

export interface RuntimeStatus {
  sync: SyncState;
  link: LinkState;
  role: 'leader' | 'follower' | 'stopped';
  activeWindows: number;
  profiles: string[];
  pendingChanges: number;
  lastSyncAt?: string;
  message?: string;
  leaderId?: string;
}

export interface ProfileDescriptor {
  id: string;
  name: string;
  location: string;
  isDefault: boolean;
}

export interface SnapshotManifest {
  schemaVersion: 1;
  host: HostKind;
  createdAt: string;
  profiles: Array<Pick<ProfileDescriptor, 'id' | 'name' | 'isDefault'>>;
  profileMetadata?: Array<Record<string, unknown>>;
  profileAssociations?: unknown;
  files: Record<string, string>;
}

export const DEFAULT_CONFIGURATION: PluginConfiguration = {
  repositoryUrl: '',
  branch: 'main',
  gitUserName: '',
  gitUserEmail: '',
  pollIntervalSeconds: 300,
  debounceSeconds: 10,
  includeProfileAssociations: true,
};
