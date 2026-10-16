import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { MultiWindowCoordinator } from '../src/coordinator';
import { BLOCK_REASONS, SyncState } from '../src/types';
import { waitFor } from './helpers';

test('同一运行目录只选出一个 leader', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-'));
  const first = new MultiWindowCoordinator(root);
  const second = new MultiWindowCoordinator(root);
  try {
    await Promise.all([first.start(), second.start()]);
    assert.equal(Number(first.isLeader) + Number(second.isLeader), 1);
    assert.equal((await first.windowSafety()).activeWindows, 2);
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
    await rm(root, { recursive: true, force: true });
  }
});

test('默认 Profile 窗口接管已存在的命名 Profile leader，并接收转发请求', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-preferred-leader-'));
  const options = { heartbeatMs: 20, leaseTtlMs: 1_000 };
  const named = new MultiWindowCoordinator(root, options);
  const preferred = new MultiWindowCoordinator(root, { ...options, preferredLeader: true });
  try {
    await named.start();
    assert.equal(named.isLeader, true);
    await preferred.start();
    await waitFor(() => preferred.isLeader && !named.isLeader);
    let requests = 0;
    preferred.on('syncRequested', () => { requests += 1; });
    await named.requestSync();
    await waitFor(() => requests > 0);
    assert.equal(named.isLeader, false);
    assert.equal(preferred.isLeader, true);
    await preferred.dispose();
    await waitFor(() => named.isLeader);
  } finally {
    await Promise.all([named.dispose(), preferred.dispose()]);
    await rm(root, { recursive: true, force: true });
  }
});

test('默认 Profile 接管前等待旧 leader 的独占操作完成', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-leader-handover-'));
  const options = { heartbeatMs: 20, leaseTtlMs: 1_000 };
  const named = new MultiWindowCoordinator(root, options);
  const preferred = new MultiWindowCoordinator(root, { ...options, preferredLeader: true });
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => { release = resolve; });
  let operation: Promise<boolean> | undefined;
  try {
    await named.start();
    let entered = false;
    operation = named.runExclusive(async () => { entered = true; await blocker; });
    await waitFor(() => entered);
    await preferred.start();
    let observed = false;
    named.on('windowsChanged', () => { observed = true; });
    await waitFor(() => observed);
    assert.equal(named.isLeader, true);
    assert.equal(preferred.isLeader, false);
    release();
    assert.equal(await operation, true);
    await waitFor(() => preferred.isLeader && !named.isLeader);
  } finally {
    release();
    await operation;
    await Promise.all([named.dispose(), preferred.dispose()]);
    await rm(root, { recursive: true, force: true });
  }
});

test('多个默认 Profile 窗口竞争时仍只有一个 leader，失效优先窗口不阻止接管', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-preferred-race-'));
  const options = { heartbeatMs: 20, leaseTtlMs: 1_000, preferredLeader: true };
  const first = new MultiWindowCoordinator(root, options);
  const second = new MultiWindowCoordinator(root, options);
  const named = new MultiWindowCoordinator(root, { ...options, preferredLeader: false });
  try {
    await Promise.all([first.start(), second.start(), named.start()]);
    await waitFor(() => first.isLeader || second.isLeader);
    assert.equal(Number(first.isLeader) + Number(second.isLeader) + Number(named.isLeader), 1);
    await Promise.all([first.dispose(), second.dispose()]);
    await writeFile(path.join(root, 'window-expired.json'), JSON.stringify({
      instanceId: 'expired', pid: process.pid, updatedAt: Date.now() - 10_000, preferredLeader: true,
    }));
    await waitFor(() => named.isLeader);
  } finally {
    await Promise.all([first.dispose(), second.dispose(), named.dispose()]);
    await rm(root, { recursive: true, force: true });
  }
});

