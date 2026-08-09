import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  compareConfigurationRecords,
  createConfigurationRecord,
  parseConfigurationRecord,
  parsePluginConfiguration,
  resolveRepositoryUrl,
  sameConfiguration,
  StoredConfiguration,
  VersionedConfigurationRecord,
} from './configuration-record';
import { DEFAULT_CONFIGURATION, PluginConfiguration } from './types';

const LEGACY_CONFIG_KEY = 'profileGitSync.configuration';
const SYNCED_CONFIG_KEY = 'profileGitSync.syncedConfiguration';
const REPOSITORY_URL_SECRET = 'profileGitSync.repositoryUrl';
const CONFIGURATION_LOCK_TIMEOUT_MS = 10_000;
const CONFIGURATION_LOCK_STALE_MS = 30_000;

export interface ConfigurationViewState {
  revision: string;
  recovery?: VersionedConfigurationRecord;
}

export class ConfigurationStore {
  private readonly configurationPath: string;
  private readonly recoveryPath: string;
  private readonly lockPath: string;
  private readonly deviceId: string;
  private current = createConfigurationRecord(DEFAULT_CONFIGURATION, 'uninitialized', 0, 0, 'uninitialized');
  private recovery?: VersionedConfigurationRecord;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly runtimePath: string,
  ) {
    this.configurationPath = path.join(runtimePath, 'configuration.json');
    this.recoveryPath = path.join(runtimePath, 'configuration-recovery.json');
    this.lockPath = path.join(runtimePath, 'configuration.lock');
    this.deviceId = createHash('sha256').update(vscode.env.machineId).digest('hex');
  }

  public async initialize(): Promise<void> {
    this.context.globalState.setKeysForSync([SYNCED_CONFIG_KEY]);
    await fs.mkdir(this.runtimePath, { recursive: true });
    await this.withLock(async () => {
      const shared = parseConfigurationRecord(await readJson(this.configurationPath));
      const synced = parseConfigurationRecord(this.context.globalState.get<unknown>(SYNCED_CONFIG_KEY));
      if (shared || synced) {
        await this.reconcileLocked(shared, synced);
        return;
      }
      const legacy = this.context.globalState.get<StoredConfiguration>(LEGACY_CONFIG_KEY, {});
      const resolved = resolveRepositoryUrl(await this.context.secrets.get(REPOSITORY_URL_SECRET), legacy);
      const configuration = this.readApplicationSettings({
        ...DEFAULT_CONFIGURATION,
        ...resolved.persisted,
        repositoryUrl: resolved.repositoryUrl,
      });
      const initial = createConfigurationRecord(configuration, this.deviceId);
      await this.persistAccepted(initial);
      await this.context.globalState.update(SYNCED_CONFIG_KEY, initial);
      await this.context.globalState.update(LEGACY_CONFIG_KEY, resolved.persisted);
      this.current = initial;
      this.recovery = undefined;
      await this.persistRepositoryUrl(configuration.repositoryUrl);
      await this.mirrorApplicationSettings(configuration);
    });
  }

  public async reload(): Promise<boolean> {
    return this.withLock(async () => {
      const previousRevision = this.current.revision;
      await this.reconcileLocked(
        parseConfigurationRecord(await readJson(this.configurationPath)),
        parseConfigurationRecord(this.context.globalState.get<unknown>(SYNCED_CONFIG_KEY)),
      );
      return previousRevision !== this.current.revision;
    });
  }

  public get(): PluginConfiguration {
    return { ...this.current.configuration };
  }

  public viewState(): ConfigurationViewState {
    return {
      revision: this.current.revision,
      ...(this.recovery ? { recovery: this.recovery } : {}),
    };
  }

  public async save(value: PluginConfiguration): Promise<void> {
    await this.withLock(async () => {
      await this.reconcileLocked(
        parseConfigurationRecord(await readJson(this.configurationPath)),
        parseConfigurationRecord(this.context.globalState.get<unknown>(SYNCED_CONFIG_KEY)),
      );
      const parsed = parsePluginConfiguration(value);
      if (!parsed) throw new Error('同步配置参数错误。');
      if (sameConfiguration(this.current.configuration, parsed)) return;
      const next = createConfigurationRecord(parsed, this.deviceId, this.current.logicalTime);
      if (!sameConfiguration(this.current.configuration, next.configuration)) {
        await atomicWriteJson(this.recoveryPath, this.current);
        this.recovery = this.current;
      }
      await this.persistAccepted(next);
      await this.context.globalState.update(SYNCED_CONFIG_KEY, next);
      this.current = next;
      await this.persistRepositoryUrl(next.configuration.repositoryUrl);
      await this.mirrorApplicationSettings(next.configuration);
    });
  }

  public async saveApplicationSettings(): Promise<boolean> {
    const next = this.readApplicationSettings(this.get());
    if (sameConfiguration(next, this.current.configuration)) return false;
    await this.save(next);
    return true;
  }

  public async restoreRecovery(): Promise<boolean> {
    const recovery = parseConfigurationRecord(await readJson(this.recoveryPath));
    if (!recovery) return false;
    await this.save(recovery.configuration);
    await fs.rm(this.recoveryPath, { force: true });
    this.recovery = undefined;
    return true;
  }

  private async reconcileLocked(
    shared: VersionedConfigurationRecord | undefined,
    synced: VersionedConfigurationRecord | undefined,
  ): Promise<void> {
    let accepted = shared ?? synced;
    if (!accepted) {
      accepted = createConfigurationRecord(this.readApplicationSettings(DEFAULT_CONFIGURATION), this.deviceId);
    }
    if (shared && synced) {
      accepted = compareConfigurationRecords(shared, synced) >= 0 ? shared : synced;
      const replaced = accepted === shared ? synced : shared;
      if (accepted.revision !== replaced.revision && !sameConfiguration(accepted.configuration, replaced.configuration)) {
        await atomicWriteJson(this.recoveryPath, replaced);
      }
    }
    if (!shared || shared.revision !== accepted.revision) await this.persistAccepted(accepted);
    if (!synced || synced.revision !== accepted.revision) await this.context.globalState.update(SYNCED_CONFIG_KEY, accepted);
    this.current = accepted;
    this.recovery = parseConfigurationRecord(await readJson(this.recoveryPath));
    await this.persistRepositoryUrl(accepted.configuration.repositoryUrl);
    await this.mirrorApplicationSettings(accepted.configuration);
  }

  private async persistAccepted(record: VersionedConfigurationRecord): Promise<void> {
    await atomicWriteJson(this.configurationPath, record);
    await this.context.globalState.update(LEGACY_CONFIG_KEY, {
      branch: record.configuration.branch,
      gitUserName: record.configuration.gitUserName,
      gitUserEmail: record.configuration.gitUserEmail,
    });
  }

  private async persistRepositoryUrl(repositoryUrl: string): Promise<void> {
    if (repositoryUrl) await this.context.secrets.store(REPOSITORY_URL_SECRET, repositoryUrl);
    else await this.context.secrets.delete(REPOSITORY_URL_SECRET);
  }

  private readApplicationSettings(base: PluginConfiguration): PluginConfiguration {
    const settings = vscode.workspace.getConfiguration('profileGitSync');
    return {
      ...base,
      autoSync: settings.get<boolean>('autoSync', base.autoSync),
      pollIntervalSeconds: settings.get<number>('pollIntervalSeconds', base.pollIntervalSeconds),
      debounceSeconds: settings.get<number>('debounceSeconds', base.debounceSeconds),
      includeProfileAssociations: settings.get<boolean>('includeProfileAssociations', base.includeProfileAssociations),
    };
  }

  private async mirrorApplicationSettings(configuration: PluginConfiguration): Promise<void> {
    const settings = vscode.workspace.getConfiguration('profileGitSync');
    const updates: Array<Thenable<void>> = [];
    for (const [key, value] of [
      ['autoSync', configuration.autoSync],
      ['pollIntervalSeconds', configuration.pollIntervalSeconds],
      ['debounceSeconds', configuration.debounceSeconds],
      ['includeProfileAssociations', configuration.includeProfileAssociations],
    ] as const) {
      if (settings.get(key) !== value) {
        updates.push(settings.update(key, value, vscode.ConfigurationTarget.Global));
      }
    }
    await Promise.all(updates);
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    const token = randomUUID();
    const deadline = Date.now() + CONFIGURATION_LOCK_TIMEOUT_MS;
    while (true) {
      try {
        const handle = await fs.open(this.lockPath, 'wx');
        try {
          await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }));
        } finally {
          await handle.close();
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const lock = await readJson(this.lockPath);
        if (isStaleLock(lock)) {
          await fs.rm(this.lockPath, { force: true });
          continue;
        }
        if (Date.now() >= deadline) throw new Error('配置正在被其他窗口更新，请稍后重试。');
        await delay(50);
      }
    }
    try {
      return await action();
    } finally {
      const lock = await readJson(this.lockPath);
      if (isRecord(lock) && lock.token === token) await fs.rm(this.lockPath, { force: true });
    }
  }
}

function isStaleLock(value: unknown): boolean {
  if (!isRecord(value) || typeof value.pid !== 'number' || typeof value.createdAt !== 'number') return false;
  if (Date.now() - value.createdAt > CONFIGURATION_LOCK_STALE_MS) return true;
  try {
    process.kill(value.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'EPERM';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' });
  try {
    await fs.rename(temporary, filePath);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    await fs.rm(filePath, { force: true });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
