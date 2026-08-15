import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AiService } from './ai';
import { ConfigurationStore } from './configuration';
import { WindowSafetySnapshot } from './coordinator';
import { ConfigurationRepositoryGitService } from './git-service';
import { HostEnvironment } from './host';
import { runPipeline } from './pipeline/pipeline';
import { SYNC_STAGES } from './pipeline/stages';
import { SyncContext, SyncDependencies } from './pipeline/types';
import { ProfileAdapter } from './profile-adapter';
import { RuntimeStateStore } from './runtime-state';
import { createSyncReport, RuntimeStatus, SyncOutcome } from './types';

export interface SynchronizeOptions {
  adoptCloud?: boolean;
}

/**
 * 一轮同步的入口：负责重入保护、前置校验、临时目录的建立与清理，
 * 具体步骤全部交给 pipeline/stages。
 */
export class SyncEngine {
  private running = false;
  private cancellationRequested = false;
  private readonly dependencies: SyncDependencies;

  public constructor(
    private readonly environment: HostEnvironment,
    adapter: ProfileAdapter,
    git: ConfigurationRepositoryGitService,
    ai: AiService,
    private readonly configurationStore: ConfigurationStore,
    private readonly runtimeState: RuntimeStateStore,
    private readonly updateStatus: (patch: Partial<RuntimeStatus>) => void,
    private readonly windowSafety: () => Promise<WindowSafetySnapshot>,
  ) {
    this.dependencies = {
      environment,
      adapter,
      git,
      ai,
      runtimeState,
      windowSafety,
      isCancellationRequested: () => this.cancellationRequested,
      updateStatus,
      // 与 ProfileAdapter 的 backups 目录分开存放，避免被那边的保留策略清理。
      conflictBackupRoot: path.join(environment.runtimePath, 'conflict-backups'),
    };
  }

  public async beginCloudAdopt(): Promise<void> {
    await this.runtimeState.update({ cloudAdoptPending: true });
  }

  /** 当前安全操作结束后停止，不强制终止 Git 或扩展安装进程。 */
  public requestStop(): void {
    if (this.running) this.cancellationRequested = true;
  }

  public async synchronize(options: SynchronizeOptions = {}): Promise<SyncOutcome | undefined> {
    if (this.running) return undefined;
    this.running = true;
    this.cancellationRequested = false;
    const configuration = this.configurationStore.get();
    let temporaryRoot: string | undefined;
    try {
      if (!configuration.repositoryUrl) {
        this.updateStatus({ message: '请填写 Git 仓库地址。' });
        return { ok: false };
      }
      if (options.adoptCloud) await this.beginCloudAdopt();

      const safety = await this.windowSafety();
      if (safety.dirtyWindows > 0 || safety.unreadableWindows > 0) {
        const reason = safety.dirtyWindows > 0 ? 'dirty-windows' : 'unreadable-windows';
        const count = safety.dirtyWindows > 0 ? safety.dirtyWindows : safety.unreadableWindows;
        this.updateStatus({
          activeWindows: safety.activeWindows,
          message: reason === 'dirty-windows'
            ? `有 ${count} 个窗口存在未保存的配置文件，保存后会自动继续。`
            : `有 ${count} 个窗口状态无法确认，已暂停同步。`,
        });
        return { ok: false, retry: true, blockReason: reason };
      }

      // 其他窗口可能刚标记过重建，必须读共享文件的最新值而不是本窗口缓存。
      await this.runtimeState.reload();
      const adoptCloud = options.adoptCloud === true || this.runtimeState.get().cloudAdoptPending;

      // 同步在独占锁内执行，进程异常退出残留的临时快照可以安全清空。
      const snapshotRoot = path.join(this.environment.runtimePath, 'snapshots');
      await fs.rm(snapshotRoot, { recursive: true, force: true }).catch(() => undefined);
      temporaryRoot = path.join(snapshotRoot, `local-${process.pid}-${Date.now()}`);

      const context: SyncContext = {
        dependencies: this.dependencies,
        configuration,
        adoptCloud,
        paths: {
          temporaryRoot,
          localHostRoot: path.join(temporaryRoot, this.environment.kind),
          baseHostRoot: path.join(temporaryRoot, 'base'),
          repositoryHostRoot: path.join(
            this.dependencies.git.repositoryPath,
            '.profile-git-sync',
            'hosts',
            this.environment.kind,
          ),
        },
        report: createSyncReport(),
        artifacts: {},
      };
      return await runPipeline(context, SYNC_STAGES);
    } catch (error) {
      this.updateStatus({ message: error instanceof Error ? error.message : String(error) });
      return { ok: false };
    } finally {
      this.running = false;
      if (temporaryRoot) {
        await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}
