import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AiService } from './ai';
import { ConfigurationStore } from './configuration';
import { WindowSafetySnapshot } from './coordinator';
import { ConfigurationRepositoryGitService, RepositoryCommit } from './git-service';
import { HostEnvironment } from './host';
import { OVERRIDE_STAGES } from './pipeline/override';
import { runPipeline } from './pipeline/pipeline';
import { RESTORE_STAGES } from './pipeline/restore';
import { BACKUP_STAGES, SYNC_STAGES } from './pipeline/stages';
import { Stage, SyncContext, SyncDependencies } from './pipeline/types';
import { ProfileAdapter } from './profile-adapter';
import { RuntimeStateStore } from './runtime-state';
import { createSyncReport, PluginConfiguration, RuntimeStatus, SyncOutcome } from './types';

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
    onExtensionFailure?: () => void,
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
      deviceName: os.hostname(),
      ...(onExtensionFailure ? { onExtensionFailure } : {}),
    };
  }

  public async beginCloudAdopt(): Promise<void> {
    await this.runtimeState.update({ cloudAdoptPending: true });
  }

  /**
   * 当前安全操作结束后停止，不强制终止 Git 或扩展安装进程。
   * 本轮可能还在抢独占锁、尚未真正开始，因此停止意图必须留到下一次 synchronize 才消费。
   */
  public requestStop(): void {
    this.cancellationRequested = true;
  }

  /** 重新开启同步时清除遗留的停止意图，否则新一轮会被上一次的停止直接取消。 */
  public clearStop(): void {
    this.cancellationRequested = false;
  }

  public async synchronize(options: SynchronizeOptions = {}): Promise<SyncOutcome | undefined> {
    if (this.running) return undefined;
    if (this.cancellationRequested) {
      // 停止意图在这一轮就算兑现，必须就地清除；否则一旦某条开关路径漏掉 clearStop，本窗口之后每一轮都会被取消。
      this.cancellationRequested = false;
      return { ok: false, cancelled: true };
    }
    this.running = true;
    const configuration = this.configurationStore.get();
    const backupOnly = configuration.mode === 'backup';
    let temporaryRoot: string | undefined;
    try {
      if (!configuration.repositoryUrl) {
        this.updateStatus({ message: '请填写 Git 仓库地址。' });
        return { ok: false };
      }
      if (options.adoptCloud && !backupOnly) await this.beginCloudAdopt();

      const blocked = await this.blockedByWindows();
      if (blocked) return blocked;

      // 其他窗口可能刚标记过重建，必须读共享文件的最新值而不是本窗口缓存。
      await this.runtimeState.reload();
      // 备份模式永不写回本机，采用云端无从谈起；标记留着会在切回同步模式的第一轮整包覆盖本机，必须就地清除。
      if (backupOnly && this.runtimeState.get().cloudAdoptPending) {
        await this.runtimeState.update({ cloudAdoptPending: false });
      }
      const adoptCloud = !backupOnly && (options.adoptCloud === true || this.runtimeState.get().cloudAdoptPending);
      // 用户对「两边都改了」的选择存在共享状态里：可能是别的窗口点的，也可能是上一轮推送失败后留下的。
      const resolution = backupOnly ? undefined : this.runtimeState.get().pendingResolution;
      // 只播报用户刚点下的那一次。选择会留到推送成功，不能因为选择还在就把之后的自动重试也播报一遍。
      const narrateSteps = !backupOnly && this.runtimeState.get().narrateNext === true;
      if (this.runtimeState.get().narrateNext === true) await this.runtimeState.update({ narrateNext: undefined });
      if (narrateSteps) this.beginNarration();

      temporaryRoot = await this.prepareTemporaryRoot();
      const context = this.buildContext(configuration, temporaryRoot, {
        adoptCloud,
        narrateSteps,
        ...(resolution ? { resolution } : {}),
      });
      return await runPipeline(context, backupOnly ? BACKUP_STAGES : SYNC_STAGES);
    } catch (error) {
      this.updateStatus({ transferring: false, narrating: false, step: undefined, message: error instanceof Error ? error.message : String(error) });
      return { ok: false };
    } finally {
      this.running = false;
      if (temporaryRoot) {
        await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  /**
   * 把所选历史提交的配置写回本机，并在远端 tip 上追加一条新的还原提交。
   * 用户显式操作，备份模式同样会写回本机；不改写远端已有历史。
   */
  public async restoreCommit(target: RepositoryCommit): Promise<SyncOutcome | undefined> {
    return this.runManual(RESTORE_STAGES, { adoptCloud: false, restoreTarget: target });
  }

  /**
   * 用本机配置整份覆盖云端，并在远端 tip 上追加一条新提交。
   * 用户显式操作，不看基准、不询问冲突、不写回本机；不改写远端已有历史。
   */
  public async overrideCloud(): Promise<SyncOutcome | undefined> {
    return this.runManual(OVERRIDE_STAGES, { adoptCloud: false });
  }

  /** 用户显式触发的单次流程（还原、覆盖云端）：共用重入保护、窗口安全检查与临时目录生命周期。 */
  private async runManual(
    stages: Stage[],
    options: { adoptCloud: boolean; restoreTarget?: RepositoryCommit },
  ): Promise<SyncOutcome | undefined> {
    if (this.running) return undefined;
    this.running = true;
    // 关闭开关留下的停止意图只针对当时的自动同步；用户此刻显式发起的流程（同步关闭时也允许）不能被它取消。
    this.cancellationRequested = false;
    const configuration = this.configurationStore.get();
    let temporaryRoot: string | undefined;
    try {
      if (!configuration.repositoryUrl) {
        this.updateStatus({ message: '请填写 Git 仓库地址。' });
        return { ok: false };
      }

      const blocked = await this.blockedByWindows();
      if (blocked) return blocked;

      this.beginNarration();
      temporaryRoot = await this.prepareTemporaryRoot();
      const context = this.buildContext(configuration, temporaryRoot, { ...options, narrateSteps: true });
      return await runPipeline(context, stages);
    } catch (error) {
      this.updateStatus({ transferring: false, narrating: false, step: undefined, message: error instanceof Error ? error.message : String(error) });
      return { ok: false };
    } finally {
      this.running = false;
      if (temporaryRoot) {
        await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private async blockedByWindows(): Promise<SyncOutcome | undefined> {
    const safety = await this.windowSafety();
    if (safety.dirtyWindows === 0 && safety.unreadableWindows === 0) return undefined;
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

  /** 确认之后、慢步骤开始前就亮同步标，避免用户等到写回才看到反馈。 */
  private beginNarration(): void {
    this.updateStatus({ transferring: true, narrating: true, transferResult: undefined, step: 'snapshot' });
  }

  /** 流程在独占锁内执行，进程异常退出残留的临时快照可以安全清空。 */
  private async prepareTemporaryRoot(): Promise<string> {
    const snapshotRoot = path.join(this.environment.runtimePath, 'snapshots');
    await fs.rm(snapshotRoot, { recursive: true, force: true }).catch(() => undefined);
    return path.join(snapshotRoot, `local-${process.pid}-${Date.now()}`);
  }

  private buildContext(
    configuration: PluginConfiguration,
    temporaryRoot: string,
    options: { adoptCloud: boolean; resolution?: 'local' | 'cloud'; restoreTarget?: RepositoryCommit; narrateSteps?: boolean },
  ): SyncContext {
    return {
      dependencies: this.dependencies,
      configuration,
      adoptCloud: options.adoptCloud,
      ...(options.resolution ? { resolution: options.resolution } : {}),
      ...(options.restoreTarget ? { restoreTarget: options.restoreTarget } : {}),
      ...(options.narrateSteps ? { narrateSteps: true } : {}),
      paths: {
        temporaryRoot,
        localHostRoot: path.join(temporaryRoot, this.environment.kind),
        repositoryHostRoot: path.join(
          this.dependencies.git.repositoryPath,
          '.profile-git-sync',
          'hosts',
          this.environment.kind,
        ),
      },
      report: createSyncReport(configuration.mode),
      artifacts: {},
    };
  }
}
