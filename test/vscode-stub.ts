const applicationSettings = new Map<string, unknown>();

export const env = {
  machineId: 'test-machine',
};

export const ConfigurationTarget = {
  Global: 1,
};

export const workspace = {
  getConfiguration: () => ({
    get: <T>(key: string, defaultValue?: T): T | undefined => (
      applicationSettings.has(key) ? applicationSettings.get(key) as T : defaultValue
    ),
    update: async (key: string, value: unknown): Promise<void> => {
      applicationSettings.set(key, value);
    },
  }),
};

export function resetApplicationSettings(): void {
  applicationSettings.clear();
}
