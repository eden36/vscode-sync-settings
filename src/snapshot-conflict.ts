import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { HOST_EXTENSIONS_FILE } from './extension-manifest';
import { isHostKind } from './host-paths';
import { SnapshotManifest } from './types';

const PLATFORM_KEYBINDINGS = /^profiles\/[^/]+\/keybindings\.([^/.]+)\.json$/;

/** 一份快照的可比较部分。扩展清单不参与择一，按增删单独合并。 */
export interface SnapshotDigest {
  snapshot: string;
}

/**
 * 快照指纹：判断某一侧相对基准改没改的唯一依据。
 * 键序归一后再哈希——两台机器写出的元数据键序可能不同，内容其实一样，
 * 不归一就会被判成改动，导致整份覆盖和无意义的来回提交。
 * 其他平台的快捷键不参与比较：本机既不会写回、也不会改动它们，算进来会让两侧永远不一致。
 */
export function snapshotDigest(manifest: SnapshotManifest, platform: string): SnapshotDigest {
  const files = Object.entries(manifest.files)
    .filter(([relative]) => relative !== HOST_EXTENSIONS_FILE && !isOtherPlatformFile(relative, platform))
    .sort(([left], [right]) => left.localeCompare(right));
  const canonical = canonicalize({
    profiles: manifest.profiles,
    ...(manifest.profileMetadata !== undefined ? { profileMetadata: manifest.profileMetadata } : {}),
    files: Object.fromEntries(files),
  });
  return { snapshot: createHash('sha256').update(JSON.stringify(canonical)).digest('hex') };
}

/** 按平台分开存放的快捷键里，属于其他平台的那几份。 */
export function isOtherPlatformFile(relative: string, platform: string): boolean {
  const match = PLATFORM_KEYBINDINGS.exec(relative);
  return match !== null && match[1] !== platform;
}

/** 命名 Profile 的名称；默认 Profile 两侧都一定存在，不参与 Profile 集合的比较。 */
export function namedProfiles(manifest: SnapshotManifest): string[] {
  return manifest.profiles.filter((profile) => !profile.isDefault).map((profile) => profile.name);
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
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2)) return undefined;
  if (typeof value.host !== 'string' || !isHostKind(value.host)) return undefined;
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
    schemaVersion: value.schemaVersion,
    host: value.host as SnapshotManifest['host'],
    createdAt: value.createdAt,
    profiles: profiles as SnapshotManifest['profiles'],
    files: value.files as Record<string, string>,
    ...(value.profileMetadata !== undefined
      ? { profileMetadata: value.profileMetadata as Array<Record<string, unknown>> }
      : {}),
  };
}

/** 递归按键排序，使语义相同、键序不同的两份数据得到同一个指纹。 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right))) {
    sorted[key] = canonicalize(value[key]);
  }
  return sorted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
