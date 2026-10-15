import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { HOST_EXTENSIONS_FILE } from '../extension-manifest';
import { collectExtensionIdsFromFiles, installAndWaitForExtensions, uninstallRemovedExtensions } from '../extension-wait';
import { findPotentialSecrets } from '../secret-scanner';
import { namedProfiles, readManifest, snapshotDigest } from '../snapshot-conflict';
import { fallbackCommitMessage } from '../sync-fallback';
import { decideCloudAdopt } from '../sync-strategy';
import { HOST_LABELS, SnapshotManifest, SyncBaseline } from '../types';
import { chooseStage } from './choose';
import { requireValue, Stage, StageOutcome, SyncContext, windowBlock } from './types';

/** 扩展连续这么多轮仍没装完就放弃等待，否则扩展清单会永远被排除在改动判定之外。 */
const EXTENSION_SETTLE_ROUNDS = 3;

export const snapshotStage: Stage = {
  name: 'snapshot',
  async run(context: SyncContext): Promise<StageOutcome> {
    const { adapter } = context.dependencies;
    context.artifacts.localManifest = await adapter.createSnapshot(context.paths.localHostRoot);
    // 写回前要用它确认本机没有在本轮期间被改动，采集完立刻记下。
    context.artifacts.localFingerprint = await adapter.fingerprint();
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
    if (secretFiles.length) {
      throw new Error(`检测到可能包含凭据的配置，已拒绝提交：${secretFiles.join('、')}。请移除其中的凭据，或改写触发检测的键名后重试。`);
    }
    return { kind: 'continue' };
  },
};

export const prepareStage: Stage = {
  name: 'prepare',
  async run(context: SyncContext): Promise<StageOutcome> {
    const { git, environment } = context.dependencies;
    await git.prepare(context.configuration);
    context.report.recoveredPendingChanges = await git.discardPendingHostChanges(environment.kind);
    return { kind: 'continue' };
  },
};

export const pullStage: Stage = {
  name: 'pull',
  async run(context: SyncContext): Promise<StageOutcome> {
    const { git } = context.dependencies;
    const pull = await git.pull(context.configuration);
    // 链路状态由调度层根据 SyncOutcome.unrelated 写入，stage 只报告阻塞原因。
    if (pull.state === 'unrelated') return { kind: 'blocked', reason: 'unrelated' };
    context.artifacts.pull = pull;
    context.report.recoveredFromDivergence = pull.recoveredFromDivergence;
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
      throw new Error(`云端没有 ${HOST_LABELS[environment.kind]} 的配置快照，无法覆盖本机。本机配置未被推送。如需用本机初始化该宿主，请使用立即同步。`);
    }
    context.artifacts.strategy = strategy;
    context.artifacts.remoteExists = remoteExists;
    context.report.adoptedCloud = strategy === 'adopt';
    return { kind: 'continue' };
  },
};

export const pushStage: Stage = {
  name: 'push',
  async run(context: SyncContext): Promise<StageOutcome> {
    const { git, ai, environment, windowSafety, updateStatus, deviceName, runtimeState } = context.dependencies;
    // 采用云端或两侧都没改时仓库内容没被改写，但上次推送失败留下的提交仍要补推。
    // 预置了提交说明的流程（还原、从云端删除 Profile）改写过仓库，同样要提交。
    const commitRepository = context.artifacts.choice === 'local' || context.artifacts.commitMessage !== undefined;
    const changed = commitRepository ? await git.stageHost(environment.kind) : [];
    context.report.changedFileCount = changed.length;
    let message: string | undefined;
    if (changed.length) {
      const prefix = `[${deviceName}] `;
      // 这些流程的说明必须是确定的，预置了就不再花一次 AI 调用。
      if (context.artifacts.commitMessage) {
        message = prefix + context.artifacts.commitMessage;
      } else {
        updateStatus({ sync: { kind: 'running', stage: 'ai' }, pendingChanges: changed.length });
        try {
          message = prefix + (await ai.createCommitMessage(changed.map((file) => `- ${file}`).join('\n')));
        } catch {
          message = prefix + fallbackCommitMessage(environment.kind);
          context.report.usedAiFallback = true;
        }
      }
      updateStatus({ sync: { kind: 'running', stage: 'push' }, message, pendingChanges: changed.length });
    }

    // 提交前再确认一次：等待 AI 期间用户可能又打开了未保存的配置文档。
    const blocked = windowBlock(await windowSafety());
    if (blocked) return blocked;

    if (message) await git.commitAndPush(context.configuration, message);
    else await git.pushIfAhead(context.configuration);

    // 采用本机并推送成功后，仓库内容就是本机这份快照，基准此刻就要前移。
    // 留到 finalize 才写的话，之后被写回前的二次确认拦住、被取消或扩展步骤抛错，下一轮都会把自己刚推的内容判成云端改动。
    // 还原流程的仓库内容是历史快照而不是本机清单，仍由 finalize 记录。
    if (context.artifacts.choice === 'local' && !context.restoreTarget) {
      await runtimeState.update({
        baseline: await computeBaseline(context, requireValue(context.artifacts.localManifest, 'localManifest')),
        // 用户的选择到这里已经兑现，留着会被下一次真正的冲突自动沿用。
        pendingResolution: undefined,
        profileResolution: undefined,
      });
    }
    return { kind: 'continue' };
  },
};

