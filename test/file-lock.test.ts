import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { atomicWriteJson, readJsonFile } from '../src/json-store';
import { withFileLock } from '../src/file-lock';

test('共享 JSON 存储写入完整内容并忽略损坏文件', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-json-store-'));
  const target = path.join(root, 'nested', 'state.json');
  try {
    await atomicWriteJson(target, { schemaVersion: 2, branch: 'main' });
    assert.deepEqual(await readJsonFile(target), { schemaVersion: 2, branch: 'main' });
    await atomicWriteJson(target, { schemaVersion: 2, branch: 'dev' });
    assert.deepEqual(await readJsonFile(target), { schemaVersion: 2, branch: 'dev' });
    assert.deepEqual((await readdir(path.dirname(target))), ['state.json']);
    assert.equal(await readJsonFile(path.join(root, 'missing.json')), undefined);
    await writeFile(path.join(root, 'broken.json'), '{');
    assert.equal(await readJsonFile(path.join(root, 'broken.json')), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('文件锁只在持有者已退出或长期不释放时才被清理', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-lock-'));
  const lockPath = path.join(root, 'busy.lock');
  try {
    // 持有者仍在运行且未超过残留判定时长：必须等待并最终超时，不能抢锁并行写同一份文件。
    await writeFile(lockPath, JSON.stringify({ token: 'other', pid: process.pid, createdAt: Date.now() }));
    await assert.rejects(
      () => withFileLock(lockPath, async () => undefined, { timeoutMs: 120, staleMs: 60_000, busyMessage: '锁被占用' }),
      /锁被占用/,
    );

    // 持有者已退出：无需等待残留时长即可接管，避免进程被强杀后所有窗口都写不进配置。
    await writeFile(lockPath, JSON.stringify({ token: 'dead', pid: 2_147_483_646, createdAt: Date.now() }));
    let entered = false;
    await withFileLock(lockPath, async () => { entered = true; }, { timeoutMs: 500, staleMs: 60_000 });
    assert.equal(entered, true);

    // 持有者卡死不释放时用时长兜底，否则一个挂起的进程会永久阻塞其它窗口。
    await writeFile(lockPath, JSON.stringify({ token: 'stuck', pid: process.pid, createdAt: Date.now() - 3_600_000 }));
    let recovered = false;
    await withFileLock(lockPath, async () => { recovered = true; }, { timeoutMs: 500, staleMs: 60_000 });
    assert.equal(recovered, true);

    // 空锁文件没有 pid，只能按修改时间判定残留，否则共享状态会永久无法写入。
    await writeFile(lockPath, '');
    await utimes(lockPath, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    let emptyRecovered = false;
    await withFileLock(lockPath, async () => { emptyRecovered = true; }, { timeoutMs: 500, staleMs: 60_000 });
    assert.equal(emptyRecovered, true);

    await writeFile(lockPath, '{');
    await utimes(lockPath, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    let brokenRecovered = false;
    await withFileLock(lockPath, async () => { brokenRecovered = true; }, { timeoutMs: 500, staleMs: 60_000 });
    assert.equal(brokenRecovered, true);

    // 刚创建的空锁视为写入中途，不能立刻抢走。
    await writeFile(lockPath, '');
    await assert.rejects(
      () => withFileLock(lockPath, async () => undefined, { timeoutMs: 120, staleMs: 60_000, busyMessage: '锁被占用' }),
      /锁被占用/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
