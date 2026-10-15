import { HOST_LABELS, HostKind } from './types';

export function fallbackCommitMessage(host: HostKind): string {
  return `chore(sync): 同步 ${HOST_LABELS[host]} 配置`;
}
