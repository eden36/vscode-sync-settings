import { PullState } from './git-service';
import { SyncMode } from './types';

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
