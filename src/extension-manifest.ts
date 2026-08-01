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
