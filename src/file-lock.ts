import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { readJsonFile as readJson } from './json-store';

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_STALE_MS = 30_000;

export interface FileLockOptions {
  /** 等待锁的最长时间，超时抛出 busyMessage。 */
  timeoutMs?: number;
  /** 超过此时长且持有进程已退出的锁视为残留，可强制清除。 */
  staleMs?: number;
  busyMessage?: string;
}

/**
 * 以独占方式创建锁文件后执行 action，结束时只删除自己持有的锁。
 * 跨窗口共享的状态文件都要走这里，避免读-改-写之间被其他窗口插入。
 */
export async function withFileLock<T>(lockPath: string, action: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const busyMessage = options.busyMessage ?? '共享状态正在被其他窗口更新，请稍后重试。';
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      try {
        await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }));
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const lock = await readJson(lockPath);
      if (isStaleLock(lock, staleMs)) {
        await fs.rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(busyMessage);
      await delay(50);
    }
  }
  try {
    return await action();
  } finally {
    const lock = await readJson(lockPath);
    if (isRecord(lock) && lock.token === token) await fs.rm(lockPath, { force: true });
  }
}

function isStaleLock(value: unknown, staleMs: number): boolean {
  if (!isRecord(value) || typeof value.pid !== 'number' || typeof value.createdAt !== 'number') return false;
  // 先确认持有者是否还活着：活进程持有的锁不能因为耗时长就被抢走，否则两个窗口会并行写同一份文件。
  try {
    process.kill(value.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return true;
  }
  // 进程仍在，但长时间不释放通常意味着 pid 已被系统复用或持有者卡死，用时间兜底避免永久阻塞。
  return Date.now() - value.createdAt > staleMs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
