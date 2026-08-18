import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { HOST_EXTENSIONS_FILE, parseExtensionIds } from '../extension-manifest';
import { findPotentialSecrets } from '../secret-scanner';
import { readManifest, snapshotDigest } from '../snapshot-conflict';
import { decideSnapshotChoice } from '../sync-strategy';
import { SnapshotManifest } from '../types';
import { backupConflictSnapshots } from './backup';
import { requireValue, Stage, StageOutcome, SyncContext } from './types';

/**
 * 择一而不是合并：仓库里的内容永远等于某一台机器的完整真实快照。
 * 合并会产出两台机器上都不存在的中间态，配置和扩展清单一旦被拼接就无法验证，
 * 因此两侧都相对基准改过时一律停下来交给用户决定。
 */
export const chooseStage: Stage = {
  name: 'choose',
  async run(context: SyncContext): Promise<StageOutcome> {
    const { conflictBackupRoot, runtimeState } = context.dependencies;
    const { localHostRoot, repositoryHostRoot } = context.paths;
    const strategy = requireValue(context.artifacts.strategy, 'strategy');

    // 首次接入或重建后整包采用云端，本轮不改写仓库内容。
    if (strategy === 'adopt') {
      await backupConflictSnapshots(conflictBackupRoot, localHostRoot, repositoryHostRoot);
      context.artifacts.choice = 'cloud';
      context.report.snapshotChoice = 'cloud';
      return { kind: 'continue' };
    }

    // 备份模式与远端还没有本宿主快照时，本机是仓库内容的唯一来源，没有可比较的另一方。
    const comparable = strategy === 'merge' && requireValue(context.artifacts.remoteExists, 'remoteExists');
    const state = runtimeState.get();
    // 扩展还在装卸时本机清单处于中间态，既不算用户改动，也不能被推上云端。
    const extensionsSettling = (state.extensionsPending?.length ?? 0) > 0;
    let cloudExtensions: string | undefined;
    let cloudExtensionsHash: string | undefined;

    if (comparable) {
      const localManifest = requireValue(context.artifacts.localManifest, 'localManifest');
      const cloudManifest = await readManifest(repositoryHostRoot);
      cloudExtensionsHash = cloudManifest.files[HOST_EXTENSIONS_FILE];
      const choice = decideSnapshotChoice(
        state.baseline,
        snapshotDigest(localManifest),
        snapshotDigest(cloudManifest),
        {
          ignoreExtensions: extensionsSettling,
          ...(context.resolution ? { resolution: context.resolution } : {}),
        },
      );
      if (choice === 'conflict') {
        // 用户可能过很久才做选择，双方内容先各存一份，避免暂停期间本机改动毫无副本。
        await backupConflictSnapshots(conflictBackupRoot, localHostRoot, repositoryHostRoot);
        return {
          kind: 'blocked',
          reason: 'both-changed',
          message: await conflictMessage(context, localManifest, cloudManifest),
        };
      }
      context.artifacts.choice = choice;
      context.report.snapshotChoice = choice;
      context.report.resolvedConflict = context.resolution !== undefined;
      // 采用云端与两侧都没变都不改写仓库，本轮不会产生新的远端提交。
      if (choice !== 'local') return { kind: 'continue' };
      // 仓库目录马上被整份替换，云端那份扩展清单必须先留下来。
      if (extensionsSettling) {
        cloudExtensions = await readOptionalFile(path.join(repositoryHostRoot, HOST_EXTENSIONS_FILE));
      }
    } else {
      context.artifacts.choice = 'local';
      context.report.snapshotChoice = 'local';
    }

    await fs.rm(repositoryHostRoot, { recursive: true, force: true });
    await fs.mkdir(path.dirname(repositoryHostRoot), { recursive: true });
    await fs.cp(localHostRoot, repositoryHostRoot, { recursive: true });
    if (comparable && extensionsSettling) {
      await restoreCloudExtensions(repositoryHostRoot, cloudExtensions, cloudExtensionsHash);
    }

    const manifest = await readManifest(repositoryHostRoot);
    const secrets = await findPotentialSecrets(repositoryHostRoot, manifest);
    if (secrets.length) {
      throw new Error(`检测到可能包含凭据的配置，已拒绝同步：${secrets.join('、')}。请移除其中的凭据，或改写触发检测的键名后重试。`);
    }
    return { kind: 'continue' };
  },
};

/** 把云端原有的扩展清单写回仓库，并同步 manifest 条目；云端本来就没有清单时一并去掉。 */
async function restoreCloudExtensions(
  repositoryHostRoot: string,
  content: string | undefined,
  hash: string | undefined,
): Promise<void> {
  const target = path.join(repositoryHostRoot, HOST_EXTENSIONS_FILE);
  const manifest = await readManifest(repositoryHostRoot);
  if (content === undefined || hash === undefined) {
    await fs.rm(target, { force: true });
    delete manifest.files[HOST_EXTENSIONS_FILE];
  } else {
    await fs.writeFile(target, content, 'utf8');
    manifest.files[HOST_EXTENSIONS_FILE] = hash;
  }
  await fs.writeFile(path.join(repositoryHostRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/** 冲突提示必须给出依据：用户要据此判断丢掉哪一边，尤其是会不会卸掉扩展。 */
async function conflictMessage(
  context: SyncContext,
  local: SnapshotManifest,
  cloud: SnapshotManifest,
): Promise<string> {
  const details: string[] = [];
  const changed = differentFiles(local, cloud);
  if (changed.length) {
    const shown = changed.slice(0, 3).join('、');
    details.push(`差异配置 ${changed.length} 项：${shown}${changed.length > 3 ? ' 等' : ''}`);
  }
  if (local.files[HOST_EXTENSIONS_FILE] !== cloud.files[HOST_EXTENSIONS_FILE]) {
    const localIds = await readExtensionIds(context.paths.localHostRoot);
    const cloudIds = await readExtensionIds(context.paths.repositoryHostRoot);
    const onlyLocal = localIds.filter((id) => !cloudIds.includes(id)).length;
    const onlyCloud = cloudIds.filter((id) => !localIds.includes(id)).length;
    details.push(`扩展：本机独有 ${onlyLocal} 个，云端独有 ${onlyCloud} 个`);
  }
  return `本机与云端都有改动，已暂停同步，请选择以哪一方为准。${details.length ? `（${details.join('；')}）` : ''}`;
}

function differentFiles(local: SnapshotManifest, cloud: SnapshotManifest): string[] {
  const names = new Set([...Object.keys(local.files), ...Object.keys(cloud.files)]);
  const changed: string[] = [];
  for (const relative of names) {
    if (relative === HOST_EXTENSIONS_FILE) continue;
    if (local.files[relative] !== cloud.files[relative]) changed.push(relative);
  }
  return changed.sort((left, right) => left.localeCompare(right));
}

async function readExtensionIds(root: string): Promise<string[]> {
  const content = await readOptionalFile(path.join(root, HOST_EXTENSIONS_FILE));
  return content === undefined ? [] : parseExtensionIds(content);
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  return fs.readFile(filePath, 'utf8').catch(() => undefined);
}
