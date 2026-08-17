import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { WindowSafetySnapshot } from '../coordinator';
import { collectExtensionIdsFromFiles, installAndWaitForExtensions, uninstallRemovedExtensions } from '../extension-wait';
import { HOST_EXTENSIONS_FILE } from '../profile-adapter';
import { findPotentialSecrets } from '../secret-scanner';
import { readManifest } from '../snapshot-conflict';
import { fallbackCommitMessage } from '../sync-fallback';
import { decideCloudAdopt } from '../sync-strategy';
import { mergeStage } from './merge';
import { requireValue, Stage, StageOutcome, SyncContext } from './types';

const snapshotStage: Stage = {
  name: 'snapshot',
  async run(context: SyncContext): Promise<StageOutcome> {
    const { adapter } = context.dependencies;
    context.artifacts.localManifest = await adapter.createSnapshot(
      context.paths.localHostRoot,
      context.configuration.includeProfileAssociations,
    );
    return { kind: 'continue' };
  },
};

const scanSecretsStage: Stage = {
  name: 'scan-secrets',
  async run(context: SyncContext): Promise<StageOutcome> {
    // 整包采用云端时不会把本机内容推上去，无需拦截本机的历史遗留凭据。
    if (context.adoptCloud) return { kind: 'continue' };
    const manifest = requireValue(context.artifacts.localManifest, 'localManifest');
    const secretFiles = await findPotentialSecrets(context.paths.localHostRoot, manifest);
    if (secretFiles.length) throw new Error(`检测到可能包含凭据的配置，已拒绝提交：${secretFiles.join('、')}`);
    return { kind: 'continue' };
  },
};

const prepareStage: Stage = {
  name: 'prepare',
  async run(context: SyncContext): Promise<StageOutcome> {
    const { git, environment } = context.dependencies;
    await git.prepare(context.configuration);
    context.report.recoveredPendingChanges = await git.discardPendingHostChanges(environment.kind);
    return { kind: 'continue' };
  },
};

const pullStage: Stage = {
  name: 'pull',
  async run(context: SyncContext): Promise<StageOutcome> {
    const { git, environment } = context.dependencies;
    const pull = await git.pull(context.configuration);
    // 链路状态由调度层根据 SyncOutcome.unrelated 写入，stage 只报告阻塞原因。
    if (pull.state === 'unrelated') return { kind: 'blocked', reason: 'unrelated' };
    context.artifacts.pull = pull;
    context.report.recoveredFromDivergence = pull.recoveredFromDivergence;
    // 基准必须取本地与远端的共同祖先，否则本机上次的改动会被当成共同基础，导致误判冲突。
    // 备份模式不做三方合并，导出基准纯属多余开销。
    if (pull.mergeBase && context.configuration.mode === 'sync') {
      await git.exportHostTree(pull.mergeBase, environment.kind, context.paths.baseHostRoot);
    }
    return { kind: 'continue' };
  },
};

const decideStage: Stage = {
  name: 'decide',
  async run(context: SyncContext): Promise<StageOutcome> {
    const { environment } = context.dependencies;
    const pull = requireValue(context.artifacts.pull, 'pull');
    const remoteExists = await exists(path.join(context.paths.repositoryHostRoot, 'manifest.json'));
    const strategy = decideCloudAdopt(context.configuration.mode, context.adoptCloud, pull.state, remoteExists);
    if (strategy === 'missing-cloud') {
      await context.dependencies.runtimeState.update({ cloudAdoptPending: false });
      const hostLabel = environment.kind === 'cursor' ? 'Cursor' : 'VS Code';
      throw new Error(`云端没有 ${hostLabel} 的配置快照，无法覆盖本机。本机配置未被推送。如需用本机初始化该宿主，请使用立即同步。`);
    }
    context.artifacts.strategy = strategy;
    context.artifacts.remoteExists = remoteExists;
    context.report.adoptedCloud = strategy === 'adopt';
    return { kind: 'continue' };
  },
};

