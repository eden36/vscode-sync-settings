export interface UtilityModelSelector {
  vendor: string;
  id: string;
}

export function parseUtilityModelSetting(value: string): UtilityModelSelector | undefined {
  const separator = value.indexOf('/');
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return {
    vendor: value.slice(0, separator),
    id: value.slice(separator + 1)
  };
}
