import { AiService } from '../ai';
import { WindowSafetySnapshot } from '../coordinator';
import { ConfigurationRepositoryGitService, PullResult, RepositoryCommit } from '../git-service';
import { HostEnvironment } from '../host';
import { ProfileAdapter, RestoreResult } from '../profile-adapter';
import { RuntimeStateStore } from '../runtime-state';
import { CloudAdoptDecision } from '../sync-strategy';
import {
  BlockReason,
  LinkState,
  PluginConfiguration,
  RuntimeStatus,
  SnapshotManifest,
  StageName,
  SyncReport,
} from '../types';

/** 同步流程可用的能力集合；测试中整体替换即可脱离磁盘与网络。 */
export interface SyncDependencies {
  environment: HostEnvironment;
  adapter: ProfileAdapter;
  git: ConfigurationRepositoryGitService;
  ai: AiService;
  runtimeState: RuntimeStateStore;
  windowSafety: () => Promise<WindowSafetySnapshot>;
  updateStatus: (patch: Partial<RuntimeStatus>) => void;
  conflictBackupRoot: string;
}

/** 一轮同步涉及的目录，全部在进入流程前算好，stage 不再自行拼路径。 */
export interface SyncPaths {
  temporaryRoot: string;
  localHostRoot: string;
  baseHostRoot: string;
  repositoryHostRoot: string;
}

/** stage 之间传递的中间结果；缺失即为流程编排错误，由 requireValue 报出。 */
export interface SyncArtifacts {
  localManifest?: SnapshotManifest;
  pull?: PullResult;
  strategy?: CloudAdoptDecision;
  /** 远端是否已有本宿主的快照；决定本轮是三方合并还是用本机内容初始化。 */
  remoteExists?: boolean;
  restore?: RestoreResult;
  /** 预置的提交说明；有值时不再调用 AI 生成（还原历史提交时使用）。 */
  commitMessage?: string;
}

export interface SyncContext {
  readonly dependencies: SyncDependencies;
  readonly configuration: PluginConfiguration;
  readonly adoptCloud: boolean;
  /** 本轮要还原的历史提交，只有还原流程会设置。 */
  readonly restoreTarget?: RepositoryCommit;
  readonly paths: SyncPaths;
  readonly report: SyncReport;
  readonly artifacts: SyncArtifacts;
}

export type StageOutcome =
  | { kind: 'continue' }
  | { kind: 'blocked'; reason: BlockReason; message?: string };

export interface Stage {
  readonly name: StageName;
  run(context: SyncContext): Promise<StageOutcome>;
}

export function requireValue<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`同步流程内部状态缺失：${name}`);
  return value;
}
