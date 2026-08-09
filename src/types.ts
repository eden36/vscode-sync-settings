export type HostKind = 'vscode' | 'cursor';
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
  | '存在冲突'
  | '失败';

export interface SyncOutcome {
  ok: boolean;
  retry?: boolean;
  extensionsPending?: string[];
}

export interface SyncConfiguration {
  repositoryUrl: string;
  branch: string;
  gitUserName: string;
  gitUserEmail: string;
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

export const DEFAULT_CONFIGURATION: SyncConfiguration = {
  repositoryUrl: '',
  branch: 'main',
  gitUserName: '',
  gitUserEmail: ''
};
