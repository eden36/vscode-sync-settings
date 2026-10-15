/** 宿主级的已安装扩展清单，放在快照根目录，不属于任何 Profile。 */
export const HOST_EXTENSIONS_FILE = 'extensions.json';

export function parseExtensionIds(content: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const ids: string[] = [];
  for (const item of parsed) {
    const id = (item as { identifier?: { id?: unknown } })?.identifier?.id;
    if (typeof id === 'string' && id.length > 0) ids.push(id);
  }
  return ids;
}

/**
 * 挑出本机有、云端没有的扩展。
 * 只认本机扩展清单里的条目，内置扩展不在清单中，因此不会被误卸载。
 * 目标清单为空时一律返回空：那通常意味着云端还没有扩展信息，不能据此清空本机扩展。
 * 扩展标识不区分大小写，两台机器的清单写法可能不同，按原样比较会卸了再装。
 */
export function selectRemovableExtensionIds(
  installedIds: readonly string[],
  targetIds: Iterable<string>,
  skipIds: Iterable<string> = [],
): string[] {
  const target = lowerSet(targetIds);
  if (target.size === 0) return [];
  return selectAbsent(installedIds, target, lowerSet(skipIds));
}

/** 已安装或需跳过的扩展不再发起安装，避免重复安装或中途重载本插件。 */
export function selectMissingExtensionIds(
  targetIds: readonly string[],
  installedIds: Iterable<string>,
  skipIds: Iterable<string> = [],
): string[] {
  return selectAbsent(targetIds, lowerSet(installedIds), lowerSet(skipIds));
}

/** 仓库形态的排序规则：本机采集与合并结果必须逐字节一致，否则每轮同步都会产生无意义的差异。 */
export function sortExtensionIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}

/** 仓库形态的扩展清单：只保留标识，去掉版本号、安装路径等本机专属字段。 */
export function formatExtensionManifest(ids: readonly string[]): string {
  return `${JSON.stringify(ids.map((id) => ({ identifier: { id } })), null, 2)}\n`;
}

function selectAbsent(ids: readonly string[], present: Set<string>, skipped: Set<string>): string[] {
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const key = id.toLowerCase();
    if (!id || seen.has(key) || present.has(key) || skipped.has(key)) continue;
    seen.add(key);
    selected.push(id);
  }
  return selected;
}

function lowerSet(ids: Iterable<string>): Set<string> {
  return new Set([...ids].map((id) => id.toLowerCase()));
}
