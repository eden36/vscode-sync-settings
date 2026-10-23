import * as path from 'node:path';
import { HOST_LABELS, HostKind } from './types';

export interface HostStoragePaths {
  userDataPath: string;
  runtimePath: string;
  /** 当前窗口是否运行在默认 Profile；命名 Profile 的 globalStorage 位于 profiles/<目录>/ 之下。 */
  inDefaultProfile: boolean;
}

const HOST_KIND_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const CHANNEL_SUFFIXES = [
  { pattern: /\s+-\s+insiders?$/, id: 'insiders' },
  { pattern: /\s+-\s+nightly$/, id: 'nightly' },
  { pattern: /\s+-\s+exploration$/, id: 'exploration' },
] as const;

/** 新宿主只用规范化全名匹配，避免 Trae / Trae CN 被收成同一个目录。 */
const HOST_ALIASES = new Map<string, HostKind>([
  ['antigravity', 'antigravity'],
  ['antigravity ide', 'antigravity'],
  ['google antigravity', 'antigravity'],
  // 供剥掉通道后缀后的 VS Code 通道版使用；稳定版在已上线规则里精确匹配。
  ['visual studio code', 'vscode'],
]);

export function resolveHostStoragePaths(globalStoragePath: string): HostStoragePaths | undefined {
  const extensionId = path.basename(globalStoragePath);
  const globalStorageRoot = path.dirname(globalStoragePath);
  if (!extensionId || path.basename(globalStorageRoot).toLowerCase() !== 'globalstorage') return undefined;
  const storageParent = path.dirname(globalStorageRoot);
  const profilesRoot = path.dirname(storageParent);
  const inDefaultProfile = path.basename(profilesRoot).toLowerCase() !== 'profiles';
  const userDataPath = inDefaultProfile ? storageParent : path.dirname(profilesRoot);
  if (path.basename(userDataPath).toLowerCase() !== 'user') return undefined;
  return {
    userDataPath,
    runtimePath: path.join(userDataPath, 'globalStorage', extensionId),
    inDefaultProfile,
  };
}

/** 快照清单与仓库目录共用的宿主 id：小写字母开头，只含小写字母、数字和连字符。 */
export function isHostKind(value: string): boolean {
  return HOST_KIND_PATTERN.test(value) && !value.endsWith('-') && !value.includes('--');
}

export function hostLabel(host: HostKind, applicationName?: string): string {
  // 应用名可能恰好是 constructor 之类的原型链键名，只认自有属性。
  return (Object.hasOwn(HOST_LABELS, host) ? HOST_LABELS[host] : undefined) ?? (applicationName?.trim() || host);
}

/**
 * 按应用名识别宿主，得不到合法 id 时返回 undefined。
 * 已上线规则保持原样；其余按别名或 slug 生成独立宿主，不归入 VS Code。
 */
export function resolveHostKind(applicationName: string): HostKind | undefined {
  const name = applicationName.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!name) return undefined;
  if (name.includes('cursor')) return 'cursor';
  if (name.includes('windsurf')) return 'windsurf';
  if (name.includes('vscodium')) return 'vscodium';
  if (name === 'visual studio code') return 'vscode';
  if (name === 'visual studio code - insiders') return 'vscode-insiders';

  const channel = peelChannel(name);
  const base = channel ? name.slice(0, -channel.source.length).trim() : name;
  const baseKind = HOST_ALIASES.get(base) ?? slugifyHostName(base);
  if (!baseKind) return undefined;
  if (!channel) return baseKind;
  const combined = `${baseKind}-${channel.id}`;
  return isHostKind(combined) ? combined : undefined;
}

function peelChannel(name: string): { id: (typeof CHANNEL_SUFFIXES)[number]['id']; source: string } | undefined {
  for (const channel of CHANNEL_SUFFIXES) {
    const match = channel.pattern.exec(name);
    if (match) return { id: channel.id, source: match[0] };
  }
  return undefined;
}

function slugifyHostName(name: string): HostKind | undefined {
  const slug = name.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return isHostKind(slug) ? slug : undefined;
}
