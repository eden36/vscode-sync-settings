import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { findPotentialSecrets } from '../secret-scanner';
import { readManifest } from '../snapshot-conflict';
import { applyStage, extensionsStage, prepareStage, pullStage, pushStage } from './stages';
import { requireValue, Stage, StageOutcome, SyncContext } from './types';

const COMMIT_SUBJECT_LIMIT = 120;

/** 把所选历史提交里的本宿主快照换进仓库工作区；写回本机之前先做完全部校验。 */
const exportHistoryStage: Stage = {
  name: 'export-history',
  async run(context: SyncContext): Promise<StageOutcome> {
    const { git, adapter, environment, windowSafety } = context.dependencies;
    const { repositoryHostRoot, temporaryRoot } = context.paths;
    const target = requireValue(context.restoreTarget, 'restoreTarget');

    // 先导出到临时目录：导出或校验失败时仓库工作区仍然完整，本机也没被动过。
    const historyRoot = path.join(temporaryRoot, 'history');
    if (!(await git.exportHostTree(target.hash, environment.kind, historyRoot))) {
      throw new Error('所选提交中没有本宿主的配置快照，无法还原。');
    }
    const manifest = await readManifest(historyRoot);
    if (manifest.host !== environment.kind) throw new Error('所选提交的快照属于其他宿主类型，无法还原。');

    const secretFiles = await findPotentialSecrets(historyRoot, manifest);
    if (secretFiles.length) throw new Error(`检测到可能包含凭据的配置，已拒绝还原：${secretFiles.join('、')}`);

    // Profile 增删只有在单窗口时才能写入本机；提前判定，避免推送出本机并未应用的状态。
    const localIds = new Set((await adapter.listProfiles()).map((profile) => profile.id));
    const historyIds = new Set(manifest.profiles.map((profile) => profile.id));
    if (!setsEqual(localIds, historyIds) && (await windowSafety()).activeWindows > 1) {
      return {
        kind: 'blocked',
        reason: 'other-windows',
        message: '历史快照包含 Profile 增删，需要只剩一个窗口才能还原。关闭其他窗口后请重新执行还原。',
      };
    }

    const subject = target.subject.slice(0, COMMIT_SUBJECT_LIMIT);
    context.artifacts.commitMessage = subject ? `还原到 ${target.shortHash}：${subject}` : `还原到 ${target.shortHash}`;

    await fs.rm(repositoryHostRoot, { recursive: true, force: true });
    await fs.mkdir(path.dirname(repositoryHostRoot), { recursive: true });
    await fs.cp(historyRoot, repositoryHostRoot, { recursive: true });
    return { kind: 'continue' };
  },
};

/** 与同步流程相反：还原先写回本机，确认落地后才推送，否则云端会记下本机没有应用的状态。 */
const restorePushStage: Stage = {
  name: 'push',
  async run(context: SyncContext): Promise<StageOutcome> {
    if (context.report.waitingForWindows) {
      return {
        kind: 'blocked',
        reason: 'other-windows',
        message: '本机 Profile 结构未能应用，已放弃推送，请关闭其他窗口后重新还原。',
      };
    }
    return pushStage.run(context);
  },
};

/** 还原流程：对齐远端 → 导出历史快照 → 写回本机与扩展 → 在远端 tip 上追加一条新提交。 */
export const RESTORE_STAGES: Stage[] = [
  prepareStage,
  pullStage,
  exportHistoryStage,
  applyStage,
  extensionsStage,
  restorePushStage,
];

export const testing = { exportHistoryStage, restorePushStage };

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}
