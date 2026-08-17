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
 */
export function selectRemovableExtensionIds(
  installedIds: readonly string[],
  targetIds: Iterable<string>,
  skipIds: Iterable<string> = [],
): string[] {
  const target = new Set(targetIds);
  if (target.size === 0) return [];
  const skipped = new Set(skipIds);
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const id of installedIds) {
    if (!id || seen.has(id) || target.has(id) || skipped.has(id)) continue;
    seen.add(id);
    selected.push(id);
  }
  return selected;
}

/** 已安装或需跳过的扩展不再发起安装，避免重复安装或中途重载本插件。 */
export function selectMissingExtensionIds(
  targetIds: readonly string[],
  installedIds: Iterable<string>,
  skipIds: Iterable<string> = [],
): string[] {
  const installed = new Set(installedIds);
  const skipped = new Set(skipIds);
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const id of targetIds) {
    if (!id || seen.has(id) || installed.has(id) || skipped.has(id)) continue;
    seen.add(id);
    selected.push(id);
  }
  return selected;
}
