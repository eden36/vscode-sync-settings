import { HostKind } from './types';

export function fallbackCommitMessage(host: HostKind): string {
  return `chore(sync): 同步 ${host === 'cursor' ? 'Cursor' : 'VS Code'} 配置`;
}

export function chooseFallbackSide(oursHash: string | undefined, theirsHash: string | undefined): 'ours' | 'theirs' | undefined {
  if (oursHash) return 'ours';
  if (theirsHash) return 'theirs';
  return undefined;
}
