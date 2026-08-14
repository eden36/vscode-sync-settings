import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { HostKind, SnapshotManifest } from './types';

export type ThreeWayChoice = 'local' | 'cloud' | 'conflict';

export interface SnapshotStructure {
  profiles: SnapshotManifest['profiles'];
  profileMetadata?: SnapshotManifest['profileMetadata'];
  profileAssociations?: unknown;
}

/**
 * 三方比较的唯一判定入口：冲突检测与实际合并必须共用，避免两处规则出现分歧。
 * 取值可为 undefined，表示该版本中文件不存在。
 */
export function classifyThreeWay(base: string | undefined, local: string | undefined, cloud: string | undefined): ThreeWayChoice {
  if (local === base) return 'cloud';
  if (cloud === base || local === cloud) return 'local';
  return 'conflict';
}

export function snapshotStructure(manifest: SnapshotManifest): SnapshotStructure {
  return {
    profiles: manifest.profiles,
    ...(manifest.profileMetadata !== undefined ? { profileMetadata: manifest.profileMetadata } : {}),
    ...(manifest.profileAssociations !== undefined ? { profileAssociations: manifest.profileAssociations } : {}),
  };
}

export function emptyManifest(host: HostKind): SnapshotManifest {
  return { schemaVersion: 1, host, createdAt: '', profiles: [], files: {} };
}

export async function readManifest(root: string): Promise<SnapshotManifest> {
  return JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8')) as SnapshotManifest;
}

export async function detectSnapshotConflicts(
  baseRoot: string | undefined,
  localRoot: string,
  cloudRoot: string,
  host: HostKind,
): Promise<string[]> {
  const base = baseRoot ? await readManifest(baseRoot) : emptyManifest(host);
  const local = await readManifest(localRoot);
  const cloud = await readManifest(cloudRoot);
  const conflicts: string[] = [];
  for (const relative of new Set([...Object.keys(base.files), ...Object.keys(local.files), ...Object.keys(cloud.files)])) {
    if (classifyThreeWay(base.files[relative], local.files[relative], cloud.files[relative]) === 'conflict') {
      conflicts.push(relative);
    }
  }
  const structure = classifyThreeWay(
    JSON.stringify(snapshotStructure(base)),
    JSON.stringify(snapshotStructure(local)),
    JSON.stringify(snapshotStructure(cloud)),
  );
  if (structure === 'conflict') conflicts.push('Profile 结构和关联关系');
  return conflicts;
}
