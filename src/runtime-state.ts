import * as path from 'node:path';
import { withFileLock } from './file-lock';
import { atomicWriteJson, readJsonFile as readJson } from './json-store';
import { LinkState, SyncBaseline } from './types';

const RUNTIME_STATE_LOCK_BUSY = '同步状态正在被其他窗口更新，请稍后重试。';
const LINK_STATES = new Set<LinkState>(['no-repository', 'in-sync', 'unrelated']);
/** 显式传 undefined 表示删除，这些键不能靠展开保留旧值。 */
const OPTIONAL_KEYS = ['lastSyncAt', 'baseline', 'extensionsPending', 'extensionsPendingRounds', 'pendingResolution'] as const;

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
  /** 同步模式下重建或首次接入后必须整包采用云端，跨进程重启也要保持；备份模式会清除此标记。 */
  cloudAdoptPending: boolean;
  /** 上次整轮成功时两侧的状态；只有推送成功且完整落地的一轮才前移。 */
  baseline?: SyncBaseline;
  /** 上一轮没装完或没卸完的扩展；非空期间扩展清单不参与「这一侧改没改」的判定。 */
  extensionsPending?: string[];
  /** 扩展连续未收敛的轮数；达到上限后放弃等待，否则清单会永远被排除在判定之外。 */
  extensionsPendingRounds?: number;
  /** 用户对「两边都改了」的选择；整轮成功后才清除，中途失败下一轮继续沿用。 */
  pendingResolution?: 'local' | 'cloud';
}

// 默认关闭：同步模式下本机没有仓库时首轮同步会整包采用云端覆盖本机，不能在用户无感知时发生。
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
      for (const key of OPTIONAL_KEYS) {
        if (patch[key] === undefined && key in patch) delete next[key];
      }
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
  const baseline = parseBaseline(value.baseline);
  const extensionsPending = parseStringArray(value.extensionsPending);
  if (value.extensionsPending !== undefined && !extensionsPending) return undefined;
  if (value.extensionsPendingRounds !== undefined && !isCount(value.extensionsPendingRounds)) return undefined;
  if (value.pendingResolution !== undefined && value.pendingResolution !== 'local' && value.pendingResolution !== 'cloud') {
    return undefined;
  }
  if (value.baseline !== undefined && !baseline) return undefined;
  return {
    schemaVersion: 1,
    enabled: value.enabled,
    link: value.link as LinkState,
    cloudAdoptPending: value.cloudAdoptPending,
    ...(value.lastSyncAt !== undefined ? { lastSyncAt: value.lastSyncAt } : {}),
    ...(baseline ? { baseline } : {}),
    ...(extensionsPending ? { extensionsPending } : {}),
    ...(value.extensionsPendingRounds !== undefined
      ? { extensionsPendingRounds: value.extensionsPendingRounds as number }
      : {}),
    ...(value.pendingResolution !== undefined
      ? { pendingResolution: value.pendingResolution as 'local' | 'cloud' }
      : {}),
  };
}

function parseBaseline(value: unknown): SyncBaseline | undefined {
  if (!isRecord(value)) return undefined;
  const keys = ['localSnapshot', 'localExtensions', 'cloudSnapshot', 'cloudExtensions'] as const;
  if (!keys.every((key) => typeof value[key] === 'string')) return undefined;
  return {
    localSnapshot: value.localSnapshot as string,
    localExtensions: value.localExtensions as string,
    cloudSnapshot: value.cloudSnapshot as string,
    cloudExtensions: value.cloudExtensions as string,
  };
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return undefined;
  return value as string[];
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function sameRuntimeState(left: RuntimeStateRecord, right: RuntimeStateRecord): boolean {
  return left.enabled === right.enabled
    && left.link === right.link
    && left.lastSyncAt === right.lastSyncAt
    && left.cloudAdoptPending === right.cloudAdoptPending
    && left.pendingResolution === right.pendingResolution
    && left.extensionsPendingRounds === right.extensionsPendingRounds
    && sameBaseline(left.baseline, right.baseline)
    && sameIds(left.extensionsPending, right.extensionsPending);
}

function sameBaseline(left: SyncBaseline | undefined, right: SyncBaseline | undefined): boolean {
  if (!left || !right) return left === right;
  return left.localSnapshot === right.localSnapshot
    && left.localExtensions === right.localExtensions
    && left.cloudSnapshot === right.cloudSnapshot
    && left.cloudExtensions === right.cloudExtensions;
}

function sameIds(left: string[] | undefined, right: string[] | undefined): boolean {
  if (!left || !right) return left === right;
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
