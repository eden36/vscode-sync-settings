export type HostKind = 'vscode' | 'cursor';

/** 备份模式只把本机配置提交到仓库，同步模式才会把仓库内容写回本机。 */
export type SyncMode = 'backup' | 'sync';

/** 同步流程内部的步骤，只用于进度展示，不参与任何判定。 */
export type StageName =
  | 'snapshot'
  | 'scan-secrets'
  | 'prepare'
  | 'pull'
  | 'decide'
  | 'choose'
  | 'ai'
  | 'push'
  | 'apply'
  | 'extensions'
  | 'finalize'
  | 'export-history';

/** 同步暂停的原因，决定了何时可以自动恢复。 */
export type BlockReason =
  | 'dirty-windows'
  | 'unreadable-windows'
  | 'other-windows'
  | 'unrelated'
  | 'both-changed'
  | 'local-changed'
  | 'exclusive-lock';

/**
 * 本机仓库与远端的关系，是同步流程的输出。
 * 改变仓库的动作自身产出新值，因此不需要探测磁盘，也不会与磁盘事实脱钩。
 */
export type LinkState =
  | 'no-repository'
  | 'in-sync'
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
  /** 用户停止同步后，在当前安全操作结束时提前退出。 */
  cancelled?: boolean;
  retry?: boolean;
  unrelated?: boolean;
  blockReason?: BlockReason;
  /** Profile 增删因窗口数未满足而搁置，同步本身已完成。 */
  waitingForWindows?: boolean;
  extensionsPending?: string[];
  structuralApplied?: boolean;
  /** 本机与云端都相对基准有改动，必须由用户选定一方，重试无法解决。 */
  bothChanged?: boolean;
}

/** 本轮该采用哪一方的完整快照；不做内容合并，结果永远等于某一台机器的真实状态。 */
export type SnapshotChoice = 'none' | 'local' | 'cloud' | 'conflict';

/**
 * 上次整轮成功时两侧的状态，用于判断「本机改没改」与「云端改没改」。
 * 扩展清单单独记录：装卸需要时间，收敛过程中的中间态不能算作用户改动。
 */
export interface SyncBaseline {
  localSnapshot: string;
  localExtensions: string;
  cloudSnapshot: string;
  cloudExtensions: string;
}

/** 整轮同步累积的观察结果，只用于生成最终文案与返回值。 */
export interface SyncReport {
  mode: SyncMode;
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
  /** 本轮采用了哪一方；'none' 表示两侧都没有改动。 */
  snapshotChoice?: Exclude<SnapshotChoice, 'conflict'>;
  /** 本轮是按用户选定的一方执行的，文案要说明另一份已备份。 */
  resolvedConflict: boolean;
}

export function createSyncReport(mode: SyncMode): SyncReport {
  return {
    mode,
    usedAiFallback: false,
    recoveredPendingChanges: false,
    recoveredFromDivergence: false,
    adoptedCloud: false,
    changedFileCount: 0,
    waitingForWindows: false,
    structuralApplied: false,
    resolvedConflict: false,
  };
}

export interface SyncConfiguration {
  repositoryUrl: string;
  branch: string;
  gitUserName: string;
  gitUserEmail: string;
}

export interface PluginConfiguration extends SyncConfiguration {
  mode: SyncMode;
  pollIntervalSeconds: number;
  debounceSeconds: number;
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
  files: Record<string, string>;
}

export const DEFAULT_CONFIGURATION: PluginConfiguration = {
  repositoryUrl: '',
  branch: 'main',
  gitUserName: '',
  gitUserEmail: '',
  mode: 'backup',
  pollIntervalSeconds: 300,
  debounceSeconds: 10,
};
