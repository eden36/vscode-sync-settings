import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWriteJson, readJsonFile as readJson } from './json-store';
import { BlockReason, LinkState, RuntimeStatus, StageName, SyncState } from './types';

interface Lease {
  schemaVersion?: 2;
  token?: string;
  instanceId: string;
  pid: number;
  updatedAt: number;
}

interface OperationLock {
  schemaVersion?: 2;
  token?: string;
  instanceId: string;
  pid: number;
  startedAt: number;
  updatedAt?: number;
}

interface WindowPresence {
  schemaVersion?: 2;
  instanceId: string;
  pid: number;
  updatedAt: number;
  dirtyDocuments?: number;
}

interface SharedStatus {
  schemaVersion: 3;
  revision: string;
  updatedAt: number;
  sync: SyncState;
  link: LinkState;
  profiles: string[];
  pendingChanges: number;
  lastSyncAt?: string;
  message?: string;
}

interface ConfigurationRevision {
  schemaVersion: 2;
  revision: string;
  instanceId: string;
  updatedAt: number;
}

export interface WindowSafetySnapshot {
  activeWindows: number;
  dirtyWindows: number;
  unreadableWindows: number;
}

export interface CoordinatorOptions {
  heartbeatMs?: number;
  leaseTtlMs?: number;
  staleConfirmationMs?: number;
  now?: () => number;
  isProcessAlive?: (pid: number) => boolean;
}

const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_LEASE_TTL_MS = 20_000;
const DEFAULT_STALE_CONFIRMATION_MS = 10_000;
const MAX_OPERATION_ACQUIRE_ATTEMPTS = 3;
const STAGE_NAMES = new Set<StageName>([
  'snapshot', 'scan-secrets', 'prepare', 'pull', 'decide', 'merge', 'ai', 'push', 'apply', 'extensions',
]);
const BLOCK_REASONS = new Set<BlockReason>([
  'dirty-windows', 'unreadable-windows', 'other-windows', 'unrelated', 'exclusive-lock',
]);
const LINK_STATES = new Set<LinkState>(['no-repository', 'in-sync', 'unrelated']);

export class MultiWindowCoordinator extends EventEmitter {
  public readonly instanceId = randomUUID();
  private readonly leasePath: string;
  private readonly presencePath: string;
  private readonly operationPath: string;
  private readonly sharedStatusPath: string;
  private readonly configurationRevisionPath: string;
  private readonly heartbeatMs: number;
  private readonly leaseTtlMs: number;
  private readonly staleConfirmationMs: number;
  private readonly now: () => number;
  private readonly processAlive: (pid: number) => boolean;
  private readonly claimedRequests = new Set<string>();
  private timer?: NodeJS.Timeout;
  private operationHeartbeat?: NodeJS.Timeout;
  private operationRefresh?: Promise<void>;
  private leader = false;
  private started = false;
  private ticking = false;
  private dirtyDocuments = 0;
  private lastWindowSignature = '';
  private lastStatusRevision?: string;
  private lastConfigurationRevision?: string;
  private presenceWrite: Promise<void> = Promise.resolve();
  private statusWrite: Promise<void> = Promise.resolve();
  private currentTick?: Promise<void>;

  public constructor(private readonly runtimePath: string, options: CoordinatorOptions = {}) {
    super();
    this.leasePath = path.join(runtimePath, 'coordinator.lease.json');
    this.presencePath = path.join(runtimePath, `window-${this.instanceId}.json`);
    this.operationPath = path.join(runtimePath, 'sync.operation.json');
    this.sharedStatusPath = path.join(runtimePath, 'runtime-status.json');
    this.configurationRevisionPath = path.join(runtimePath, 'configuration-revision.json');
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.staleConfirmationMs = options.staleConfirmationMs ?? DEFAULT_STALE_CONFIRMATION_MS;
    this.now = options.now ?? Date.now;
    this.processAlive = options.isProcessAlive ?? isProcessAlive;
  }

  public get isLeader(): boolean {
    return this.leader;
  }

  public async start(): Promise<void> {
    await fs.mkdir(this.runtimePath, { recursive: true });
    this.started = true;
    await this.runTick();
    this.timer = setInterval(() => void this.runTick(), this.heartbeatMs);
  }

