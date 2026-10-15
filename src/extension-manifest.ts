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

export interface ExtensionSyncPlan {
  /** 合并后的云端清单。 */
  merged: string[];
  install: string[];
  uninstall: string[];
}

/**
 * 扩展清单按增删合并，不随快照整份择一，synced 是上次同步时本机的扩展：
 * - 本机相对 synced 新装的加进云端，卸载的从云端删掉；
 * - synced 里有、本机仍有、云端却没有的，是别的机器删掉的，本机卸载；
 * - 云端有、本机与 synced 都没有的（装失败、还在装、市场里没有）保留在云端并在本机安装，不当成本机删除，
 *   否则一台机器装不上就会让所有机器卸载它。
 * synced 缺失（首次同步）时视同空集合，结果是两侧取并集，只装不卸。
 */
export function planExtensionSync(
  local: readonly string[],
  cloud: readonly string[],
  synced: readonly string[] | undefined,
): ExtensionSyncPlan {
  const localSet = lowerSet(local);
  // 没有记录时本机全部算新增：当成「本机当前」会把本机独有的扩展判成别的机器删掉的并卸载。
  const syncedSet = lowerSet(synced ?? []);
  const added = local.filter((id) => !syncedSet.has(id.toLowerCase()));
  const removed = new Set([...syncedSet].filter((key) => !localSet.has(key)));
  const merged = sortExtensionIds(selectAbsent([...cloud, ...added], new Set(), removed));
  return {
    merged,
    install: selectAbsent(merged, localSet, new Set()),
    // 本机新装的都在合并结果里，本机有而结果里没有的只可能是别的机器删掉的。
    // 合并结果为空时视为信息缺失，不据此清空本机扩展。
    uninstall: merged.length ? selectAbsent(local, lowerSet(merged), new Set()) : [],
  };
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
