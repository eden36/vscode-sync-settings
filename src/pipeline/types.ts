import { AiService } from '../ai';
import { WindowSafetySnapshot } from '../coordinator';
import { ExtensionSyncPlan } from '../extension-manifest';
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
  SnapshotChoice,
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
  isCancellationRequested: () => boolean;
  updateStatus: (patch: Partial<RuntimeStatus>) => void;
  conflictBackupRoot: string;
  /** 设备名，写入提交信息前缀，便于在多台机器间区分改动来源。 */
  deviceName: string;
  /** 扩展装卸命令异步失败时调用：失败不会改变清单，不通知就没有下一轮来显示失败原因。 */
  onExtensionFailure?: () => void;
}

/** 一轮同步涉及的目录，全部在进入流程前算好，stage 不再自行拼路径。 */
export interface SyncPaths {
  temporaryRoot: string;
  localHostRoot: string;
  repositoryHostRoot: string;
}

/** stage 之间传递的中间结果；缺失即为流程编排错误，由 requireValue 报出。 */
export interface SyncArtifacts {
  localManifest?: SnapshotManifest;
  pull?: PullResult;
  strategy?: CloudAdoptDecision;
  /** 远端是否已有本宿主的快照；决定本轮是与云端比较还是用本机内容初始化。 */
  remoteExists?: boolean;
  /** 本轮采用了哪一方的快照；决定后续是否推送与写回。 */
  choice?: Exclude<SnapshotChoice, 'conflict'>;
  /** 轮初的本机指纹，写回前用它确认本机没有在同步期间被改动。 */
  localFingerprint?: string;
  restore?: RestoreResult;
  /**
   * 预置的提交说明；有值时不再调用 AI 生成，且即使没有采用本机也要提交仓库改动
   * （还原历史提交、按用户选择从云端删除 Profile 时使用）。
   */
  commitMessage?: string;
  /** 本机要装卸的扩展，由扩展清单合并得出；还原流程不经过合并，由 extensions stage 自行计算。 */
  extensionPlan?: Pick<ExtensionSyncPlan, 'install' | 'uninstall'>;
  /** 合并改写了仓库工作区的扩展清单；即使配置采用云端或没变，也要提交这次改动。 */
  extensionsMerged?: boolean;
}

export interface SyncContext {
  readonly dependencies: SyncDependencies;
  readonly configuration: PluginConfiguration;
  readonly adoptCloud: boolean;
  /** 用户对「两边都改了」的选择，本轮据此直接落地，不再询问。 */
  readonly resolution?: 'local' | 'cloud';
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

/** 窗口存在未保存或状态不明的配置文档时暂停同步，安全后由调度层重试。 */
export function windowBlock(safety: WindowSafetySnapshot): StageOutcome | undefined {
  if (safety.dirtyWindows > 0) {
    return {
      kind: 'blocked',
      reason: 'dirty-windows',
      message: `有 ${safety.dirtyWindows} 个窗口存在未保存的配置文件，保存后会自动继续。`,
    };
  }
  if (safety.unreadableWindows > 0) {
    return {
      kind: 'blocked',
      reason: 'unreadable-windows',
      message: `有 ${safety.unreadableWindows} 个窗口状态无法确认，已暂停同步。`,
    };
  }
  return undefined;
}
