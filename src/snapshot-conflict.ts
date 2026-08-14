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

/**
 * AI 合并不可用时的确定性回退：本机版本存在就保留本机，否则采用云端，
 * 保证任一冲突都能收敛到实际存在的一份内容。
 */
export function resolveConflictFallback(local: string | undefined, cloud: string | undefined): 'local' | 'cloud' {
  if (local !== undefined) return 'local';
  if (cloud !== undefined) return 'cloud';
  throw new Error('冲突双方均不存在内容，无法自动合并。');
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
