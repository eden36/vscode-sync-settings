import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { formatExtensionManifest, HOST_EXTENSIONS_FILE, parseExtensionIds, planExtensionSync } from '../extension-manifest';
import { findPotentialSecrets } from '../secret-scanner';
import { profileMismatchText } from '../sidebar-status';
import { isOtherPlatformFile, namedProfiles, readManifest, snapshotDigest } from '../snapshot-conflict';
import { decideSnapshotChoice } from '../sync-strategy';
import { ProfileMismatch, SnapshotManifest } from '../types';
import { backupConflictSnapshots } from './backup';
import { requireValue, Stage, StageOutcome, SyncContext, windowBlock } from './types';

/**
 * 配置文件择一而不是合并：仓库里的配置永远等于某一台机器的完整真实快照。
 * 合并会产出两台机器上都不存在的中间态，配置一旦被拼接就无法验证，
 * 因此两侧都相对基准改过时一律停下来交给用户决定。
 * 扩展清单是唯一的例外：同步模式下按增删合并（mergeExtensions），不参与择一；备份模式仍整份覆盖。
 */
export const chooseStage: Stage = {
  name: 'choose',
  async run(context: SyncContext): Promise<StageOutcome> {
    const { conflictBackupRoot, runtimeState, environment } = context.dependencies;
    const { localHostRoot, repositoryHostRoot } = context.paths;
    const strategy = requireValue(context.artifacts.strategy, 'strategy');
    const platform = environment.platform ?? process.platform;
    // 采用本机时仓库目录会被整份替换，云端扩展清单要先读出来。
    const cloudExtensions = await readOptionalFile(path.join(repositoryHostRoot, HOST_EXTENSIONS_FILE));

    // 首次接入或重建后整包采用云端，配置不改写仓库内容。
    if (strategy === 'adopt') {
      await backupConflictSnapshots(conflictBackupRoot, localHostRoot, repositoryHostRoot);
      context.artifacts.choice = 'cloud';
      context.report.snapshotChoice = 'cloud';
      await mergeExtensions(context, cloudExtensions);
      return { kind: 'continue' };
    }

    // 备份模式与远端还没有本宿主快照时，本机是仓库内容的唯一来源，没有可比较的另一方。
    const comparable = strategy === 'merge' && requireValue(context.artifacts.remoteExists, 'remoteExists');
    const state = runtimeState.get();
    // 仓库目录马上被本机快照整份替换，这些云端条目要先留下来；值为 undefined 表示云端本来就没有。
    const preserved = new Map<string, Buffer | undefined>();

    if (comparable) {
      const reconciled = await reconcileProfiles(context, await readManifest(repositoryHostRoot));
      if ('blocked' in reconciled) return reconciled.blocked;
      const { cloudManifest, dropped } = reconciled;
      const localManifest = requireValue(context.artifacts.localManifest, 'localManifest');
      const choice = decideSnapshotChoice(
        state.baseline,
        snapshotDigest(localManifest, platform),
        snapshotDigest(cloudManifest, platform),
        context.resolution ? { resolution: context.resolution } : {},
      );
      if (choice === 'conflict') {
        // 用户可能过很久才做选择，双方内容先各存一份，避免暂停期间本机改动毫无副本。
        await backupConflictSnapshots(conflictBackupRoot, localHostRoot, repositoryHostRoot);
        return { kind: 'blocked', reason: 'both-changed', message: conflictMessage(localManifest, cloudManifest, platform) };
      }
      context.artifacts.choice = choice;
      context.report.snapshotChoice = choice;
      context.report.resolvedConflict = context.resolution !== undefined;
      // 采用本机时整份推送本身就会去掉这些 Profile；否则要单独提交这次删除。
      if (dropped.length && choice !== 'local') context.artifacts.commitMessage = `从云端删除 Profile：${dropped.join('、')}`;
      // 采用云端与两侧都没变都不改写配置，只有扩展清单可能因合并而变化。
      if (choice !== 'local') {
        await mergeExtensions(context, cloudExtensions);
        return { kind: 'continue' };
      }

      // 其他平台的快捷键本机既不写回也不采集，推送本机快照时必须原样保留，否则会把另一平台的快捷键删掉。
      const localIds = new Set(localManifest.profiles.map((profile) => profile.id));
      for (const relative of Object.keys(cloudManifest.files)) {
        if (!isOtherPlatformFile(relative, platform) || !localIds.has(relative.split('/')[1] ?? '')) continue;
        preserved.set(relative, await readOptionalFile(path.join(repositoryHostRoot, ...relative.split('/'))));
      }
    } else {
      context.artifacts.choice = 'local';
      context.report.snapshotChoice = 'local';
    }

    // 保留项要在仓库目录被替换之前读出来，因此先收集到内存再写回。
    const cloudHashes = preserved.size ? (await readManifest(repositoryHostRoot)).files : {};
    await fs.rm(repositoryHostRoot, { recursive: true, force: true });
    await fs.mkdir(path.dirname(repositoryHostRoot), { recursive: true });
    await fs.cp(localHostRoot, repositoryHostRoot, { recursive: true });
    if (preserved.size) await restoreCloudFiles(repositoryHostRoot, preserved, cloudHashes);
    // 备份模式按约定用本机清单整份覆盖，不合并。
    if (strategy !== 'backup') await mergeExtensions(context, cloudExtensions);

    const manifest = await readManifest(repositoryHostRoot);
    const secrets = await findPotentialSecrets(repositoryHostRoot, manifest);
    if (secrets.length) {
      throw new Error(`检测到可能包含凭据的配置，已拒绝同步：${secrets.join('、')}。请移除其中的凭据，或改写触发检测的键名后重试。`);
    }
    return { kind: 'continue' };
  },
};

