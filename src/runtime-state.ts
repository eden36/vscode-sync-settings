import * as path from 'node:path';
import { withFileLock } from './file-lock';
import { atomicWriteJson, readJsonFile as readJson } from './json-store';
import { LinkState } from './types';

const RUNTIME_STATE_LOCK_BUSY = '同步状态正在被其他窗口更新，请稍后重试。';
const LINK_STATES = new Set<LinkState>(['no-repository', 'in-sync', 'unrelated']);

/**
 * 跨窗口、跨 Profile 共享的运行状态。
 * VS Code 的 globalState 与 SecretStorage 按 Profile 隔离，因此这些值只能落在共享的运行目录里。
 */
export interface RuntimeStateRecord {
  schemaVersion: 1;
  /** 同步总开关；关闭时不建仓库、不联网、不写回本机配置。 */
  enabled: boolean;
  link: LinkState;
  lastSyncAt?: string;
  /** 重建或首次接入后必须整包采用云端，跨进程重启也要保持。 */
  cloudAdoptPending: boolean;
}

// 默认关闭：本机没有仓库时首轮同步会整包采用云端覆盖本机，不能在用户无感知时发生。
export const DEFAULT_RUNTIME_STATE: RuntimeStateRecord = {
  schemaVersion: 1,
  enabled: false,
  link: 'no-repository',
  cloudAdoptPending: false,
};

export class RuntimeStateStore {
  private readonly statePath: string;
  private readonly lockPath: string;
  private current: RuntimeStateRecord = { ...DEFAULT_RUNTIME_STATE };

  public constructor(runtimePath: string) {
    this.statePath = path.join(runtimePath, 'runtime-state.json');
    this.lockPath = path.join(runtimePath, 'runtime-state.lock');
  }

  /** defaults 只在共享文件尚不存在时生效，用于承接用户已经写在宿主设置里的选择。 */
  public async initialize(defaults: Partial<Omit<RuntimeStateRecord, 'schemaVersion'>> = {}): Promise<void> {
    await this.withLock(async () => {
      const stored = parseRuntimeState(await readJson(this.statePath));
      if (stored) {
        this.current = stored;
        return;
      }
      this.current = { ...DEFAULT_RUNTIME_STATE, ...defaults, schemaVersion: 1 };
      await atomicWriteJson(this.statePath, this.current);
    });
  }

  public get(): RuntimeStateRecord {
    return { ...this.current };
  }

  /** 重新读取共享文件，返回是否与本窗口缓存不同。 */
  public async reload(): Promise<boolean> {
    const stored = parseRuntimeState(await readJson(this.statePath));
    if (!stored || sameRuntimeState(stored, this.current)) return false;
    this.current = stored;
    return true;
  }

  public async update(patch: Partial<Omit<RuntimeStateRecord, 'schemaVersion'>>): Promise<void> {
    if (sameRuntimeState({ ...this.current, ...patch }, this.current)) return;
    await this.withLock(async () => {
      // 锁内重新读取，避免覆盖其他窗口在本窗口缓存之后写入的字段。
      const stored = parseRuntimeState(await readJson(this.statePath)) ?? this.current;
      const next: RuntimeStateRecord = { ...stored, ...patch, schemaVersion: 1 };
      if (patch.lastSyncAt === undefined && 'lastSyncAt' in patch) delete next.lastSyncAt;
      this.current = next;
      // 其他窗口可能已写入同样的值（leader 广播状态后 follower 也会走到这里），无需重复落盘。
      if (sameRuntimeState(next, stored)) return;
      await atomicWriteJson(this.statePath, next);
    });
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    return withFileLock(this.lockPath, action, { busyMessage: RUNTIME_STATE_LOCK_BUSY });
  }
}

export function parseRuntimeState(value: unknown): RuntimeStateRecord | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) return undefined;
  if (typeof value.enabled !== 'boolean' || typeof value.cloudAdoptPending !== 'boolean') return undefined;
  if (typeof value.link !== 'string' || !LINK_STATES.has(value.link as LinkState)) return undefined;
  if (value.lastSyncAt !== undefined && typeof value.lastSyncAt !== 'string') return undefined;
  return {
    schemaVersion: 1,
    enabled: value.enabled,
    link: value.link as LinkState,
    cloudAdoptPending: value.cloudAdoptPending,
    ...(value.lastSyncAt !== undefined ? { lastSyncAt: value.lastSyncAt } : {}),
  };
}

function sameRuntimeState(left: RuntimeStateRecord, right: RuntimeStateRecord): boolean {
  return left.enabled === right.enabled
    && left.link === right.link
    && left.lastSyncAt === right.lastSyncAt
    && left.cloudAdoptPending === right.cloudAdoptPending;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
