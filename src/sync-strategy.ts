import { PullState } from './git-service';
import { SnapshotDigest } from './snapshot-conflict';
import { SnapshotChoice, SyncBaseline, SyncMode } from './types';

export type CloudAdoptDecision = 'adopt' | 'seed-local' | 'merge' | 'missing-cloud' | 'backup';

/** 重建或首次接入必须整包采用云端；缺云端快照时禁止把本机推上去。 */
export function decideCloudAdopt(
  mode: SyncMode,
  adoptCloud: boolean,
  pullState: PullState,
  remoteExists: boolean,
): CloudAdoptDecision {
  // 备份模式只上传本机快照，既不合并也不采用云端，云端是否已有快照都不改变行为。
  if (mode === 'backup') return 'backup';
  if (adoptCloud) return remoteExists ? 'adopt' : 'missing-cloud';
  if (pullState === 'cloned') return remoteExists ? 'adopt' : 'seed-local';
  return 'merge';
}

/**
 * 本轮采用哪一方的完整快照。不做任何内容合并：结果永远等于某一台机器的真实状态。
 * 判据是「相对上次成功同步的基准改没改」，而不是拉取成功与否——拉取失败只是让两边同时改动更容易发生。
 * 两侧都改过时交回用户选择，没有基准时若两侧内容一致同样无需打扰。
 */
export function decideSnapshotChoice(
  baseline: SyncBaseline | undefined,
  local: SnapshotDigest,
  cloud: SnapshotDigest,
  options: { ignoreExtensions: boolean; resolution?: 'local' | 'cloud' },
): SnapshotChoice {
  if (!baseline) {
    // 首次建立基准（升级、换机器、基准损坏）：两侧一致就直接立基准，不一致只能由用户定夺。
    if (local.snapshot === cloud.snapshot && local.extensions === cloud.extensions) return 'none';
    return options.resolution ?? 'conflict';
  }
  const localChanged = changed(local, baseline.localSnapshot, baseline.localExtensions, options.ignoreExtensions);
  const cloudChanged = changed(cloud, baseline.cloudSnapshot, baseline.cloudExtensions, options.ignoreExtensions);
  if (!localChanged && !cloudChanged) return 'none';
  if (!localChanged) return 'cloud';
  if (!cloudChanged) return 'local';
  return options.resolution ?? 'conflict';
}

/** 扩展装卸需要时间，收敛过程中的清单变化不是用户改动，不能据此判定这一侧改过。 */
function changed(digest: SnapshotDigest, snapshot: string, extensions: string, ignoreExtensions: boolean): boolean {
  if (digest.snapshot !== snapshot) return true;
  return !ignoreExtensions && digest.extensions !== extensions;
}
