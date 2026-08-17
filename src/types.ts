export type HostKind = 'vscode' | 'cursor';
export type SyncMode = 'backup' | 'sync';
export type SyncPhase =
  | '未配置'
  | '空闲'
  | '正在扫描'
  | '正在拉取'
  | '正在提交'
  | '正在推送'
  | '正在同步扩展'
  | '等待其他窗口关闭'
  | '等待 AI'
  | '失败';

export interface SyncOutcome {
  ok: boolean;
  retry?: boolean;
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

export interface SyncConfiguration {
  repositoryUrl: string;
  branch: string;
  gitUserName: string;
  gitUserEmail: string;
}

export interface PluginConfiguration extends SyncConfiguration {
  mode: SyncMode;
  autoSync: boolean;
  pollIntervalSeconds: number;
  debounceSeconds: number;
  includeProfileAssociations: boolean;
}

export interface RuntimeStatus {
  phase: SyncPhase;
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
  mode: 'backup',
  autoSync: true,
  pollIntervalSeconds: 300,
  debounceSeconds: 10,
  includeProfileAssociations: false,
};
