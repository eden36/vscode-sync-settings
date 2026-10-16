import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  HOST_EXTENSIONS_FILE,
  parseExtensionIds,
  selectMissingExtensionIds,
  selectRemovableExtensionIds,
} from '../extension-manifest';
import { requestExtensionChanges } from '../extension-wait';
import { findPotentialSecrets } from '../secret-scanner';
import { namedProfiles, readManifest, snapshotDigest } from '../snapshot-conflict';
import { fallbackCommitMessage } from '../sync-fallback';
import { decideCloudAdopt } from '../sync-strategy';
import { HOST_LABELS, SnapshotManifest, SyncBaseline } from '../types';
import { chooseStage } from './choose';
import { requireValue, Stage, StageOutcome, SyncArtifacts, SyncContext, windowBlock } from './types';

export const snapshotStage: Stage = {
  name: 'snapshot',
  async run(context: SyncContext): Promise<StageOutcome> {
    const { adapter } = context.dependencies;
    const before = await adapter.fingerprint();
    context.artifacts.localManifest = await adapter.createSnapshot(context.paths.localHostRoot);
    const after = await adapter.fingerprint();
    // 快照与指纹必须来自同一份本机状态，否则旧快照会配上新指纹并绕过写回检查。
    if (before !== after) return { kind: 'blocked', reason: 'local-changed' };
    context.artifacts.localFingerprint = after;
    return { kind: 'continue' };
  },
};

export const scanSecretsStage: Stage = {
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
    // 预置了提交说明的流程（还原、从云端删除 Profile）与扩展清单合并改写过仓库，同样要提交。
    const commitRepository = context.artifacts.choice === 'local'
      || context.artifacts.commitMessage !== undefined
      || context.artifacts.extensionsMerged === true;
    const changed = commitRepository ? await git.stageHost(environment.kind) : [];
    context.report.changedFileCount = changed.length;
    let message: string | undefined;
    if (changed.length) {
      const prefix = `[${deviceName}] `;
      // 这些流程的说明必须是确定的，预置了就不再花一次 AI 调用。
      if (context.artifacts.commitMessage) {
        message = prefix + context.artifacts.commitMessage;
      } else {
        updateStatus({
          sync: { kind: 'running', stage: 'ai' },
          pendingChanges: changed.length,
          ...(context.narrateSteps ? { step: 'ai' as const } : {}),
        });
        try {
          message = prefix + (await ai.createCommitMessage(changed.map((file) => `- ${file}`).join('\n')));
        } catch {
          message = prefix + fallbackCommitMessage(environment.kind);
          context.report.usedAiFallback = true;
        }
      }
      updateStatus({
        sync: { kind: 'running', stage: 'push' },
        message,
        pendingChanges: changed.length,
        ...(context.narrateSteps ? { step: 'push' as const } : {}),
      });
    }

    // 提交前再确认一次：等待 AI 期间用户可能又打开了未保存的配置文档。
    // 被拦住时这一轮没有推送，不能记成已同步到云端，也不能清掉上一句成功提示。
    const blocked = windowBlock(await windowSafety());
    if (blocked) return blocked;

    if (message) {
      markTransferring(context);
      await git.commitAndPush(context.configuration, message);
      context.report.transferredToCloud = true;
    } else {
      let pushing = false;
      await git.pushIfAhead(context.configuration, () => {
        markTransferring(context);
        pushing = true;
      });
      if (pushing) context.report.transferredToCloud = true;
    }

    // 推送成功后云端已包含本机的扩展增删，本机此刻（轮初采集）的扩展就是下一轮判断增删的起点。
    // 不能等装卸落地后再采：那时采到的「没装上」会和「本机卸载」分不开。
    const localExtensions = await fs.readFile(path.join(context.paths.localHostRoot, HOST_EXTENSIONS_FILE), 'utf8').catch(() => undefined);
    if (localExtensions !== undefined) await runtimeState.update({ syncedExtensions: parseExtensionIds(localExtensions) });

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

    const willWriteLocal = context.artifacts.choice === 'cloud'
      || context.restoreTarget !== undefined
      || context.artifacts.strategy === 'adopt';
    if (willWriteLocal) markTransferring(context);

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
    if (restore.changedFiles.length > 0) context.report.transferredToLocal = true;
    return { kind: 'continue' };
  },
};