/**
 * 处理两侧命名 Profile 集合的差异。插件不新建、也不删除本机 Profile（理由见 ProfileAdapter.restoreSnapshot），
 * 能从基准判断出来源的差异随正常的择一流程传播，判断不了或需要用户动手的交给用户：
 * - 云端有、本机没有：基准里本机有的，是本机删掉的，随本机推送传播；其余的由用户新建同名 Profile，或确认从云端删除。
 * - 本机有、云端没有：基准里两侧都有的，是云端删掉的，由用户在本机删除，或确认保留；其余是本机新建的，随推送上云。
 * 用户新建的、云端早已有的 Profile 先套用云端内容，否则它的空配置会被当成本机改动推上去覆盖云端。
 */
async function reconcileProfiles(
  context: SyncContext,
  cloudManifest: SnapshotManifest,
): Promise<{ blocked: StageOutcome } | { cloudManifest: SnapshotManifest; dropped: string[] }> {
  const { adapter, runtimeState, windowSafety, conflictBackupRoot } = context.dependencies;
  const { localHostRoot, repositoryHostRoot } = context.paths;
  const state = runtimeState.get();
  const baselineLocal = state.baseline?.localProfiles ? new Set(state.baseline.localProfiles) : undefined;
  const baselineCloud = state.baseline?.cloudProfiles ? new Set(state.baseline.cloudProfiles) : undefined;
  const cloudNames = new Set(namedProfiles(cloudManifest));
  let localNames = new Set(namedProfiles(requireValue(context.artifacts.localManifest, 'localManifest')));

  const announced = new Set([
    ...(state.baseline?.cloudProfiles ?? []),
    ...(state.profileMismatch?.kind === 'cloud-only' ? state.profileMismatch.names : []),
  ]);
  const claimed = [...localNames].filter((name) => cloudNames.has(name) && announced.has(name) && !baselineLocal?.has(name));
  if (claimed.length) {
    const blocked = windowBlock(await windowSafety());
    if (blocked) return { blocked };
    if (await adapter.fingerprint() !== context.artifacts.localFingerprint) {
      return { blocked: { kind: 'blocked', reason: 'local-changed' } };
    }
    await backupConflictSnapshots(conflictBackupRoot, localHostRoot, repositoryHostRoot);
    await adapter.restoreSnapshot(repositoryHostRoot, { profileNames: new Set(claimed) });
    // 本机刚被写过，后面的判定与写回前的二次确认都要以写入后的状态为准。
    const before = await adapter.fingerprint();
    context.artifacts.localManifest = await adapter.createSnapshot(localHostRoot);
    context.artifacts.localFingerprint = await adapter.fingerprint();
    if (before !== context.artifacts.localFingerprint) {
      return { blocked: { kind: 'blocked', reason: 'local-changed' } };
    }
    localNames = new Set(namedProfiles(context.artifacts.localManifest));
    context.report.profileMessage = `已为本机新建的 Profile 套用云端配置：${claimed.join('、')}`;
  }

  const resolution = state.profileResolution;
  const cloudOnly = [...cloudNames].filter((name) => !localNames.has(name) && !baselineLocal?.has(name));
  const dropped = resolution?.kind === 'cloud-only' ? cloudOnly.filter((name) => resolution.names.includes(name)) : [];
  const undecidedCloudOnly = cloudOnly.filter((name) => !dropped.includes(name));
  if (undecidedCloudOnly.length) return { blocked: await blockForProfiles(context, { kind: 'cloud-only', names: undecidedCloudOnly }) };

  const deletedInCloud = [...localNames].filter((name) => !cloudNames.has(name) && baselineCloud?.has(name) && baselineLocal?.has(name));
  const kept = resolution?.kind === 'deleted-in-cloud' ? resolution.names : [];
  const undecidedDeleted = deletedInCloud.filter((name) => !kept.includes(name));
  if (undecidedDeleted.length) return { blocked: await blockForProfiles(context, { kind: 'deleted-in-cloud', names: undecidedDeleted }) };

  if (state.profileMismatch) await runtimeState.update({ profileMismatch: undefined });
  if (!dropped.length) return { cloudManifest, dropped };
  return { cloudManifest: await removeCloudProfiles(repositoryHostRoot, cloudManifest, new Set(dropped)), dropped };
}

