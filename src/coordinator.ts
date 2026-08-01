import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

interface Lease {
  instanceId: string;
  pid: number;
  updatedAt: number;
}

interface OperationLock {
  instanceId: string;
  pid: number;
  startedAt: number;
}

const HEARTBEAT_MS = 5_000;
const LEASE_TTL_MS = 20_000;

export class MultiWindowCoordinator extends EventEmitter {
  public readonly instanceId = randomUUID();
  private readonly leasePath: string;
  private readonly presencePath: string;
  private readonly operationPath: string;
  private timer?: NodeJS.Timeout;
  private leader = false;

  public constructor(private readonly runtimePath: string) {
    super();
    this.leasePath = path.join(runtimePath, 'coordinator.lease.json');
    this.presencePath = path.join(runtimePath, `window-${this.instanceId}.json`);
    this.operationPath = path.join(runtimePath, 'sync.operation.json');
  }

  public get isLeader(): boolean {
    return this.leader;
  }

  public async start(): Promise<void> {
    await fs.mkdir(this.runtimePath, { recursive: true });
    await this.tick();
    this.timer = setInterval(() => void this.tick(), HEARTBEAT_MS);
  }

  public async requestSync(): Promise<void> {
    if (this.leader) {
      this.emit('syncRequested');
      return;
    }
    await fs.writeFile(
      path.join(this.runtimePath, `sync-request-${this.instanceId}.json`),
      JSON.stringify({ instanceId: this.instanceId, requestedAt: Date.now() }),
      'utf8'
    );
  }

  public async runExclusive(action: () => Promise<void>): Promise<boolean> {
    try {
      const handle = await fs.open(this.operationPath, 'wx');
      await handle.writeFile(JSON.stringify({ instanceId: this.instanceId, pid: process.pid, startedAt: Date.now() }));
      await handle.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const operation = await readJson<OperationLock>(this.operationPath);
        const lease = await readJson<Lease>(this.leasePath);
        const stale = !operation
          || !isProcessAlive(operation.pid)
          || lease?.instanceId !== operation.instanceId
          || Date.now() - operation.startedAt > 10 * 60_000;
        if (stale) {
          await fs.rm(this.operationPath, { force: true });
          return this.runExclusive(action);
        }
        return false;
      }
      throw error;
    }
    try {
      await action();
      return true;
    } finally {
      await fs.rm(this.operationPath, { force: true });
    }
  }

  public async activeWindowCount(): Promise<number> {
    const entries = await fs.readdir(this.runtimePath).catch(() => []);
    let count = 0;
    for (const entry of entries.filter((name) => /^window-.+\.json$/.test(name))) {
      const filePath = path.join(this.runtimePath, entry);
      const stat = await fs.stat(filePath).catch(() => undefined);
      if (stat && Date.now() - stat.mtimeMs <= LEASE_TTL_MS) count += 1;
      else await fs.rm(filePath, { force: true }).catch(() => undefined);
    }
    return count;
  }

  public async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await fs.rm(this.presencePath, { force: true });
    if (this.leader) {
      const lease = await readJson<Lease>(this.leasePath);
      if (lease?.instanceId === this.instanceId) await fs.rm(this.leasePath, { force: true });
    }
    this.leader = false;
  }

  private async tick(): Promise<void> {
    await fs.writeFile(this.presencePath, JSON.stringify({ instanceId: this.instanceId, pid: process.pid, updatedAt: Date.now() }), 'utf8');
    const lease = await readJson<Lease>(this.leasePath);
    if (lease?.instanceId === this.instanceId) {
      this.leader = true;
      await fs.writeFile(this.leasePath, JSON.stringify({ ...lease, updatedAt: Date.now() }), 'utf8');
      await this.consumeRequest();
      return;
    }

    if (!lease || !isProcessAlive(lease.pid) || Date.now() - lease.updatedAt > LEASE_TTL_MS) {
      if (lease) await fs.rm(this.leasePath, { force: true }).catch(() => undefined);
      try {
        const handle = await fs.open(this.leasePath, 'wx');
        await handle.writeFile(JSON.stringify({ instanceId: this.instanceId, pid: process.pid, updatedAt: Date.now() }));
        await handle.close();
        if (!this.leader) this.emit('becameLeader');
        this.leader = true;
        await this.consumeRequest();
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    if (this.leader) this.emit('becameFollower');
    this.leader = false;
  }

  private async consumeRequest(): Promise<void> {
    const entries = await fs.readdir(this.runtimePath).catch(() => []);
    const requests = entries.filter((entry) => entry.startsWith('sync-request-') && entry.endsWith('.json'));
    if (!requests.length) return;
    await Promise.all(requests.map((entry) => fs.rm(path.join(this.runtimePath, entry), { force: true })));
    this.emit('syncRequested');
  }
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

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}
