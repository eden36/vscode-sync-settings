/**
 * 支持的宿主。每种宿主在仓库里各占一个目录，彼此不共享：
 * 扩展市场与扩展标识不同，混用同一份快照会互相覆盖并反复装卸扩展。
 */
export const HOST_KINDS = ['vscode', 'vscode-insiders', 'cursor', 'vscodium', 'windsurf'] as const;
export type HostKind = (typeof HOST_KINDS)[number];

export const HOST_LABELS: Record<HostKind, string> = {
  'vscode': 'VS Code',
  'vscode-insiders': 'VS Code Insiders',
  'cursor': 'Cursor',
  'vscodium': 'VSCodium',
  'windsurf': 'Windsurf',
};

/** 备份模式只把本机配置提交到仓库，同步模式才会把仓库内容写回本机。 */
export type SyncMode = 'backup' | 'sync';

// 以下三组取值同时用于类型与跨窗口共享文件的解析校验，必须由同一份数组派生：
// 分开手写时漏掉一项，其他窗口就会把带该取值的状态整份拒收。

/** 同步流程内部的步骤，只用于进度展示，不参与任何判定。 */
export const STAGE_NAMES = [
  'snapshot',
  'scan-secrets',
  'prepare',
  'pull',
  'decide',
  'choose',
  'ai',
  'push',
  'apply',
  'extensions',
  'finalize',
  'export-history',
  'override-cloud',
] as const;
export type StageName = (typeof STAGE_NAMES)[number];

/** 同步暂停的原因，决定了何时可以自动恢复。 */
export const BLOCK_REASONS = [
  'dirty-windows',
  'unreadable-windows',
  'profiles-mismatch',
  'unrelated',
  'both-changed',
  'local-changed',
  'exclusive-lock',
] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

/**
 * 本机仓库与远端的关系，是同步流程的输出。
 * 改变仓库的动作自身产出新值，因此不需要探测磁盘，也不会与磁盘事实脱钩。
 */
export const LINK_STATES = [
  'no-repository',
  'in-sync',
  'unrelated',
] as const;
export type LinkState = (typeof LINK_STATES)[number];

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
  /** 本轮实际处理过的本机指纹，检测器不能把轮后新改动标记为已同步。 */
  localFingerprint?: string;
  /** 用户停止同步后，在当前安全操作结束时提前退出。 */
  cancelled?: boolean;
  retry?: boolean;
  unrelated?: boolean;
  blockReason?: BlockReason;
  /** 本机与云端都相对基准有改动，必须由用户选定一方，重试无法解决。 */
  bothChanged?: boolean;
  /** 两侧 Profile 不一致且插件无法自行处理（不增删 Profile），必须由用户决定。 */
  profilesMismatch?: boolean;
}

/**
 * 两侧 Profile 不一致、需要用户处理的一组 Profile 名称。
 * cloud-only：云端有、本机没有，且不是本机删掉的；deleted-in-cloud：本机仍有、云端已删除。
 */
export interface ProfileMismatch {
  kind: 'cloud-only' | 'deleted-in-cloud';
  names: string[];
}

/** 本轮该采用哪一方的完整快照；不做内容合并，结果永远等于某一台机器的真实状态。 */
export type SnapshotChoice = 'none' | 'local' | 'cloud' | 'conflict';

/**
 * 上次整轮成功时两侧的状态，用于判断「本机改没改」与「云端改没改」。
 * 扩展清单不在其中：它按增删合并，依据是 RuntimeStateRecord.syncedExtensions。
 */
export interface SyncBaseline {
  localSnapshot: string;
  cloudSnapshot: string;
  /**
   * 两侧命名 Profile 的名称集合，用来区分「本机删了」与「云端新增」、「云端删了」与「本机新增」。
   * 旧版本写下的基准没有这两项，此时按无法区分处理。
   */
  localProfiles?: string[];
  cloudProfiles?: string[];
}

/** 上一轮真正把配置传出去之后的方向。空转检查没有这个结果。 */
export const TRANSFER_RESULTS = ['cloud', 'local', 'both'] as const;
export type TransferResult = (typeof TRANSFER_RESULTS)[number];

/** 整轮同步累积的观察结果，只用于生成最终文案与返回值。 */
export interface SyncReport {
  mode: SyncMode;
  usedAiFallback: boolean;
  recoveredPendingChanges: boolean;
  recoveredFromDivergence: boolean;
  adoptedCloud: boolean;
  changedFileCount: number;
  activeWindows?: number;
  /** 两侧 Profile 不一致但本轮可以继续时给用户的说明，例如云端有本机没有的 Profile。 */
  profileMessage?: string;
  /** 本轮已向 IDE 发出安装命令的扩展；是否装好由下一轮判断。 */
  extensionsInstalling?: string[];
  extensionsUninstalling?: string[];
  /** 安装或卸载命令失败的扩展（市场里没有、平台不支持等），本进程内不再重发，只在文案里说明。 */
  extensionsFailed?: string[];
  /** 当前窗口不在默认 Profile，本轮没有装卸扩展。 */
  extensionsDeferred?: boolean;
  /** 本轮采用了哪一方；'none' 表示两侧都没有改动。 */
  snapshotChoice?: Exclude<SnapshotChoice, 'conflict'>;
  /** 本轮是按用户选定的一方执行的，文案要说明另一份已备份。 */
  resolvedConflict: boolean;
  /** 本轮确实把配置提交并推到了远端。补推已有提交也算。 */
  transferredToCloud?: boolean;
  /** 本轮确实把配置写回了本机，或向 IDE 发出了扩展装卸。 */
  transferredToLocal?: boolean;
}

export function createSyncReport(mode: SyncMode): SyncReport {
  return {
    mode,
    usedAiFallback: false,
    recoveredPendingChanges: false,
    recoveredFromDivergence: false,
    adoptedCloud: false,
    changedFileCount: 0,
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
  /** 正在把配置传到云端或写回本机。只检查、没有变化时为假。用户点下的回滚、覆盖云端、冲突选择从第一步起就为真。 */
  transferring?: boolean;
  /** 上一轮真正传过配置后的方向，留到下一轮真正开始传输。 */
  transferResult?: TransferResult;
  /** 用户点下的操作正在逐步播报。自动同步不设。 */
  narrating?: boolean;
  /** narrating 时当前步骤，侧边栏据此替换「同步中」。 */
  step?: StageName;
}

export interface ProfileDescriptor {
  id: string;
  name: string;
  location: string;
  isDefault: boolean;
}

/**
 * 快照清单版本。2 起命名 Profile 的 id 由名称派生、快捷键按平台分文件、增加宿主级文件；
 * 旧版本插件只认 1，读到 2 会直接报格式无效而不是按旧语义误删本机 Profile。
 */
export const SNAPSHOT_SCHEMA_VERSION = 2;

export interface SnapshotManifest {
  schemaVersion: 1 | 2;
  host: HostKind;
  createdAt: string;
  profiles: Array<Pick<ProfileDescriptor, 'id' | 'name' | 'isDefault'>>;
  /** 只出现在旧版本快照里，仅用于兼容读取，不再写入。 */
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