/** 记下待处理的差异，供界面展示与随后认领用户新建的同名 Profile。 */
async function blockForProfiles(context: SyncContext, mismatch: ProfileMismatch): Promise<StageOutcome> {
  await context.dependencies.runtimeState.update({ profileMismatch: mismatch });
  return { kind: 'blocked', reason: 'profiles-mismatch', message: profileMismatchText(mismatch).summary };
}

/** 从仓库工作区的云端快照里去掉指定名称的 Profile，同时改写清单。只改工作区，提交由推送步骤完成。 */
async function removeCloudProfiles(root: string, manifest: SnapshotManifest, names: Set<string>): Promise<SnapshotManifest> {
  const ids = manifest.profiles.filter((profile) => !profile.isDefault && names.has(profile.name)).map((profile) => profile.id);
  const files = { ...manifest.files };
  for (const id of ids) {
    // id 来自远端清单，不可信，拼路径前必须确认它只是一个目录名。
    if (!id || id === '.' || id === '..' || /[\\/]/.test(id)) throw new Error(`快照包含非法的 Profile 标识：${id}`);
    await fs.rm(path.join(root, 'profiles', id), { recursive: true, force: true });
    for (const relative of Object.keys(files)) {
      if (relative.startsWith(`profiles/${id}/`)) delete files[relative];
    }
  }
  const next: SnapshotManifest = { ...manifest, profiles: manifest.profiles.filter((profile) => !ids.includes(profile.id)), files };
  await fs.writeFile(path.join(root, 'manifest.json'), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/** 把云端原有的条目写回仓库，并同步 manifest；云端本来就没有的条目一并去掉。 */
export async function restoreCloudFiles(
  repositoryHostRoot: string,
  preserved: Map<string, Buffer | undefined>,
  cloudHashes: Record<string, string>,
): Promise<void> {
  const manifest = await readManifest(repositoryHostRoot);
  for (const [relative, content] of preserved) {
    const target = path.join(repositoryHostRoot, ...relative.split('/'));
    const hash = cloudHashes[relative];
    if (content === undefined || hash === undefined) {
      await fs.rm(target, { force: true });
      delete manifest.files[relative];
    } else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
      manifest.files[relative] = hash;
    }
  }
  await fs.writeFile(path.join(repositoryHostRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/**
 * 把本机相对上次同步的扩展增删合并进仓库工作区的云端清单，并记下本机要装卸的扩展。
 * 本机采集不到扩展信息（开发宿主）时云端清单原样保留，不能把「不知道」当成「全卸了」。
 */
async function mergeExtensions(context: SyncContext, cloudContent: Buffer | undefined): Promise<void> {
  const { localHostRoot, repositoryHostRoot } = context.paths;
  const localContent = await readOptionalFile(path.join(localHostRoot, HOST_EXTENSIONS_FILE));
  if (localContent === undefined) {
    await writeExtensionManifest(context, cloudContent);
    return;
  }
  const local = parseExtensionIds(localContent.toString('utf8'));
  // 云端还没有扩展信息时以本机为准，避免合并出一份空清单。
  const cloud = cloudContent === undefined ? local : parseExtensionIds(cloudContent.toString('utf8'));
  const plan = planExtensionSync(local, cloud, context.dependencies.runtimeState.get().syncedExtensions);
  context.artifacts.extensionPlan = { install: plan.install, uninstall: plan.uninstall };
  await writeExtensionManifest(context, Buffer.from(formatExtensionManifest(plan.merged), 'utf8'));
}

/** 写入仓库工作区的扩展清单并同步 manifest；内容没变时不动文件，避免产生无意义的提交。 */
async function writeExtensionManifest(context: SyncContext, content: Buffer | undefined): Promise<void> {
  const root = context.paths.repositoryHostRoot;
  const manifest = await readManifest(root);
  const hash = content === undefined ? undefined : createHash('sha256').update(content).digest('hex');
  if (manifest.files[HOST_EXTENSIONS_FILE] === hash) return;
  const target = path.join(root, HOST_EXTENSIONS_FILE);
  if (content === undefined || hash === undefined) {
    await fs.rm(target, { force: true });
    delete manifest.files[HOST_EXTENSIONS_FILE];
  } else {
    await fs.writeFile(target, content);
    manifest.files[HOST_EXTENSIONS_FILE] = hash;
  }
  await fs.writeFile(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  context.artifacts.extensionsMerged = true;
}

/** 冲突提示必须给出依据：用户要据此判断丢掉哪一边。 */
function conflictMessage(local: SnapshotManifest, cloud: SnapshotManifest, platform: string): string {
  const changed = differentFiles(local, cloud, platform);
  const detail = changed.length
    ? `（差异配置 ${changed.length} 项：${changed.slice(0, 3).join('、')}${changed.length > 3 ? ' 等' : ''}）`
    : '';
  return `本机与云端都有改动，已暂停同步，请选择以哪一方为准。${detail}`;
}

function differentFiles(local: SnapshotManifest, cloud: SnapshotManifest, platform: string): string[] {
  const names = new Set([...Object.keys(local.files), ...Object.keys(cloud.files)]);
  const changed: string[] = [];
  for (const relative of names) {
    if (relative === HOST_EXTENSIONS_FILE || isOtherPlatformFile(relative, platform)) continue;
    if (local.files[relative] !== cloud.files[relative]) changed.push(relative);
  }
  return changed.sort((left, right) => left.localeCompare(right));
}

async function readOptionalFile(filePath: string): Promise<Buffer | undefined> {
  return fs.readFile(filePath).catch(() => undefined);
}
