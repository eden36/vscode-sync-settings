import * as path from 'node:path';
import { HostKind } from './types';

export interface HostStoragePaths {
  userDataPath: string;
  runtimePath: string;
  /** 当前窗口是否运行在默认 Profile；命名 Profile 的 globalStorage 位于 profiles/<目录>/ 之下。 */
  inDefaultProfile: boolean;
}

export function resolveHostStoragePaths(globalStoragePath: string): HostStoragePaths {
  const extensionId = path.basename(globalStoragePath);
  const globalStorageRoot = path.dirname(globalStoragePath);
  const storageParent = path.dirname(globalStorageRoot);
  const profilesRoot = path.dirname(storageParent);
  const inDefaultProfile = path.basename(profilesRoot).toLowerCase() !== 'profiles';
  const userDataPath = inDefaultProfile ? storageParent : path.dirname(profilesRoot);
  return {
    userDataPath,
    runtimePath: path.join(userDataPath, 'globalStorage', extensionId),
    inDefaultProfile,
  };
}

/**
 * 按应用名识别宿主，认不出时返回 undefined。
 * 不能把未知宿主归入 VS Code：各家扩展市场不同，共用一份快照会互相覆盖并反复装卸扩展。
 */
export function resolveHostKind(applicationName: string): HostKind | undefined {
  const name = applicationName.trim().toLowerCase();
  if (name.includes('cursor')) return 'cursor';
  if (name.includes('windsurf')) return 'windsurf';
  if (name.includes('vscodium')) return 'vscodium';
  if (name === 'visual studio code') return 'vscode';
  if (name === 'visual studio code - insiders') return 'vscode-insiders';
  return undefined;
}