  public async requestSync(): Promise<void> {
    if (this.leader) {
      this.emit('syncRequested');
      return;
    }
    const requestId = randomUUID();
    await atomicWriteJson(
      path.join(this.runtimePath, `sync-request-${requestId}.json`),
      { schemaVersion: 2, requestId, instanceId: this.instanceId, requestedAt: this.now() },
    );
  }

  public async completeSyncRequests(): Promise<void> {
    const requests = [...this.claimedRequests];
    this.claimedRequests.clear();
    await Promise.all(requests.map((request) => fs.rm(request, { force: true })));
  }

  public async notifyConfigurationChanged(): Promise<void> {
    const revision: ConfigurationRevision = {
      schemaVersion: 2,
      revision: randomUUID(),
      instanceId: this.instanceId,
      updatedAt: this.now(),
    };
    this.lastConfigurationRevision = revision.revision;
    await atomicWriteJson(this.configurationRevisionPath, revision);
    this.emit('configurationChanged');
  }

  public async publishStatus(status: RuntimeStatus): Promise<void> {
    if (!this.leader) return;
    const shared: SharedStatus = {
      schemaVersion: 3,
      revision: randomUUID(),
      updatedAt: this.now(),
      sync: status.sync,
      link: status.link,
      profiles: status.profiles,
      pendingChanges: status.pendingChanges,
      ...(status.lastSyncAt ? { lastSyncAt: status.lastSyncAt } : {}),
      ...(status.message ? { message: status.message } : {}),
    };
    this.lastStatusRevision = shared.revision;
    const write = this.statusWrite.catch(() => undefined).then(() => atomicWriteJson(this.sharedStatusPath, shared));
    this.statusWrite = write;
    await write;
  }

  public async setDirtyDocuments(count: number): Promise<void> {
    this.dirtyDocuments = Math.max(0, Math.floor(count));
    if (this.started) await this.writePresence();
  }

  public async runExclusive(action: () => Promise<void>): Promise<boolean> {
    const token = randomUUID();
    const startedAt = this.now();
    const acquired = await this.acquireOperation(token, startedAt);
    if (!acquired) return false;
    this.operationHeartbeat = setInterval(() => {
      if (this.operationRefresh) return;
      const refresh = this.refreshOperation(token, startedAt)
        .catch((error: unknown) => this.emitCoordinationError(error))
        .finally(() => {
          if (this.operationRefresh === refresh) this.operationRefresh = undefined;
        });
      this.operationRefresh = refresh;
    }, this.heartbeatMs);
    try {
      await action();
      return true;
    } finally {
      if (this.operationHeartbeat) clearInterval(this.operationHeartbeat);
      this.operationHeartbeat = undefined;
      await this.operationRefresh;
      await this.removeOwnedOperation(token);
    }
  }

  public async activeWindowCount(): Promise<number> {
    return (await this.windowSafety()).activeWindows;
  }

  public async windowSafety(): Promise<WindowSafetySnapshot> {
    const entries = await fs.readdir(this.runtimePath).catch(() => [] as string[]);
    let activeWindows = 0;
    let dirtyWindows = 0;
    let unreadableWindows = 0;
    for (const entry of entries.filter((name) => /^window-.+\.json$/.test(name))) {
      const filePath = path.join(this.runtimePath, entry);
      const stat = await fs.stat(filePath).catch(() => undefined);
      if (!stat || this.now() - stat.mtimeMs > this.leaseTtlMs) {
        await fs.rm(filePath, { force: true }).catch(() => undefined);
        continue;
      }
      activeWindows += 1;
      const presence = parsePresence(await readJson(filePath));
      if (!presence) {
        unreadableWindows += 1;
      } else if (!this.processAlive(presence.pid)) {
        activeWindows -= 1;
        await fs.rm(filePath, { force: true }).catch(() => undefined);
      } else if ((presence.dirtyDocuments ?? 0) > 0) {
        dirtyWindows += 1;
      }
    }
    return { activeWindows, dirtyWindows, unreadableWindows };
  }