export const applyStage: Stage = {
  name: 'apply',
  async run(context: SyncContext): Promise<StageOutcome> {
    const { adapter, windowSafety, runtimeState } = context.dependencies;
    const adopt = context.artifacts.strategy === 'adopt';
    if (adopt) await runtimeState.update({ cloudAdoptPending: true });

    const safety = await windowSafety();
    const blocked = windowBlock(safety);
    if (blocked) return blocked;

    // 采集快照之后用户可能又保存了配置；此时写回会覆盖掉那次改动，而基准还会照常前移，改动就永久消失了。
    const current = await adapter.fingerprint();
    if (current !== requireValue(context.artifacts.localFingerprint, 'localFingerprint')) {
      return { kind: 'blocked', reason: 'local-changed' };
    }

    const restore = await adapter.restoreSnapshot(context.paths.repositoryHostRoot);
    context.artifacts.restore = restore;
    context.report.activeWindows = safety.activeWindows;
    // 同步模式下这两类差异已在择一前处理，走到这里只可能来自整包采用云端或还原历史，如实告知用户。
    const notes: string[] = [];
    if (restore.missingProfiles.length) {
      notes.push(`云端有本机没有的 Profile：${restore.missingProfiles.join('、')}，在本机新建同名 Profile 后会自动套用云端配置`);
    }
    const overwritten = context.artifacts.choice === 'cloud' || context.restoreTarget !== undefined;
    if (overwritten && restore.localOnlyProfiles.length) {
      notes.push(`本机的 Profile ${restore.localOnlyProfiles.join('、')} 云端没有，已原样保留`);
    }
    if (notes.length) context.report.profileMessage = notes.join('；');
    if (adopt) await runtimeState.update({ cloudAdoptPending: false });
    return { kind: 'continue' };
  },
};

export const extensionsStage: Stage = {
  name: 'extensions',
  async run(context: SyncContext): Promise<StageOutcome> {
    const { adapter, environment, runtimeState, updateStatus } = context.dependencies;
    const manifest = await readManifest(context.paths.repositoryHostRoot);
    // 只认宿主级清单：Profile 目录下的 extensions.json 记录的是启用状态且可能过时，
    // 混进来会让已卸载的扩展被重新装回，卸载判定必须有单一权威来源。
    if (!manifest.files[HOST_EXTENSIONS_FILE]) return { kind: 'continue' };
    // 只有采用了云端（含还原历史）时本机才要整体向清单收敛；其余轮次只继续处理上一轮没装完的那几个，
    // 否则用户在收敛期间新装的扩展会因为不在云端清单里被卸掉。
    const converge = context.artifacts.choice === 'cloud' || context.restoreTarget !== undefined;
    const previous = new Set((runtimeState.get().extensionsPending ?? []).map((id) => id.toLowerCase()));
    if (!converge && !previous.size) return { kind: 'continue' };
    // 装卸命令只作用于当前窗口的 Profile，而清单属于默认 Profile；在命名 Profile 窗口里装卸会装错地方。
    if (environment.inDefaultProfile === false) {
      context.report.extensionsDeferred = true;
      return { kind: 'continue' };
    }
    const targetIds = await collectExtensionIdsFromFiles([
      path.join(context.paths.repositoryHostRoot, HOST_EXTENSIONS_FILE),
    ]);
    if (!targetIds.length) return { kind: 'continue' };
    const inScope = (id: string) => converge || previous.has(id.toLowerCase());

    const onProgress = (message: string) => updateStatus({ sync: { kind: 'running', stage: 'extensions' }, message });
    const listInstalled = () => adapter.listInstalledExtensionIds();
    // 先卸后装：云端移除的扩展必须在本机也消失，否则下一轮又会被本机推回云端，两台机器来回拉扯。
    const installed = (await listInstalled()).filter(inScope);
    const uninstallFailed = await uninstallRemovedExtensions(targetIds, installed, { onProgress });
    const result = await installAndWaitForExtensions(targetIds.filter(inScope), { listInstalled, onProgress });
    if (result.pending.length) context.report.extensionsPending = result.pending;
    const failed = [...result.failed, ...uninstallFailed];
    if (failed.length) context.report.extensionsFailed = failed;
    return { kind: 'continue' };
  },
};

