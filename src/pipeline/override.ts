import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { HOST_EXTENSIONS_FILE } from '../extension-manifest';
import { findPotentialSecrets } from '../secret-scanner';
import { isOtherPlatformFile, readManifest } from '../snapshot-conflict';
import { restoreCloudFiles } from './choose';
import { finalizeStage, prepareStage, pullStage, pushStage, scanSecretsStage, snapshotStage } from './stages';
import { requireValue, Stage, StageOutcome, SyncContext } from './types';

const COMMIT_MESSAGE = '以本机覆盖云端';

/** 用本机快照整份替换仓库工作区里的本宿主目录，不与云端比较、不询问；后续按采用本机推送。 */
const overrideCloudStage: Stage = {
  name: 'override-cloud',
  async run(context: SyncContext): Promise<StageOutcome> {
    const { environment, runtimeState } = context.dependencies;
    const { localHostRoot, repositoryHostRoot } = context.paths;
    const platform = environment.platform ?? process.platform;
    const localManifest = requireValue(context.artifacts.localManifest, 'localManifest');
    const localExtensions = await fs.access(path.join(localHostRoot, HOST_EXTENSIONS_FILE)).then(() => true, () => false);

    // 仓库目录马上被本机快照整份替换，这些云端条目要先留下来。
    const preserved = new Map<string, Buffer | undefined>();
    let cloudHashes: Record<string, string> = {};
    if (await fs.access(path.join(repositoryHostRoot, 'manifest.json')).then(() => true, () => false)) {
      const cloudManifest = await readManifest(repositoryHostRoot);
      cloudHashes = cloudManifest.files;
      // 其他平台的快捷键属于别的机器，本机既不采集也不写回，覆盖时原样保留（仅限本机也有的 Profile）。
      const localIds = new Set(localManifest.profiles.map((profile) => profile.id));
      for (const relative of Object.keys(cloudManifest.files)) {
        if (isOtherPlatformFile(relative, platform) && localIds.has(relative.split('/')[1] ?? '')) preserved.set(relative, undefined);
      }
      // 本机采集不到扩展信息（开发宿主）时保留云端清单，不能把「不知道」当成「全卸了」。
      if (!localExtensions) preserved.set(HOST_EXTENSIONS_FILE, undefined);
      for (const relative of preserved.keys()) {
        preserved.set(relative, await fs.readFile(path.join(repositoryHostRoot, ...relative.split('/'))).catch(() => undefined));
      }
    }

    await fs.rm(repositoryHostRoot, { recursive: true, force: true });
    await fs.mkdir(path.dirname(repositoryHostRoot), { recursive: true });
    await fs.cp(localHostRoot, repositoryHostRoot, { recursive: true });
    if (preserved.size) await restoreCloudFiles(repositoryHostRoot, preserved, cloudHashes);

    const secrets = await findPotentialSecrets(repositoryHostRoot, await readManifest(repositoryHostRoot));
    if (secrets.length) {
      throw new Error(`检测到可能包含凭据的配置，已拒绝覆盖云端：${secrets.join('、')}。请移除其中的凭据，或改写触发检测的键名后重试。`);
    }

    context.artifacts.commitMessage = COMMIT_MESSAGE;
    context.artifacts.choice = 'local';
    context.report.snapshotChoice = 'local';
    // 云端此刻就是本机的内容：待处理的 Profile 差异与「采用云端」标记都已失去意义，留着会让下一轮误以为要整包覆盖本机。
    await runtimeState.update({ profileMismatch: undefined, cloudAdoptPending: false });
    return { kind: 'continue' };
  },
};

/**
 * 以本机覆盖云端：采集本机 → 凭据扫描 → 对齐远端 → 整份替换仓库目录 → 追加一条新提交并推送 → 记录基准。
 * 只追加提交、不 force push，被覆盖的内容仍可从云端提交历史还原；不写回本机，因此没有 apply 与 extensions。
 */
export const OVERRIDE_STAGES: Stage[] = [
  snapshotStage,
  scanSecretsStage,
  prepareStage,
  pullStage,
  overrideCloudStage,
  pushStage,
  finalizeStage,
];

export const testing = { overrideCloudStage };