const pushStage: Stage = {
  name: 'push',
  async run(context: SyncContext): Promise<StageOutcome> {
    const { git, ai, environment, windowSafety, updateStatus } = context.dependencies;
    // 首次接入或重建后没有可信合并基准，本轮只把云端写回本机，不产生新的远端提交。
    if (context.artifacts.strategy === 'adopt') return { kind: 'continue' };

    const changed = await git.stageHost(environment.kind);
    context.report.changedFileCount = changed.length;
    let message: string | undefined;
    if (changed.length) {
      updateStatus({ sync: { kind: 'running', stage: 'ai' }, pendingChanges: changed.length });
      try {
        message = await ai.createCommitMessage(changed.map((file) => `- ${file}`).join('\n'));
      } catch {
        message = fallbackCommitMessage(environment.kind);
        context.report.usedAiFallback = true;
      }
      updateStatus({ sync: { kind: 'running', stage: 'push' }, message });
    }

    // 提交前再确认一次：等待 AI 期间用户可能又打开了未保存的配置文档。
    const blocked = windowBlock(await windowSafety());
    if (blocked) return blocked;

    if (message) await git.commitAndPush(context.configuration, message);
    else await git.pushIfAhead(context.configuration);
    return { kind: 'continue' };
  },
};

const applyStage: Stage = {
  name: 'apply',
  async run(context: SyncContext): Promise<StageOutcome> {
    const { adapter, windowSafety, runtimeState } = context.dependencies;
    const adopt = context.artifacts.strategy === 'adopt';
    if (adopt) await runtimeState.update({ cloudAdoptPending: true });

    const safety = await windowSafety();
    const blocked = windowBlock(safety);
    if (blocked) return blocked;

    // Profile 增删会重建磁盘上的 Profile 列表，只在本机仅剩一个窗口时应用，避免影响其他窗口正在使用的 Profile。
    const restore = await adapter.restoreSnapshot(context.paths.repositoryHostRoot, safety.activeWindows <= 1, adopt);
    context.artifacts.restore = restore;
    context.report.activeWindows = safety.activeWindows;
    context.report.structuralApplied = restore.structuralApplied;
    context.report.waitingForWindows = restore.structuralChange && !restore.structuralApplied;
    if (restore.message) context.report.structuralMessage = restore.message;
    if (adopt && !context.report.waitingForWindows) await runtimeState.update({ cloudAdoptPending: false });
    return { kind: 'continue' };
  },
};

const extensionsStage: Stage = {
  name: 'extensions',
  async run(context: SyncContext): Promise<StageOutcome> {
    const { adapter, updateStatus } = context.dependencies;
    const manifest = await readManifest(context.paths.repositoryHostRoot);
    // 只认宿主级清单：Profile 目录下的 extensions.json 记录的是启用状态且可能过时，
    // 混进来会让已卸载的扩展被重新装回，卸载判定必须有单一权威来源。
    if (!manifest.files[HOST_EXTENSIONS_FILE]) return { kind: 'continue' };
    const targetIds = await collectExtensionIdsFromFiles([
      path.join(context.paths.repositoryHostRoot, HOST_EXTENSIONS_FILE),
    ]);
    if (!targetIds.length) return { kind: 'continue' };

    const onProgress = (message: string) => updateStatus({ sync: { kind: 'running', stage: 'extensions' }, message });
    // 先卸后装：云端移除的扩展必须在本机也消失，否则下一轮又会被本机推回云端，两台机器来回拉扯。
    const uninstallFailed = await uninstallRemovedExtensions(targetIds, await adapter.listInstalledExtensionIds(), { onProgress });
    const result = await installAndWaitForExtensions(targetIds, { onProgress });
    const pending = [...result.pending, ...uninstallFailed];
    if (pending.length) context.report.extensionsPending = pending;
    return { kind: 'continue' };
  },
};

/** 顺序即同步语义：先看清本机，再对齐远端，最后才写回本机。 */
export const SYNC_STAGES: Stage[] = [
  snapshotStage,
  scanSecretsStage,
  prepareStage,
  pullStage,
  decideStage,
  mergeStage,
  pushStage,
  applyStage,
  extensionsStage,
];

/** 备份模式的流程到推送为止：不写回本机，也就没有 apply 与 extensions 两步。 */
export const BACKUP_STAGES: Stage[] = [
  snapshotStage,
  scanSecretsStage,
  prepareStage,
  pullStage,
  decideStage,
  mergeStage,
  pushStage,
];

export const testing = { snapshotStage, scanSecretsStage, prepareStage, pullStage, decideStage, pushStage, applyStage, extensionsStage };

/** 窗口存在未保存或状态不明的配置文档时暂停同步，安全后由调度层重试。 */
function windowBlock(safety: WindowSafetySnapshot): StageOutcome | undefined {
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

async function exists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false);
}
