import { HostKind } from './types';

export function fallbackCommitMessage(host: HostKind): string {
  return `chore(sync): 同步 ${host === 'cursor' ? 'Cursor' : 'VS Code'} 配置`;
}
