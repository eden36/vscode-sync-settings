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

/** 快照清单可能来自远端仓库，必须校验后再使用，否则字段缺失会以难以定位的运行时错误暴露。 */
export async function readManifest(root: string): Promise<SnapshotManifest> {
  const content = await fs.readFile(path.join(root, 'manifest.json'), 'utf8').catch(() => undefined);
  if (content === undefined) throw new Error('未找到快照清单，无法继续同步。');
  let raw: unknown;
  try {
    raw = JSON.parse(content) as unknown;
  } catch {
    // 裸 SyntaxError 是英文的，且不说明是哪一份数据出了问题。
    throw new Error('快照清单不是有效的 JSON，无法继续同步。');
  }
  const parsed = parseManifest(raw);
  if (!parsed) throw new Error('快照清单格式无效，无法继续同步。');
  return parsed;
}

export function parseManifest(value: unknown): SnapshotManifest | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) return undefined;
  if (value.host !== 'vscode' && value.host !== 'cursor') return undefined;
  if (typeof value.createdAt !== 'string') return undefined;
  if (!Array.isArray(value.profiles)) return undefined;
  const profiles = value.profiles.map((profile) => {
    if (!isRecord(profile) || typeof profile.id !== 'string' || !profile.id) return undefined;
    if (typeof profile.name !== 'string' || typeof profile.isDefault !== 'boolean') return undefined;
    return { id: profile.id, name: profile.name, isDefault: profile.isDefault };
  });
  if (profiles.some((profile) => profile === undefined)) return undefined;
  if (!isRecord(value.files) || Object.values(value.files).some((hash) => typeof hash !== 'string')) return undefined;
  if (value.profileMetadata !== undefined && !Array.isArray(value.profileMetadata)) return undefined;
  if (value.profileMetadata?.some((entry: unknown) => !isRecord(entry))) return undefined;
  return {
    schemaVersion: 1,
    host: value.host,
    createdAt: value.createdAt,
    profiles: profiles as SnapshotManifest['profiles'],
    files: value.files as Record<string, string>,
    ...(value.profileMetadata !== undefined
      ? { profileMetadata: value.profileMetadata as Array<Record<string, unknown>> }
      : {}),
    ...(value.profileAssociations !== undefined ? { profileAssociations: value.profileAssociations } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