  public async dispose(): Promise<void> {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    if (this.operationHeartbeat) clearInterval(this.operationHeartbeat);
    this.timer = undefined;
    this.operationHeartbeat = undefined;
    await this.operationRefresh;
    this.operationRefresh = undefined;
    await this.currentTick?.catch(() => undefined);
    await this.presenceWrite.catch(() => undefined);
    await fs.rm(this.presencePath, { force: true });
    const lease = parseLease(await readJson(this.leasePath));
    if (lease?.instanceId === this.instanceId) await fs.rm(this.leasePath, { force: true });
    this.setLeader(false);
  }

  private async runTick(): Promise<void> {
    if (this.ticking || !this.started) return;
    this.ticking = true;
    const tick = this.tick();
    this.currentTick = tick;
    try {
      await tick;
    } catch (error) {
      this.emitCoordinationError(error);
    } finally {
      this.ticking = false;
      this.currentTick = undefined;
    }
  }

  private async tick(): Promise<void> {
    await this.writePresence();
    await this.electLeader();
    if (this.leader) await this.claimSyncRequests();
    await this.consumeSharedFiles();
    const safety = await this.windowSafety();
    const signature = `${safety.activeWindows}:${safety.dirtyWindows}:${safety.unreadableWindows}`;
    if (signature !== this.lastWindowSignature) {
      this.lastWindowSignature = signature;
      this.emit('windowsChanged', safety);
    }
  }