test('新 leader 会立即接管死亡进程租约并清理孤儿操作锁', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-orphan-'));
  await writeFile(path.join(root, 'coordinator.lease.json'), JSON.stringify({
    instanceId: 'dead-instance',
    pid: -1,
    updatedAt: Date.now()
  }));
  const coordinator = new MultiWindowCoordinator(root, { leaseTtlMs: 5, staleConfirmationMs: 5 });
  try {
    await coordinator.start();
    assert.equal(coordinator.isLeader, true);
    await writeFile(path.join(root, 'sync.operation.json'), JSON.stringify({
      instanceId: 'old-leader',
      pid: process.pid,
      startedAt: Date.now() - 100,
      updatedAt: Date.now() - 100
    }));
    let executed = false;
    assert.equal(await coordinator.runExclusive(async () => { executed = true; }), true);
    assert.equal(executed, true);
  } finally {
    await coordinator.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('leader 切换事件触发时角色已经更新', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-failover-'));
  const options = { heartbeatMs: 20, leaseTtlMs: 80, staleConfirmationMs: 20 };
  const first = new MultiWindowCoordinator(root, options);
  const second = new MultiWindowCoordinator(root, options);
  try {
    await Promise.all([first.start(), second.start()]);
    const leader = first.isLeader ? first : second;
    const follower = first.isLeader ? second : first;
    let leaderStateDuringEvent = false;
    follower.on('becameLeader', () => { leaderStateDuringEvent = follower.isLeader; });
    await leader.dispose();
    await waitFor(() => follower.isLeader);
    assert.equal(leaderStateDuringEvent, true);
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
    await rm(root, { recursive: true, force: true });
  }
});

test('仍在心跳期的操作锁不会因 leader 变化被抢占', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-live-operation-'));
  const coordinator = new MultiWindowCoordinator(root, { leaseTtlMs: 50, staleConfirmationMs: 10 });
  try {
    await coordinator.start();
    await writeFile(path.join(root, 'sync.operation.json'), JSON.stringify({
      schemaVersion: 2,
      token: 'live-operation',
      instanceId: 'previous-leader',
      pid: process.pid,
      startedAt: Date.now(),
      updatedAt: Date.now()
    }));
    let executed = false;
    assert.equal(await coordinator.runExclusive(async () => { executed = true; }), false);
    assert.equal(executed, false);
  } finally {
    await coordinator.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('操作锁写入中的空文件按占用处理', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-partial-operation-'));
  const coordinator = new MultiWindowCoordinator(root, { leaseTtlMs: 50, staleConfirmationMs: 10 });
  try {
    await coordinator.start();
    await writeFile(path.join(root, 'sync.operation.json'), '');
    assert.equal(await coordinator.runExclusive(async () => assert.fail('不应进入并发操作')), false);
  } finally {
    await coordinator.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('多个调用同时竞争时只执行一个操作', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-exclusive-'));
  const coordinator = new MultiWindowCoordinator(root);
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => { release = resolve; });
  try {
    await coordinator.start();
    let executions = 0;
    const first = coordinator.runExclusive(async () => {
      executions += 1;
      await blocker;
    });
    await waitFor(async () => readFile(path.join(root, 'sync.operation.json'), 'utf8').then(() => true, () => false));
    const second = await coordinator.runExclusive(async () => { executions += 1; });
    release();
    assert.equal(await first, true);
    assert.equal(second, false);
    assert.equal(executions, 1);
  } finally {
    release();
    await coordinator.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('窗口 presence 汇总未保存配置和无法读取状态', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-presence-'));
  const first = new MultiWindowCoordinator(root);
  const second = new MultiWindowCoordinator(root);
  try {
    await first.setDirtyDocuments(0);
    await second.setDirtyDocuments(2);
    await Promise.all([first.start(), second.start()]);
    const safety = await first.windowSafety();
    assert.deepEqual(safety, { activeWindows: 2, dirtyWindows: 1, unreadableWindows: 0 });
    await writeFile(path.join(root, 'window-unreadable.json'), '{');
    assert.deepEqual(await first.windowSafety(), { activeWindows: 3, dirtyWindows: 1, unreadableWindows: 1 });
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
    await rm(root, { recursive: true, force: true });
  }
});

test('leader 发布的同步状态会传播给 follower', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-status-'));
  const options = { heartbeatMs: 20, leaseTtlMs: 80 };
  const first = new MultiWindowCoordinator(root, options);
  const second = new MultiWindowCoordinator(root, options);
  try {
    await Promise.all([first.start(), second.start()]);
    const leader = first.isLeader ? first : second;
    const follower = first.isLeader ? second : first;
    let received: { lastSyncAt?: string } | undefined;
    follower.on('statusChanged', (value) => { received = value as { lastSyncAt?: string }; });
    await leader.publishStatus({
      sync: { kind: 'idle' },
      link: 'in-sync',
      role: 'leader',
      activeWindows: 2,
      profiles: ['默认'],
      pendingChanges: 0,
      lastSyncAt: '2026-08-09T04:44:35.000Z'
    });
    await waitFor(() => received?.lastSyncAt === '2026-08-09T04:44:35.000Z');
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
    await rm(root, { recursive: true, force: true });
  }
});

test('需要用户处理的阻塞状态同样会传播给 follower', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-status-blocked-'));
  const options = { heartbeatMs: 20, leaseTtlMs: 80 };
  const first = new MultiWindowCoordinator(root, options);
  const second = new MultiWindowCoordinator(root, options);
  try {
    await Promise.all([first.start(), second.start()]);
    const leader = first.isLeader ? first : second;
    const follower = first.isLeader ? second : first;
    let received: SyncState | undefined;
    follower.on('statusChanged', (value) => { received = (value as { sync: SyncState }).sync; });
    // follower 的选择面板靠这份状态显示，任何一种阻塞原因被拒收都会让它停在旧状态。
    for (const reason of BLOCK_REASONS) {
      await leader.publishStatus({
        sync: { kind: 'blocked', reason },
        link: 'in-sync',
        role: 'leader',
        activeWindows: 2,
        profiles: ['默认'],
        pendingChanges: 0,
      });
      await waitFor(() => received?.kind === 'blocked' && received.reason === reason);
    }
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
    await rm(root, { recursive: true, force: true });
  }
});

test('任一窗口保存配置后会通知其他窗口重新加载', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-configuration-'));
  const options = { heartbeatMs: 20, leaseTtlMs: 80 };
  const first = new MultiWindowCoordinator(root, options);
  const second = new MultiWindowCoordinator(root, options);
  try {
    await Promise.all([first.start(), second.start()]);
    let notifications = 0;
    first.on('configurationChanged', () => { notifications += 1; });
    await second.notifyConfigurationChanged();
    await waitFor(() => notifications > 0);
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
    await rm(root, { recursive: true, force: true });
  }
});

test('leader 切换后仍会恢复未完成的同步请求', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-request-'));
  const options = { heartbeatMs: 20, leaseTtlMs: 80 };
  const first = new MultiWindowCoordinator(root, options);
  const second = new MultiWindowCoordinator(root, options);
  try {
    await Promise.all([first.start(), second.start()]);
    const leader = first.isLeader ? first : second;
    const follower = first.isLeader ? second : first;
    let leaderRequests = 0;
    let followerRequests = 0;
    leader.on('syncRequested', () => { leaderRequests += 1; });
    follower.on('syncRequested', () => { followerRequests += 1; });
    await follower.requestSync();
    await waitFor(() => leaderRequests > 0);
    await leader.dispose();
    await waitFor(() => follower.isLeader && followerRequests > 0);
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
    await rm(root, { recursive: true, force: true });
  }
});
