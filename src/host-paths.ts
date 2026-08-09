import * as path from 'node:path';

export interface HostStoragePaths {
  userDataPath: string;
  runtimePath: string;
}

export function resolveHostStoragePaths(globalStoragePath: string): HostStoragePaths {
  const extensionId = path.basename(globalStoragePath);
  const globalStorageRoot = path.dirname(globalStoragePath);
  const storageParent = path.dirname(globalStorageRoot);
  const profilesRoot = path.dirname(storageParent);
  const userDataPath = path.basename(profilesRoot).toLowerCase() === 'profiles'
    ? path.dirname(profilesRoot)
    : storageParent;
  return {
    userDataPath,
    runtimePath: path.join(userDataPath, 'globalStorage', extensionId),
  };
}