  private async electLeader(): Promise<void> {
    const lease = parseLease(await readJson(this.leasePath));
    if (lease?.instanceId === this.instanceId && lease.token) {
      if (await this.refreshLease(lease.token)) {
        this.setLeader(true);
        return;
      }
    }

    const stat = await fs.stat(this.leasePath).catch(() => undefined);
    const invalidStale = stat && !lease && this.now() - stat.mtimeMs > this.leaseTtlMs;
    const expired = lease && (!this.processAlive(lease.pid) || this.now() - lease.updatedAt > this.leaseTtlMs);
    if (invalidStale || expired) await quarantineAndRemove(this.leasePath);

    try {
      const token = randomUUID();
      const handle = await fs.open(this.leasePath, 'wx');
      try {
        await handle.writeFile(JSON.stringify({
          schemaVersion: 2,
          token,
          instanceId: this.instanceId,
          pid: process.pid,
          updatedAt: this.now(),
        } satisfies Lease));
      } finally {
        await handle.close();
      }
      this.setLeader(true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      this.setLeader(false);
    }
  }

  private setLeader(value: boolean): void {
    if (this.leader === value) return;
    this.leader = value;
    this.emit(value ? 'becameLeader' : 'becameFollower');
  }

  private async refreshLease(token: string): Promise<boolean> {
    return updateOwnedFile(this.leasePath, token, (current) => ({
      ...current,
      schemaVersion: 2,
      updatedAt: this.now(),
    }));
  }

  private async writePresence(): Promise<void> {
    const write = this.presenceWrite.catch(() => undefined).then(() => atomicWriteJson(this.presencePath, {
      schemaVersion: 2,
      instanceId: this.instanceId,
      pid: process.pid,
      updatedAt: this.now(),
      dirtyDocuments: this.dirtyDocuments,
    } satisfies WindowPresence));
    this.presenceWrite = write;
    await write;
  }

  private async claimSyncRequests(): Promise<void> {
    const entries = await fs.readdir(this.runtimePath).catch(() => [] as string[]);
    let requested = false;
    for (const entry of entries) {
      if (!entry.startsWith('sync-request-') && !entry.startsWith('sync-processing-')) continue;
      if (!entry.endsWith('.json')) continue;
      const source = path.join(this.runtimePath, entry);
      if (this.claimedRequests.has(source)) continue;
      const requestId = randomUUID();
      const target = path.join(this.runtimePath, `sync-processing-${this.instanceId}-${requestId}.json`);
      try {
        await fs.rename(source, target);
        this.claimedRequests.add(target);
        requested = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (requested) this.emit('syncRequested');
  }

  private async consumeSharedFiles(): Promise<void> {
    const configurationRevision = parseConfigurationRevision(await readJson(this.configurationRevisionPath));
    if (configurationRevision && configurationRevision.revision !== this.lastConfigurationRevision) {
      this.lastConfigurationRevision = configurationRevision.revision;
      this.emit('configurationChanged');
    }
    if (this.leader) return;
    const sharedStatus = parseSharedStatus(await readJson(this.sharedStatusPath));
    if (sharedStatus && sharedStatus.revision !== this.lastStatusRevision) {
      this.lastStatusRevision = sharedStatus.revision;
      this.emit('statusChanged', {
        sync: sharedStatus.sync,
        link: sharedStatus.link,
        profiles: sharedStatus.profiles,
        pendingChanges: sharedStatus.pendingChanges,
        lastSyncAt: sharedStatus.lastSyncAt,
        message: sharedStatus.message,
      } satisfies Partial<RuntimeStatus>);
    }
  }

  private async acquireOperation(token: string, startedAt: number, attempt = 0): Promise<boolean> {
    // 抢占失效锁后需要重新创建，限制次数避免与其他窗口持续互相抢占时无限递归。
    if (attempt >= MAX_OPERATION_ACQUIRE_ATTEMPTS) return false;
    try {
      const handle = await fs.open(this.operationPath, 'wx');
      try {
        await handle.writeFile(JSON.stringify({
          schemaVersion: 2,
          token,
          instanceId: this.instanceId,
          pid: process.pid,
          startedAt,
          updatedAt: this.now(),
        } satisfies OperationLock));
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    const before = await this.operationSignature();
    if (!before) return false;
    const operation = parseOperation(await readJson(this.operationPath));
    if (operation && this.processAlive(operation.pid)) {
      const presence = await this.findPresence(operation.instanceId);
      const updatedAt = operation.updatedAt ?? operation.startedAt;
      if (this.now() - updatedAt <= this.leaseTtlMs || presence) return false;
    } else if (!operation) {
      const stat = await fs.stat(this.operationPath).catch(() => undefined);
      if (stat && this.now() - stat.mtimeMs <= this.leaseTtlMs) return false;
    }

    if (operation && !this.processAlive(operation.pid)) {
      if (await quarantineIfUnchanged(this.operationPath, before)) return this.acquireOperation(token, startedAt, attempt + 1);
      return false;
    }

    await delay(this.staleConfirmationMs);
    const after = await this.operationSignature();
    if (!after || after !== before) return false;
    if (await quarantineIfUnchanged(this.operationPath, after)) return this.acquireOperation(token, startedAt, attempt + 1);
    return false;
  }

  private async refreshOperation(token: string, startedAt: number): Promise<void> {
    await updateOwnedFile(this.operationPath, token, (current) => ({
      ...current,
      schemaVersion: 2,
      instanceId: this.instanceId,
      pid: process.pid,
      startedAt,
      updatedAt: this.now(),
    }));
  }

  private async removeOwnedOperation(token: string): Promise<void> {
    const operation = parseOperation(await readJson(this.operationPath));
    if (operation?.token === token) await fs.rm(this.operationPath, { force: true });
  }

  private async operationSignature(): Promise<string | undefined> {
    const operation = parseOperation(await readJson(this.operationPath));
    if (operation) return `${operation.token ?? 'legacy'}:${operation.instanceId}:${operation.pid}:${operation.updatedAt ?? operation.startedAt}`;
    const stat = await fs.stat(this.operationPath).catch(() => undefined);
    return stat ? `invalid:${stat.size}:${stat.mtimeMs}` : undefined;
  }

  private async findPresence(instanceId: string): Promise<WindowPresence | undefined> {
    const presence = parsePresence(await readJson(path.join(this.runtimePath, `window-${instanceId}.json`)));
    if (!presence || this.now() - presence.updatedAt > this.leaseTtlMs) return undefined;
    return presence;
  }

  private emitCoordinationError(error: unknown): void {
    this.emit('coordinationError', error instanceof Error ? error : new Error(String(error)));
  }
}

function parseLease(value: unknown): Lease | undefined {
  if (!isRecord(value) || typeof value.instanceId !== 'string' || !integerPid(value.pid) || typeof value.updatedAt !== 'number') return undefined;
  if (value.token !== undefined && typeof value.token !== 'string') return undefined;
  return value as unknown as Lease;
}

function parseOperation(value: unknown): OperationLock | undefined {
  if (!isRecord(value) || typeof value.instanceId !== 'string' || !integerPid(value.pid) || typeof value.startedAt !== 'number') return undefined;
  if (value.token !== undefined && typeof value.token !== 'string') return undefined;
  if (value.updatedAt !== undefined && typeof value.updatedAt !== 'number') return undefined;
  return value as unknown as OperationLock;
}

function parsePresence(value: unknown): WindowPresence | undefined {
  if (!isRecord(value) || typeof value.instanceId !== 'string' || !validPid(value.pid) || typeof value.updatedAt !== 'number') return undefined;
  if (value.dirtyDocuments !== undefined
    && (typeof value.dirtyDocuments !== 'number' || !Number.isInteger(value.dirtyDocuments) || value.dirtyDocuments < 0)) return undefined;
  return value as unknown as WindowPresence;
}

function parseSharedStatus(value: unknown): SharedStatus | undefined {
  if (!isRecord(value) || value.schemaVersion !== 3 || typeof value.revision !== 'string' || typeof value.updatedAt !== 'number') return undefined;
  const sync = parseSyncState(value.sync);
  if (!sync) return undefined;
  if (typeof value.link !== 'string' || !LINK_STATES.has(value.link as LinkState)) return undefined;
  if (!Array.isArray(value.profiles) || !value.profiles.every((profile) => typeof profile === 'string')) return undefined;
  if (typeof value.pendingChanges !== 'number' || !Number.isInteger(value.pendingChanges) || value.pendingChanges < 0) return undefined;
  if (value.lastSyncAt !== undefined && typeof value.lastSyncAt !== 'string') return undefined;
  if (value.message !== undefined && typeof value.message !== 'string') return undefined;
  return { ...(value as unknown as SharedStatus), sync };
}

function parseSyncState(value: unknown): SyncState | undefined {
  if (!isRecord(value) || typeof value.kind !== 'string') return undefined;
  switch (value.kind) {
    case 'disabled':
    case 'unconfigured':
    case 'idle':
    case 'failed':
      return { kind: value.kind };
    case 'running':
      return typeof value.stage === 'string' && STAGE_NAMES.has(value.stage as StageName)
        ? { kind: 'running', stage: value.stage as StageName }
        : undefined;
    case 'blocked':
      return typeof value.reason === 'string' && BLOCK_REASONS.has(value.reason as BlockReason)
        ? { kind: 'blocked', reason: value.reason as BlockReason }
        : undefined;
    default:
      return undefined;
  }
}

function parseConfigurationRevision(value: unknown): ConfigurationRevision | undefined {
  if (!isRecord(value) || value.schemaVersion !== 2 || typeof value.revision !== 'string') return undefined;
  if (typeof value.instanceId !== 'string' || typeof value.updatedAt !== 'number') return undefined;
  return value as unknown as ConfigurationRevision;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validPid(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function integerPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function updateOwnedFile(
  filePath: string,
  token: string,
  update: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<boolean> {
  try {
    const handle = await fs.open(filePath, 'r+');
    try {
      const current = JSON.parse(await handle.readFile('utf8')) as unknown;
      if (!isRecord(current) || current.token !== token) return false;
      await handle.truncate(0);
      await handle.write(JSON.stringify(update(current)), 0, 'utf8');
      return true;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return false;
    throw error;
  }
}

async function quarantineAndRemove(filePath: string): Promise<void> {
  const quarantine = `${filePath}.stale-${randomUUID()}`;
  try {
    await fs.rename(filePath, quarantine);
    await fs.rm(quarantine, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function quarantineIfUnchanged(filePath: string, signature: string): Promise<boolean> {
  const quarantine = `${filePath}.stale-${randomUUID()}`;
  try {
    await fs.rename(filePath, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const current = await signatureForFile(quarantine);
  if (current === signature) {
    await fs.rm(quarantine, { force: true });
    return true;
  }
  try {
    await fs.rename(quarantine, filePath);
  } catch {
    await fs.rm(quarantine, { force: true }).catch(() => undefined);
  }
  return false;
}

async function signatureForFile(filePath: string): Promise<string | undefined> {
  const operation = parseOperation(await readJson(filePath));
  if (operation) return `${operation.token ?? 'legacy'}:${operation.instanceId}:${operation.pid}:${operation.updatedAt ?? operation.startedAt}`;
  const stat = await fs.stat(filePath).catch(() => undefined);
  return stat ? `invalid:${stat.size}:${stat.mtimeMs}` : undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
