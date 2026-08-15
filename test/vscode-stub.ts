const applicationSettings = new Map<string, unknown>();
const installedExtensions = new Map<string, { id: string }>();
const failedInstallIds = new Set<string>();
const failedUninstallIds = new Set<string>();
export const installCommandCalls: string[] = [];
export const uninstallCommandCalls: string[] = [];

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

export const extensions = {
  getExtension: (id: string) => installedExtensions.get(id),
  onDidChange: () => ({ dispose() {} }),
};

export const commands = {
  executeCommand: async (command: string, argument?: unknown): Promise<unknown> => {
    if (typeof argument !== 'string') return undefined;
    if (command === 'workbench.extensions.installExtension') {
      installCommandCalls.push(argument);
      if (failedInstallIds.has(argument)) throw new Error(`无法安装 ${argument}`);
      installedExtensions.set(argument, { id: argument });
      return undefined;
    }
    if (command === 'workbench.extensions.uninstallExtension') {
      uninstallCommandCalls.push(argument);
      if (failedUninstallIds.has(argument)) throw new Error(`无法卸载 ${argument}`);
      installedExtensions.delete(argument);
      return undefined;
    }
    return undefined;
  },
};

export function resetApplicationSettings(): void {
  applicationSettings.clear();
}

export function resetExtensionStub(): void {
  installedExtensions.clear();
  failedInstallIds.clear();
  failedUninstallIds.clear();
  installCommandCalls.length = 0;
  uninstallCommandCalls.length = 0;
}

export function markExtensionInstalled(id: string): void {
  installedExtensions.set(id, { id });
}

export function markExtensionInstallFailed(id: string): void {
  failedInstallIds.add(id);
}

export function markExtensionUninstallFailed(id: string): void {
  failedUninstallIds.add(id);
}
