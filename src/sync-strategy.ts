import { PullState } from './git-service';

export type CloudAdoptDecision = 'adopt' | 'seed-local' | 'merge' | 'missing-cloud';

/** 重建或首次接入必须整包采用云端；缺云端快照时禁止把本机推上去。 */
export function decideCloudAdopt(adoptCloud: boolean, pullState: PullState, remoteExists: boolean): CloudAdoptDecision {
  if (adoptCloud) return remoteExists ? 'adopt' : 'missing-cloud';
  if (pullState === 'cloned') return remoteExists ? 'adopt' : 'seed-local';
  return 'merge';
}
