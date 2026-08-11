import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
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
import { ConflictStrategy, PendingConflictView } from './conflict-types';
import { DEFAULT_CONFIGURATION, PluginConfiguration } from './types';

const LEGACY_CONFIG_KEY = 'profileGitSync.configuration';
const SYNCED_CONFIG_KEY = 'profileGitSync.syncedConfiguration';
const REPOSITORY_URL_SECRET = 'profileGitSync.repositoryUrl';
const CONFIGURATION_LOCK_TIMEOUT_MS = 10_000;
const CONFIGURATION_LOCK_STALE_MS = 30_000;

export interface ConfigurationViewState {
  revision: string;
  conflict?: PendingConflictView;
}

interface StoredConfigurationConflict {
  schemaVersion: 1;
  id: string;
  kind: 'pluginConfiguration' | 'legacyConfigurationBackup';
  local: VersionedConfigurationRecord;
  cloud: VersionedConfigurationRecord;
  differingFields: string[];
  aiCandidate?: PluginConfiguration;
  aiError?: string;
}

export class ConfigurationStore {
  private readonly configurationPath: string;
  private readonly recoveryPath: string;
  private readonly conflictPath: string;
  private readonly lockPath: string;
  private readonly deviceId: string;
  private current = createConfigurationRecord(DEFAULT_CONFIGURATION, 'uninitialized', 0, 0, 'uninitialized');
  private conflict?: StoredConfigurationConflict;

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
      this.conflict = undefined;
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
      ...(this.conflict ? { conflict: configurationConflictView(this.conflict) } : {}),
    };
  }

  public hasConflict(): boolean {
    return this.conflict !== undefined;
  }

  public conflictSides(): { local: PluginConfiguration; cloud: PluginConfiguration } | undefined {
    if (!this.conflict) return undefined;
    return {
      local: { ...this.conflict.local.configuration },
      cloud: { ...this.conflict.cloud.configuration },
    };
  }

  public async save(value: PluginConfiguration): Promise<void> {
    await this.withLock(async () => {
      await this.reconcileLocked(
        parseConfigurationRecord(await readJson(this.configurationPath)),
        parseConfigurationRecord(this.context.globalState.get<unknown>(SYNCED_CONFIG_KEY)),
      );
      if (this.conflict) throw new Error('请先处理同步设置冲突。');
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

  public async setConflictAiCandidate(id: string, candidate: PluginConfiguration | undefined, error?: string): Promise<void> {
    await this.withLock(async () => {
      const conflict = parseStoredConflict(await readJson(this.conflictPath));
      if (!conflict) throw new Error('待处理的同步设置冲突已不存在。');
      if (conflict.id !== id) throw new Error('待处理的同步设置冲突已变化，请重新确认。');
      if (candidate) {
        const parsed = parsePluginConfiguration(candidate);
        if (!parsed) throw new Error('AI 返回的同步设置参数错误。');
        const pairMatches = [conflict.local.configuration, conflict.cloud.configuration].some((side) => (
          side.repositoryUrl === parsed.repositoryUrl && side.branch === parsed.branch
        ));
        if (!pairMatches) throw new Error('AI 必须从同一版本选择仓库地址和分支。');
        conflict.aiCandidate = parsed;
        delete conflict.aiError;
      } else {
        delete conflict.aiCandidate;
        conflict.aiError = error ?? 'AI 合并失败。';
      }
      await atomicWriteJson(this.conflictPath, conflict);
      this.conflict = conflict;
    });
  }

  public async resolveConflict(id: string, strategy: ConflictStrategy): Promise<boolean> {
    return this.withLock(async () => {
      const conflict = parseStoredConflict(await readJson(this.conflictPath));
      if (!conflict) return false;
      // 磁盘上的冲突可能已被其他窗口处理并换成新冲突，不能把用户的选择套用到另一份冲突上。
      if (conflict.id !== id) throw new Error('待处理的同步设置冲突已变化，请重新确认。');
      const selected = strategy === 'local'
        ? conflict.local.configuration
        : strategy === 'cloud'
          ? conflict.cloud.configuration
          : conflict.aiCandidate;
      if (!selected) throw new Error('AI 尚未生成可应用的合并方案。');
      const clock = mergedClock(conflict.local, conflict.cloud);
      const logicalTime = Math.max(conflict.local.logicalTime, conflict.cloud.logicalTime);
      const accepted = createConfigurationRecord(selected, this.deviceId, logicalTime, Date.now(), randomUUID(), clock);
      await this.persistAccepted(accepted);
      await this.context.globalState.update(SYNCED_CONFIG_KEY, accepted);
      this.current = accepted;
      this.conflict = undefined;
      await Promise.all([
        fs.rm(this.conflictPath, { force: true }),
        fs.rm(this.recoveryPath, { force: true }),
      ]);
      await this.persistRepositoryUrl(accepted.configuration.repositoryUrl);
      await this.mirrorApplicationSettings(accepted.configuration);
      return true;
    });
  }

  private async reconcileLocked(
    shared: VersionedConfigurationRecord | undefined,
    synced: VersionedConfigurationRecord | undefined,
  ): Promise<void> {
    const pending = parseStoredConflict(await readJson(this.conflictPath));
    if (pending) {
      const revisionsStillMatch = pending.kind === 'legacyConfigurationBackup'
        ? shared?.revision === pending.local.revision
        : shared?.revision === pending.local.revision && synced?.revision === pending.cloud.revision;
      if (revisionsStillMatch) {
        this.current = pending.local;
        this.conflict = pending;
        await this.persistRepositoryUrl(this.current.configuration.repositoryUrl);
        // 冲突未处理前不回写 VS Code 设置项，否则用户在设置界面的修改会被定时重载悄悄回滚。
        return;
      }
      await fs.rm(this.conflictPath, { force: true });
    }

    let accepted = shared ?? synced;
    if (!accepted) {
      accepted = createConfigurationRecord(this.readApplicationSettings(DEFAULT_CONFIGURATION), this.deviceId);
    }
    if (shared && synced) {
      const relation = relateConfigurationRecords(shared, synced);
      if (relation === 'concurrent' && !sameConfiguration(shared.configuration, synced.configuration)) {
        const conflict: StoredConfigurationConflict = {
          schemaVersion: 1,
          id: randomUUID(),
          kind: 'pluginConfiguration',
          local: shared,
          cloud: synced,
          differingFields: differingConfigurationFields(shared.configuration, synced.configuration),
        };
        await atomicWriteJson(this.conflictPath, conflict);
        this.current = shared;
        this.conflict = conflict;
        await this.persistRepositoryUrl(shared.configuration.repositoryUrl);
        await this.mirrorApplicationSettings(shared.configuration);
        return;
      }
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
    this.conflict = undefined;
    const recovery = parseConfigurationRecord(await readJson(this.recoveryPath));
    if (recovery && recovery.revision !== accepted.revision && !sameConfiguration(recovery.configuration, accepted.configuration)) {
      const conflict: StoredConfigurationConflict = {
        schemaVersion: 1,
        id: randomUUID(),
        kind: 'legacyConfigurationBackup',
        local: accepted,
        cloud: recovery,
        differingFields: differingConfigurationFields(accepted.configuration, recovery.configuration),
      };
      await atomicWriteJson(this.conflictPath, conflict);
      this.conflict = conflict;
    }
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

function parseStoredConflict(value: unknown): StoredConfigurationConflict | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.id !== 'string') return undefined;
  if (value.kind !== 'pluginConfiguration' && value.kind !== 'legacyConfigurationBackup') return undefined;
  const local = parseConfigurationRecord(value.local);
  const cloud = parseConfigurationRecord(value.cloud);
  if (!local || !cloud || !Array.isArray(value.differingFields) || !value.differingFields.every((item) => typeof item === 'string')) return undefined;
  const aiCandidate = value.aiCandidate === undefined ? undefined : parsePluginConfiguration(value.aiCandidate);
  if (value.aiCandidate !== undefined && !aiCandidate) return undefined;
  if (value.aiError !== undefined && typeof value.aiError !== 'string') return undefined;
  return {
    schemaVersion: 1,
    id: value.id,
    kind: value.kind,
    local,
    cloud,
    differingFields: [...value.differingFields],
    ...(aiCandidate ? { aiCandidate } : {}),
    ...(typeof value.aiError === 'string' ? { aiError: value.aiError } : {}),
  };
}

function differingConfigurationFields(left: PluginConfiguration, right: PluginConfiguration): string[] {
  const labels: Record<keyof PluginConfiguration, string> = {
    repositoryUrl: '仓库地址',
    branch: '分支',
    gitUserName: 'Git 用户名',
    gitUserEmail: 'Git 邮箱',
    autoSync: '自动同步',
    pollIntervalSeconds: '远程轮询间隔',
    debounceSeconds: '本地检测间隔',
    includeProfileAssociations: 'Profile 关联关系',
  };
  return (Object.keys(labels) as Array<keyof PluginConfiguration>)
    .filter((key) => left[key] !== right[key])
    .map((key) => labels[key]);
}

function configurationConflictView(conflict: StoredConfigurationConflict): PendingConflictView {
  const legacy = conflict.kind === 'legacyConfigurationBackup';
  return {
    id: conflict.id,
    kind: conflict.kind,
    title: legacy ? '发现以前保留的设置备份' : '发现两份不同的同步设置',
    description: legacy
      ? '插件此前保留了另一份设置。请选择保留当前设置、恢复备份，或让 AI 合并。'
      : '本机设置和 VS Code 云端设置都发生了变化。处理前不会继续同步。',
    items: conflict.differingFields,
    aiCandidateReady: conflict.aiCandidate !== undefined,
    ...(conflict.aiError ? { aiError: conflict.aiError } : {}),
  };
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
