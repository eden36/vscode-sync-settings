import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { withFileLock } from './file-lock';
import { atomicWriteJson, readJsonFile as readJson } from './json-store';
import {
  createConfigurationRecord,
  mergedClock,
  parseConfigurationRecord,
  parsePluginConfiguration,
  relateConfigurationRecords,
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

export class ConfigurationStore {
  private readonly configurationPath: string;
  private readonly recoveryPath: string;
  private readonly conflictPath: string;
  private readonly lockPath: string;
  private readonly deviceId: string;
  private current = createConfigurationRecord(DEFAULT_CONFIGURATION, 'uninitialized', 0, 0, 'uninitialized');

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly runtimePath: string,
  ) {
    this.configurationPath = path.join(runtimePath, 'configuration.json');
    this.recoveryPath = path.join(runtimePath, 'configuration-recovery.json');
    this.conflictPath = path.join(runtimePath, 'configuration-conflict.json');
    this.lockPath = path.join(runtimePath, 'configuration.lock');
    this.deviceId = createHash('sha256').update(vscode.env.machineId).digest('hex');
  }

  public async initialize(): Promise<void> {
    this.context.globalState.setKeysForSync([SYNCED_CONFIG_KEY]);
    await fs.mkdir(this.runtimePath, { recursive: true });
    await this.withLock(async () => {
      await Promise.all([
        fs.rm(this.recoveryPath, { force: true }),
        fs.rm(this.conflictPath, { force: true }),
      ]);
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

  public async save(value: PluginConfiguration): Promise<void> {
    await this.withLock(async () => {
      await this.reconcileLocked(
        parseConfigurationRecord(await readJson(this.configurationPath)),
        parseConfigurationRecord(this.context.globalState.get<unknown>(SYNCED_CONFIG_KEY)),
      );
      const parsed = parsePluginConfiguration(value);
      if (!parsed) throw new Error('同步配置参数错误。');
      if (sameConfiguration(this.current.configuration, parsed)) return;
      const next = createConfigurationRecord(parsed, this.deviceId, this.current.logicalTime, Date.now(), randomUUID(), this.current.clock);
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

  private async reconcileLocked(
    shared: VersionedConfigurationRecord | undefined,
    synced: VersionedConfigurationRecord | undefined,
  ): Promise<void> {
    let accepted = shared ?? synced;
    if (!accepted) {
      accepted = createConfigurationRecord(this.readApplicationSettings(DEFAULT_CONFIGURATION), this.deviceId);
    }
    if (shared && synced) {
      const relation = relateConfigurationRecords(shared, synced);
      if (relation === 'concurrent') {
        accepted = createConfigurationRecord(
          shared.configuration,
          this.deviceId,
          Math.max(shared.logicalTime, synced.logicalTime),
          Date.now(),
          randomUUID(),
          mergedClock(shared, synced),
        );
      } else {
        accepted = relation === 'right-newer' ? synced : shared;
      }
    }
    if (!shared || shared.revision !== accepted.revision) await this.persistAccepted(accepted);
    if (!synced || synced.revision !== accepted.revision) await this.context.globalState.update(SYNCED_CONFIG_KEY, accepted);
    this.current = accepted;
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
      pollIntervalSeconds: settings.get<number>('pollIntervalSeconds', base.pollIntervalSeconds),
      debounceSeconds: settings.get<number>('debounceSeconds', base.debounceSeconds),
      includeProfileAssociations: true,
    };
  }

  private async mirrorApplicationSettings(configuration: PluginConfiguration): Promise<void> {
    const settings = vscode.workspace.getConfiguration('profileGitSync');
    const updates: Array<Thenable<void>> = [];
    for (const [key, value] of [
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
    return withFileLock(this.lockPath, action, {
      timeoutMs: CONFIGURATION_LOCK_TIMEOUT_MS,
      staleMs: CONFIGURATION_LOCK_STALE_MS,
      busyMessage: '配置正在被其他窗口更新，请稍后重试。',
    });
  }
}