/**
 * 记录本轮的基准：下一轮据此判断「本机改没改」与「云端改没改」。
 * 必须在写回与扩展装卸之后重新采集，否则写回结果会在下一轮被当成用户改动。
 */
export const finalizeStage: Stage = {
  name: 'finalize',
  async run(context: SyncContext): Promise<StageOutcome> {
    const { adapter, runtimeState } = context.dependencies;
    const restored = context.artifacts.restore;
    const wroteBack = Boolean(restored && restored.changedFiles.length > 0);
    // 写回过本机才重新采集，否则采到的差异只可能是用户在本轮期间的改动；
    // 把它记进基准等于宣布已经同步过，那次改动就再也推不上去了。
    const local = wroteBack
      ? await adapter.createSnapshot(context.paths.localHostRoot)
      : requireValue(context.artifacts.localManifest, 'localManifest');
    const previous = runtimeState.get();
    // 本轮没有装卸扩展（窗口不在默认 Profile）时上一轮的收敛状态原样保留。
    const deferred = context.report.extensionsDeferred === true;
    const pending = deferred ? previous.extensionsPending ?? [] : context.report.extensionsPending ?? [];
    const rounds = deferred ? previous.extensionsPendingRounds ?? 0 : pending.length ? (previous.extensionsPendingRounds ?? 0) + 1 : 0;
    // 扩展迟迟没出现在清单里时不能无限等待，否则清单会永远被排除在改动判定之外。
    const settling = pending.length > 0 && rounds < EXTENSION_SETTLE_ROUNDS;
    await runtimeState.update({
      baseline: await computeBaseline(context, local),
      extensionsPending: settling ? pending : undefined,
      extensionsPendingRounds: settling ? rounds : undefined,
      // 用户的选择在这里才算兑现：中途失败保留它，下一轮直接沿用，不再重复询问。
      pendingResolution: undefined,
      profileResolution: undefined,
    });
    return { kind: 'continue' };
  },
};

/** 顺序即同步语义：先看清本机，再对齐远端，最后才写回本机并记下基准。 */
export const SYNC_STAGES: Stage[] = [
  snapshotStage,
  scanSecretsStage,
  prepareStage,
  pullStage,
  decideStage,
  chooseStage,
  pushStage,
  applyStage,
  extensionsStage,
  finalizeStage,
];

/** 备份模式的流程到推送为止：不写回本机，也就没有 apply 与 extensions 两步。 */
export const BACKUP_STAGES: Stage[] = [
  snapshotStage,
  scanSecretsStage,
  prepareStage,
  pullStage,
  decideStage,
  chooseStage,
  pushStage,
  finalizeStage,
];

export const testing = {
  snapshotStage,
  scanSecretsStage,
  prepareStage,
  pullStage,
  decideStage,
  pushStage,
  applyStage,
  extensionsStage,
  finalizeStage,
};

/**
 * 基准的两处写入（推送成功后、整轮结束时）必须是同一种算法，否则下一轮会把自己写下的基准判成改动。
 * 窗口不在默认 Profile 时本轮没有装卸扩展，扩展部分沿用上一份基准：
 * 前移的话，云端清单的变化会被记成「已同步」，之后回到默认 Profile 窗口也不会再装。
 */
async function computeBaseline(context: SyncContext, local: SnapshotManifest): Promise<SyncBaseline> {
  const { environment, runtimeState } = context.dependencies;
  const platform = environment.platform ?? process.platform;
  const cloud = await readManifest(context.paths.repositoryHostRoot);
  const localDigest = snapshotDigest(local, platform);
  const cloudDigest = snapshotDigest(cloud, platform);
  const frozen = environment.inDefaultProfile === false;
  const previous = frozen ? runtimeState.get().baseline : undefined;
  return {
    localSnapshot: localDigest.snapshot,
    localExtensions: previous?.localExtensions ?? localDigest.extensions,
    cloudSnapshot: cloudDigest.snapshot,
    // 没有上一份可沿用时记成空，让默认 Profile 窗口的下一轮把云端清单判为有改动并去收敛。
    cloudExtensions: frozen ? previous?.cloudExtensions ?? '' : cloudDigest.extensions,
    localProfiles: namedProfiles(local).sort((left, right) => left.localeCompare(right)),
    cloudProfiles: namedProfiles(cloud).sort((left, right) => left.localeCompare(right)),
  };
}

async function exists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false);
}