/** 只向 IDE 发出装卸命令就结束：装好与否由下一轮的扩展清单说明，清单变化本身会触发下一轮。 */
export const extensionsStage: Stage = {
  name: 'extensions',
  async run(context: SyncContext): Promise<StageOutcome> {
    const plan = context.restoreTarget ? await restorePlan(context) : context.artifacts.extensionPlan;
    if (!plan || (!plan.install.length && !plan.uninstall.length)) return { kind: 'continue' };
    // 装卸命令只作用于当前窗口的 Profile，而清单属于默认 Profile；在命名 Profile 窗口里装卸会装错地方。
    // 这里不需要记任何状态：默认 Profile 窗口的下一轮会按同样的规则重新算出要装卸的扩展。
    if (context.dependencies.environment.inDefaultProfile === false) {
      context.report.extensionsDeferred = true;
      return { kind: 'continue' };
    }
    markTransferring(context);
    const result = requestExtensionChanges(plan.install, plan.uninstall, context.dependencies.onExtensionFailure);
    if (result.installing.length) context.report.extensionsInstalling = result.installing;
    if (result.uninstalling.length) context.report.extensionsUninstalling = result.uninstalling;
    if (result.failed.length) context.report.extensionsFailed = result.failed;
    if (result.installing.length || result.uninstalling.length) context.report.transferredToLocal = true;
    return { kind: 'continue' };
  },
};

/**
 * 记录本轮的基准：下一轮据此判断「本机改没改」与「云端改没改」。
 * 必须在写回之后重新采集，否则写回结果会在下一轮被当成用户改动。
 */
export const finalizeStage: Stage = {
  name: 'finalize',
  async run(context: SyncContext): Promise<StageOutcome> {
    const { adapter, runtimeState } = context.dependencies;
    const restored = context.artifacts.restore;
    const wroteBack = Boolean(restored && restored.changedFiles.length > 0);
    // 写回过本机才重新采集，否则采到的差异只可能是用户在本轮期间的改动；
    // 把它记进基准等于宣布已经同步过，那次改动就再也推不上去了。
    let local = requireValue(context.artifacts.localManifest, 'localManifest');
    if (wroteBack) {
      const before = await adapter.fingerprint();
      local = await adapter.createSnapshot(context.paths.localHostRoot);
      const after = await adapter.fingerprint();
      if (before !== after) return { kind: 'blocked', reason: 'local-changed' };
      context.artifacts.localFingerprint = after;
    }
    await runtimeState.update({
      baseline: await computeBaseline(context, local),
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

/** 基准的两处写入（推送成功后、整轮结束时）必须是同一种算法，否则下一轮会把自己写下的基准判成改动。 */
async function computeBaseline(context: SyncContext, local: SnapshotManifest): Promise<SyncBaseline> {
  const { environment } = context.dependencies;
  const platform = environment.platform ?? process.platform;
  const cloud = await readManifest(context.paths.repositoryHostRoot);
  return {
    localSnapshot: snapshotDigest(local, platform).snapshot,
    cloudSnapshot: snapshotDigest(cloud, platform).snapshot,
    localProfiles: namedProfiles(local).sort((left, right) => left.localeCompare(right)),
    cloudProfiles: namedProfiles(cloud).sort((left, right) => left.localeCompare(right)),
  };
}

/** 还原不做合并：本机扩展整份向历史快照的清单收敛，多的卸载、缺的安装。 */
async function restorePlan(context: SyncContext): Promise<SyncArtifacts['extensionPlan']> {
  const read = (root: string) => fs.readFile(path.join(root, HOST_EXTENSIONS_FILE), 'utf8').catch(() => undefined);
  const target = await read(context.paths.repositoryHostRoot);
  const local = await read(context.paths.localHostRoot);
  // 任一侧没有扩展信息时无从比较，不能当成「全部卸载」。
  if (target === undefined || local === undefined) return undefined;
  const targetIds = parseExtensionIds(target);
  const localIds = parseExtensionIds(local);
  return {
    install: selectMissingExtensionIds(targetIds, localIds),
    uninstall: selectRemovableExtensionIds(localIds, targetIds),
  };
}

async function exists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false);
}

/** 自动同步从真正传配置才亮同步标。点下去的操作一开始就在播报，不必再写一次。 */
function markTransferring(context: SyncContext): void {
  if (context.narrateSteps) return;
  context.dependencies.updateStatus({ transferring: true });
}
