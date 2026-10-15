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
 * 两侧都改过时交回用户选择；两侧内容一致时无论有没有基准都无需打扰。
 */
export function decideSnapshotChoice(
  baseline: SyncBaseline | undefined,
  local: SnapshotDigest,
  cloud: SnapshotDigest,
  options: { resolution?: 'local' | 'cloud' } = {},
): SnapshotChoice {
  // 两侧内容已经一致就没有可选的：首次建立基准、推送后进程在记下基准前退出、两台机器做了相同改动，都会落到这里。
  if (local.snapshot === cloud.snapshot) return 'none';
  // 首次建立基准（升级、换机器、基准损坏）且两侧不一致，只能由用户定夺。
  if (!baseline) return options.resolution ?? 'conflict';
  const localChanged = local.snapshot !== baseline.localSnapshot;
  const cloudChanged = cloud.snapshot !== baseline.cloudSnapshot;
  if (!localChanged && !cloudChanged) return 'none';
  if (!localChanged) return 'cloud';
  if (!cloudChanged) return 'local';
  return options.resolution ?? 'conflict';
}
