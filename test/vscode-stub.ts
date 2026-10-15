const applicationSettings = new Map<string, unknown>();
const failedInstallIds = new Set<string>();
const failedUninstallIds = new Set<string>();
const heldInstalls = new Map<string, Promise<void>>();
export const installCommandCalls: string[] = [];
export const uninstallCommandCalls: string[] = [];

export const informationMessages: string[] = [];

export const window = {
  showInformationMessage: async (message: string): Promise<undefined> => {
    informationMessages.push(message);
    return undefined;
  },
};

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

export const commands = {
  executeCommand: async (command: string, argument?: unknown): Promise<unknown> => {
    if (typeof argument !== 'string') return undefined;
    if (command === 'workbench.extensions.installExtension') {
      installCommandCalls.push(argument);
      await heldInstalls.get(argument);
      if (failedInstallIds.has(argument)) throw new Error(`无法安装 ${argument}`);
      return undefined;
    }
    if (command === 'workbench.extensions.uninstallExtension') {
      uninstallCommandCalls.push(argument);
      if (failedUninstallIds.has(argument)) throw new Error(`无法卸载 ${argument}`);
      return undefined;
    }
    return undefined;
  },
};

export function resetApplicationSettings(): void {
  applicationSettings.clear();
}

export function resetWindowStub(): void {
  informationMessages.length = 0;
}

export function resetExtensionStub(): void {
  failedInstallIds.clear();
  failedUninstallIds.clear();
  heldInstalls.clear();
  installCommandCalls.length = 0;
  uninstallCommandCalls.length = 0;
}

export function markExtensionInstallFailed(id: string): void {
  failedInstallIds.add(id);
}

/** 模拟下载很慢的安装：调用返回的函数之前安装命令一直不结束。 */
export function holdExtensionInstall(id: string): () => void {
  let release = (): void => undefined;
  heldInstalls.set(id, new Promise<void>((resolve) => { release = resolve; }));
  return release;
}

export function markExtensionUninstallFailed(id: string): void {
  failedUninstallIds.add(id);
}
