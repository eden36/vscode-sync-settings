import { hostLabel } from './host-paths';
import { HostKind } from './types';

export function fallbackCommitMessage(host: HostKind, applicationName?: string): string {
  return `chore(sync): 同步 ${hostLabel(host, applicationName)} 配置`;
}
