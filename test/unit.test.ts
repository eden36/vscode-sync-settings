import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type * as vscode from 'vscode';
import { MultiWindowCoordinator } from '../src/coordinator';
import { ConfigurationStore } from '../src/configuration';
import { parseUtilityModelSetting } from '../src/ai-model';
import { fallbackCommitMessage } from '../src/sync-fallback';
import { ConfigurationRepositoryGitService } from '../src/git-service';
import { resolveHostStoragePaths } from '../src/host-paths';
import { ProfileAdapter, testing } from '../src/profile-adapter';
import { runProcess } from '../src/process';
import { parseRuntimeState, RuntimeStateStore } from '../src/runtime-state';
import { containsPotentialSecret } from '../src/secret-scanner';
import { atomicWriteJson, readJsonFile } from '../src/json-store';
import { classifyThreeWay, resolveConflictFallback } from '../src/snapshot-conflict';
import {
  compareConfigurationRecords,
  createConfigurationRecord,
  hasEmbeddedCredentials,
  parseConfigurationRecord,
  relateConfigurationRecords,
  resolveRepositoryUrl,
} from '../src/configuration-record';
import { parseExtensionIds, selectMissingExtensionIds, selectRemovableExtensionIds } from '../src/extension-manifest';
import { displayIcon, displayPhase, displayTone, formatRelativeSyncTime } from '../src/sidebar-status';
import { AiService } from '../src/ai';
import { mergeStage } from '../src/pipeline/merge';
import { runPipeline } from '../src/pipeline/pipeline';
import { testing as stageTesting } from '../src/pipeline/stages';
import { Stage, SyncContext, SyncDependencies } from '../src/pipeline/types';
import { createMachine, reduce, SchedulerEvent, SchedulerMachine } from '../src/scheduler';
import { finalSyncMessage } from '../src/sync-message';
import { decideCloudAdopt } from '../src/sync-strategy';
import {
  createSyncReport,
  DEFAULT_CONFIGURATION,
  PluginConfiguration,
  RuntimeStatus,
  SyncConfiguration,
  SyncState,
} from '../src/types';
import { installAndWaitForExtensions, testing as extensionWaitTesting, uninstallRemovedExtensions } from '../src/extension-wait';
import {
  resetApplicationSettings,
  resetExtensionStub,
  markExtensionInstalled,
  markExtensionInstallFailed,
  markExtensionUninstallFailed,
  installCommandCalls,
  uninstallCommandCalls,
} from './vscode-stub';

test('快照路径拒绝目录穿越', () => {
  assert.throws(() => testing.normalizeRelative('../settings.json'), /非法相对路径/);
  assert.throws(() => testing.resolveInside('C:\\safe', '..\\secret'), /路径超出允许范围/);
});

test('集合比较与哈希结果稳定', () => {
  assert.equal(testing.setsEqual(new Set(['a', 'b']), new Set(['b', 'a'])), true);
  assert.equal(testing.setsEqual(new Set(['a']), new Set(['b'])), false);
  assert.equal(testing.sha256(Buffer.from('配置')), testing.sha256(Buffer.from('配置')));
});

test('同一运行目录只选出一个 leader', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-'));
  const first = new MultiWindowCoordinator(root);
  const second = new MultiWindowCoordinator(root);
  try {
    await Promise.all([first.start(), second.start()]);
    assert.equal(Number(first.isLeader) + Number(second.isLeader), 1);
    assert.equal(await first.activeWindowCount(), 2);
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
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

test('扩展在启动后激活并固定运行于 UI extension host', async () => {
  const manifest = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8')) as {
    name?: string;
    displayName?: string;
    activationEvents?: string[];
    extensionKind?: string[];
  };
  assert.equal(manifest.name, 'my-setting-sync');
  assert.equal(manifest.displayName, 'My Setting Sync');
  assert.equal(manifest.activationEvents?.includes('onStartupFinished'), true);
  assert.deepEqual(manifest.extensionKind, ['ui']);
});

test('默认与命名 Profile 解析到同一扩展运行目录', () => {
  const root = path.join(tmpdir(), 'profile-git-sync-storage');
  const extensionId = 'saltcoreyan.my-setting-sync';
  const expected = {
    userDataPath: path.join(root, 'User'),
    runtimePath: path.join(root, 'User', 'globalStorage', extensionId),
  };
  assert.deepEqual(resolveHostStoragePaths(path.join(root, 'User', 'globalStorage', extensionId)), expected);
  assert.deepEqual(resolveHostStoragePaths(path.join(root, 'User', 'profiles', 'abc123', 'globalStorage', extensionId)), expected);
});

test('按 location 枚举命名 Profile，并恢复文件修改和删除', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-adapter-'));
  const userDataPath = path.join(root, 'User');
  const runtimePath = path.join(userDataPath, 'globalStorage', 'local.profile-git-sync');
  const namedPath = path.join(userDataPath, 'profiles', 'abc123');
  await Promise.all([mkdir(runtimePath, { recursive: true }), mkdir(namedPath, { recursive: true })]);
  await writeFile(path.join(userDataPath, 'globalStorage', 'storage.json'), JSON.stringify({
    userDataProfiles: [{ location: 'abc123', name: '开发', useDefaultFlags: { tasks: true } }]
  }));
  await writeFile(path.join(userDataPath, 'settings.json'), '{"editor.fontSize": 15}');
  await writeFile(path.join(namedPath, 'settings.json'), '{"editor.fontSize": 16}');
  const adapter = new ProfileAdapter({ kind: 'vscode', userDataPath, runtimePath });
  const snapshot = path.join(root, 'snapshot');
  try {
    const profiles = await adapter.listProfiles();
    assert.deepEqual(profiles.map((profile) => profile.id), ['default', 'abc123']);
    await adapter.createSnapshot(snapshot);
    await writeFile(path.join(namedPath, 'settings.json'), '{"editor.fontSize": 99}');
    await writeFile(path.join(namedPath, 'tasks.json'), '{}');
    const restored = await adapter.restoreSnapshot(snapshot, false);
    assert.equal(await readFile(path.join(namedPath, 'settings.json'), 'utf8'), '{"editor.fontSize": 16}');
    await assert.rejects(readFile(path.join(namedPath, 'tasks.json')), /ENOENT/);
    assert.equal(restored.structuralChange, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('快照采集宿主级已安装扩展清单，只保留标识且不写回本机', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-adapter-extensions-'));
  const userDataPath = path.join(root, 'User');
  const runtimePath = path.join(userDataPath, 'globalStorage', 'local.profile-git-sync');
  const extensionsRoot = path.join(root, '.cursor', 'extensions');
  const extensionsManifestPath = path.join(extensionsRoot, 'extensions.json');
  await Promise.all([mkdir(runtimePath, { recursive: true }), mkdir(extensionsRoot, { recursive: true })]);
  await writeFile(path.join(userDataPath, 'settings.json'), '{"editor.fontSize": 15}');
  // 真实清单里还有版本号、安装路径和安装时间，这些本机专属字段不应进入仓库。
  await writeFile(extensionsManifestPath, JSON.stringify([
    { identifier: { id: 'ms-python.python', uuid: 'x' }, version: '2024.1.0', location: { path: '/tmp/a' } },
    { identifier: { id: 'anysphere.remote-ssh' }, version: '1.1.14', metadata: { installedTimestamp: 1 } },
    { identifier: { id: 'ms-python.python' }, version: '2024.2.0' },
  ]));

  const adapter = new ProfileAdapter({ kind: 'cursor', userDataPath, runtimePath, extensionsManifestPath });
  const snapshot = path.join(root, 'snapshot');
  try {
    const manifest = await adapter.createSnapshot(snapshot);
    assert.equal(typeof manifest.files['extensions.json'], 'string');
    assert.deepEqual(
      JSON.parse(await readFile(path.join(snapshot, 'extensions.json'), 'utf8')),
      [{ identifier: { id: 'anysphere.remote-ssh' } }, { identifier: { id: 'ms-python.python' } }],
    );

    // 版本升级不改变标识集合，因此不应产生新的快照差异。
    const before = manifest.files['extensions.json'];
    await writeFile(extensionsManifestPath, JSON.stringify([
      { identifier: { id: 'ms-python.python' }, version: '2025.9.9' },
      { identifier: { id: 'anysphere.remote-ssh' }, version: '9.9.9' },
    ]));
    const second = await adapter.createSnapshot(path.join(root, 'snapshot2'));
    assert.equal(second.files['extensions.json'], before);

    // 写回只处理 Profile 文件，绝不覆盖 IDE 维护的扩展清单。
    await writeFile(extensionsManifestPath, '{"sentinel": true}');
    await adapter.restoreSnapshot(snapshot, false);
    assert.equal(await readFile(extensionsManifestPath, 'utf8'), '{"sentinel": true}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('未提供扩展清单路径时快照不含扩展信息', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-adapter-no-extensions-'));
  const userDataPath = path.join(root, 'User');
  const runtimePath = path.join(userDataPath, 'globalStorage', 'local.profile-git-sync');
  await mkdir(runtimePath, { recursive: true });
  await writeFile(path.join(userDataPath, 'settings.json'), '{}');
  try {
    const adapter = new ProfileAdapter({ kind: 'vscode', userDataPath, runtimePath });
    const manifest = await adapter.createSnapshot(path.join(root, 'snapshot'));
    assert.equal(manifest.files['extensions.json'], undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('结构变化且不允许应用时默认不写回任何文件', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-adapter-blocked-'));
  const userDataPath = path.join(root, 'User');
  const runtimePath = path.join(userDataPath, 'globalStorage', 'local.profile-git-sync');
  const namedPath = path.join(userDataPath, 'profiles', 'abc123');
  await Promise.all([mkdir(runtimePath, { recursive: true }), mkdir(namedPath, { recursive: true })]);
  await writeFile(path.join(userDataPath, 'globalStorage', 'storage.json'), JSON.stringify({
    userDataProfiles: [{ location: 'abc123', name: '开发' }]
  }));
  await writeFile(path.join(userDataPath, 'settings.json'), '{"editor.fontSize": 15}');
  await writeFile(path.join(namedPath, 'settings.json'), '{"editor.fontSize": 16}');
  const adapter = new ProfileAdapter({ kind: 'vscode', userDataPath, runtimePath });
  const snapshot = path.join(root, 'snapshot');
  try {
    await adapter.createSnapshot(snapshot);
    await writeFile(path.join(userDataPath, 'globalStorage', 'storage.json'), JSON.stringify({
      userDataProfiles: [
        { location: 'abc123', name: '开发' },
        { location: 'extra456', name: '额外' },
      ]
    }));
    await writeFile(path.join(userDataPath, 'settings.json'), '{"editor.fontSize": 99}');
    const restored = await adapter.restoreSnapshot(snapshot, false);
    assert.equal(restored.structuralChange, true);
    assert.equal(restored.structuralApplied, false);
    assert.equal(restored.changedFiles.length, 0);
    assert.equal(await readFile(path.join(userDataPath, 'settings.json'), 'utf8'), '{"editor.fontSize": 99}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('结构变化被窗口拦住时仍可覆盖共有 Profile 的文件', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-adapter-matching-'));
  const userDataPath = path.join(root, 'User');
  const runtimePath = path.join(userDataPath, 'globalStorage', 'local.profile-git-sync');
  const namedPath = path.join(userDataPath, 'profiles', 'abc123');
  const extraPath = path.join(userDataPath, 'profiles', 'extra456');
  await Promise.all([
    mkdir(runtimePath, { recursive: true }),
    mkdir(namedPath, { recursive: true }),
    mkdir(extraPath, { recursive: true }),
  ]);
  await writeFile(path.join(userDataPath, 'globalStorage', 'storage.json'), JSON.stringify({
    userDataProfiles: [{ location: 'abc123', name: '开发' }]
  }));
  await writeFile(path.join(userDataPath, 'settings.json'), '{"editor.fontSize": 15}');
  await writeFile(path.join(namedPath, 'settings.json'), '{"editor.fontSize": 16}');
  const adapter = new ProfileAdapter({ kind: 'vscode', userDataPath, runtimePath });
  const snapshot = path.join(root, 'snapshot');
  try {
    await adapter.createSnapshot(snapshot);
    await writeFile(path.join(userDataPath, 'globalStorage', 'storage.json'), JSON.stringify({
      userDataProfiles: [
        { location: 'abc123', name: '开发' },
        { location: 'extra456', name: '额外' },
      ]
    }));
    await writeFile(path.join(userDataPath, 'settings.json'), '{"editor.fontSize": 99}');
    await writeFile(path.join(namedPath, 'settings.json'), '{"editor.fontSize": 99}');
    await writeFile(path.join(extraPath, 'settings.json'), '{"editor.fontSize": 42}');
    const restored = await adapter.restoreSnapshot(snapshot, false, true);
    assert.equal(restored.structuralChange, true);
    assert.equal(restored.structuralApplied, false);
    assert.equal(await readFile(path.join(userDataPath, 'settings.json'), 'utf8'), '{"editor.fontSize": 15}');
    assert.equal(await readFile(path.join(namedPath, 'settings.json'), 'utf8'), '{"editor.fontSize": 16}');
    assert.equal(await readFile(path.join(extraPath, 'settings.json'), 'utf8'), '{"editor.fontSize": 42}');
    const storage = JSON.parse(await readFile(path.join(userDataPath, 'globalStorage', 'storage.json'), 'utf8')) as {
      userDataProfiles: Array<{ location: string }>;
    };
    assert.deepEqual(storage.userDataProfiles.map((profile) => profile.location), ['abc123', 'extra456']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('缺少 Profile 元数据时按清单补全并应用结构变化', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-adapter-metadata-'));
  const userDataPath = path.join(root, 'User');
  const runtimePath = path.join(userDataPath, 'globalStorage', 'local.profile-git-sync');
  const extraPath = path.join(userDataPath, 'profiles', 'extra456');
  const snapshot = path.join(root, 'snapshot');
  await Promise.all([
    mkdir(runtimePath, { recursive: true }),
    mkdir(extraPath, { recursive: true }),
    mkdir(path.join(snapshot, 'profiles', 'default'), { recursive: true }),
  ]);
  await writeFile(path.join(userDataPath, 'globalStorage', 'storage.json'), JSON.stringify({
    userDataProfiles: [{ location: 'extra456', name: '插件调试' }]
  }));
  await writeFile(path.join(userDataPath, 'settings.json'), '{"editor.fontSize": 99}');
  await writeFile(path.join(extraPath, 'settings.json'), '{"editor.fontSize": 42}');
  await writeFile(path.join(snapshot, 'profiles', 'default', 'settings.json'), '{"editor.fontSize": 14}');
  await writeFile(path.join(snapshot, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    host: 'vscode',
    createdAt: '',
    profiles: [{ id: 'default', name: '默认', isDefault: true }],
    files: { 'profiles/default/settings.json': testing.sha256(Buffer.from('{"editor.fontSize": 14}', 'utf8')) },
  }, null, 2)}\n`);
  const adapter = new ProfileAdapter({ kind: 'vscode', userDataPath, runtimePath });
  try {
    const restored = await adapter.restoreSnapshot(snapshot, true);
    assert.equal(restored.structuralChange, true);
    assert.equal(restored.structuralApplied, true);
    assert.equal(await readFile(path.join(userDataPath, 'settings.json'), 'utf8'), '{"editor.fontSize": 14}');
    const storage = JSON.parse(await readFile(path.join(userDataPath, 'globalStorage', 'storage.json'), 'utf8')) as {
      userDataProfiles?: Array<{ location: string }>;
    };
    assert.deepEqual(storage.userDataProfiles ?? [], []);
    await assert.rejects(readFile(path.join(extraPath, 'settings.json')), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('缺少元数据但清单含命名 Profile 时按 id 补全并创建目录', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-adapter-synthesize-'));
  const userDataPath = path.join(root, 'User');
  const runtimePath = path.join(userDataPath, 'globalStorage', 'local.profile-git-sync');
  const snapshot = path.join(root, 'snapshot');
  const namedSnapshot = path.join(snapshot, 'profiles', 'abc123');
  await Promise.all([
    mkdir(runtimePath, { recursive: true }),
    mkdir(path.join(userDataPath, 'globalStorage'), { recursive: true }),
    mkdir(namedSnapshot, { recursive: true }),
  ]);
  await writeFile(path.join(userDataPath, 'globalStorage', 'storage.json'), '{}');
  await writeFile(path.join(userDataPath, 'settings.json'), '{"editor.fontSize": 10}');
  await writeFile(path.join(namedSnapshot, 'settings.json'), '{"editor.fontSize": 16}');
  await writeFile(path.join(snapshot, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    host: 'vscode',
    createdAt: '',
    profiles: [
      { id: 'default', name: '默认', isDefault: true },
      { id: 'abc123', name: '开发', isDefault: false },
    ],
    files: { 'profiles/abc123/settings.json': testing.sha256(Buffer.from('{"editor.fontSize": 16}', 'utf8')) },
  }, null, 2)}\n`);
  const adapter = new ProfileAdapter({ kind: 'vscode', userDataPath, runtimePath });
  try {
    const restored = await adapter.restoreSnapshot(snapshot, true);
    assert.equal(restored.structuralApplied, true);
    assert.equal(await readFile(path.join(userDataPath, 'profiles', 'abc123', 'settings.json'), 'utf8'), '{"editor.fontSize": 16}');
    const storage = JSON.parse(await readFile(path.join(userDataPath, 'globalStorage', 'storage.json'), 'utf8')) as {
      userDataProfiles: Array<{ location: string; name: string }>;
    };
    assert.deepEqual(storage.userDataProfiles, [{ location: 'abc123', name: '开发' }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('旧快照缺少元数据时按 Profile 清单补全', () => {
  assert.deepEqual(testing.resolveProfileMetadata({
    schemaVersion: 1,
    host: 'vscode',
    createdAt: '',
    profiles: [
      { id: 'default', name: '默认', isDefault: true },
      { id: 'abc123', name: '开发', isDefault: false },
    ],
    files: {},
  }), [{ location: 'abc123', name: '开发' }]);
  assert.deepEqual(testing.resolveProfileMetadata({
    schemaVersion: 1,
    host: 'vscode',
    createdAt: '',
    profiles: [{ id: 'default', name: '默认', isDefault: true }],
    files: {},
  }), []);
  assert.deepEqual(testing.resolveProfileMetadata({
    schemaVersion: 1,
    host: 'vscode',
    createdAt: '',
    profiles: [{ id: 'default', name: '默认', isDefault: true }],
    profileMetadata: [{ location: 'kept', name: '保留' }],
    files: {},
  }), [{ location: 'kept', name: '保留' }]);
});

test('强制采用云端时缺快照不得回退为本机推送', () => {
  assert.equal(decideCloudAdopt(true, 'synced', true), 'adopt');
  assert.equal(decideCloudAdopt(true, 'cloned', false), 'missing-cloud');
  assert.equal(decideCloudAdopt(false, 'cloned', true), 'adopt');
  assert.equal(decideCloudAdopt(false, 'cloned', false), 'seed-local');
  assert.equal(decideCloudAdopt(false, 'synced', true), 'merge');
});

test('Git 服务通过普通快进推送同步宿主目录', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-git-'));
  const remote = path.join(root, 'remote.git');
  const configuration: SyncConfiguration = {
    repositoryUrl: remote,
    branch: 'main',
    gitUserName: '测试用户',
    gitUserEmail: 'test@example.com'
  };
  try {
    assert.equal((await runProcess('git', ['init', '--bare', remote])).exitCode, 0);
    const first = new ConfigurationRepositoryGitService(path.join(root, 'first'));
    await first.prepare(configuration);
    const hostRoot = path.join(first.repositoryPath, '.profile-git-sync', 'hosts', 'vscode');
    await mkdir(hostRoot, { recursive: true });
    await writeFile(path.join(hostRoot, 'manifest.json'), '{"schemaVersion":1}');
    assert.equal((await first.stageHost('vscode')).length, 1);
    await first.commitAndPush(configuration, 'feat: 初始化配置同步');
    await writeFile(path.join(hostRoot, 'manifest.json'), '{"schemaVersion":2}');
    assert.equal((await runProcess('git', ['-C', first.repositoryPath, 'add', '--', '.profile-git-sync/hosts/vscode'])).exitCode, 0);
    assert.equal(await first.discardPendingHostChanges('vscode'), true);
    assert.equal(
      (await runProcess('git', ['-C', first.repositoryPath, 'status', '--porcelain=v1', '--', '.profile-git-sync/hosts/vscode'])).stdout,
      ''
    );
    assert.equal(await readFile(path.join(hostRoot, 'manifest.json'), 'utf8'), '{"schemaVersion":1}');

    const second = new ConfigurationRepositoryGitService(path.join(root, 'second'));
    await second.prepare(configuration);
    await second.pull(configuration);
    assert.equal(await readFile(path.join(second.repositoryPath, '.profile-git-sync', 'hosts', 'vscode', 'manifest.json'), 'utf8'), '{"schemaVersion":1}');

    const inherited = new ConfigurationRepositoryGitService(path.join(root, 'inherited'));
    const inheritedConfiguration = { ...configuration, gitUserName: '', gitUserEmail: '' };
    await inherited.prepare(inheritedConfiguration);
    assert.notEqual((await runProcess('git', ['-C', inherited.repositoryPath, 'config', '--local', '--get', 'user.name'])).exitCode, 0);
    assert.notEqual((await runProcess('git', ['-C', inherited.repositoryPath, 'config', '--local', '--get', 'user.email'])).exitCode, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('删除配置同步仓库的 .git 不推远端也不删工作区文件', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-remove-git-'));
  const remote = path.join(root, 'remote.git');
  const configuration: SyncConfiguration = {
    repositoryUrl: remote,
    branch: 'main',
    gitUserName: '测试用户',
    gitUserEmail: 'test@example.com',
  };
  try {
    assert.equal((await runProcess('git', ['init', '--bare', remote])).exitCode, 0);
    const first = new ConfigurationRepositoryGitService(path.join(root, 'first'));
    await first.prepare(configuration);
    const hostRoot = path.join(first.repositoryPath, '.profile-git-sync', 'hosts', 'vscode');
    await mkdir(hostRoot, { recursive: true });
    await writeFile(path.join(hostRoot, 'manifest.json'), '{"schemaVersion":1}');
    await first.stageHost('vscode');
    await first.commitAndPush(configuration, 'chore(sync): 初始配置');
    const remoteHead = (await runProcess('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/main'])).stdout;

    await first.removeGitDirectory();
    await assert.rejects(readdir(path.join(first.repositoryPath, '.git')), /ENOENT/);
    assert.equal(await readFile(path.join(hostRoot, 'manifest.json'), 'utf8'), '{"schemaVersion":1}');
    assert.equal((await runProcess('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/main'])).stdout, remoteHead);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('配置同步仓库 Git 操作不会修改当前项目仓库', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-isolation-'));
  const project = path.join(root, 'project');
  const remote = path.join(root, 'remote.git');
  const runtime = path.join(root, 'runtime');
  const configuration: SyncConfiguration = {
    repositoryUrl: remote,
    branch: 'main',
    gitUserName: '测试用户',
    gitUserEmail: 'test@example.com',
  };
  try {
    await mkdir(project, { recursive: true });
    assert.equal((await runProcess('git', ['init', project])).exitCode, 0);
    assert.equal((await runProcess('git', ['-C', project, 'config', 'user.name', '项目用户'])).exitCode, 0);
    assert.equal((await runProcess('git', ['-C', project, 'config', 'user.email', 'project@example.com'])).exitCode, 0);
    await writeFile(path.join(project, 'project.txt'), '项目内容');
    assert.equal((await runProcess('git', ['-C', project, 'add', 'project.txt'])).exitCode, 0);
    assert.equal((await runProcess('git', ['-C', project, 'commit', '-m', '项目初始提交'])).exitCode, 0);
    assert.equal((await runProcess('git', ['init', '--bare', remote])).exitCode, 0);
    const beforeHead = (await runProcess('git', ['-C', project, 'rev-parse', 'HEAD'])).stdout;
    const beforeStatus = (await runProcess('git', ['-C', project, 'status', '--porcelain=v1'])).stdout;
    const beforeRemotes = (await runProcess('git', ['-C', project, 'remote', '-v'])).stdout;

    const repository = new ConfigurationRepositoryGitService(runtime);
    await repository.prepare(configuration);
    const hostRoot = path.join(repository.repositoryPath, '.profile-git-sync', 'hosts', 'vscode');
    await mkdir(hostRoot, { recursive: true });
    await writeFile(path.join(hostRoot, 'manifest.json'), '{"schemaVersion":1}');
    await repository.stageHost('vscode');
    await repository.commitAndPush(configuration, 'chore(sync): 测试配置仓库隔离');

    assert.equal((await runProcess('git', ['-C', project, 'rev-parse', 'HEAD'])).stdout, beforeHead);
    assert.equal((await runProcess('git', ['-C', project, 'status', '--porcelain=v1'])).stdout, beforeStatus);
    assert.equal((await runProcess('git', ['-C', project, 'remote', '-v'])).stdout, beforeRemotes);
    assert.equal(repository.repositoryPath, path.join(runtime, 'repository'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('扩展产物不包含 jsonc-parser 的未打包相对加载', async () => {
  const bundle = await readFile(path.join(process.cwd(), 'dist', 'extension.js'), 'utf8');
  assert.doesNotMatch(bundle, /require\w*\(["']\.\/impl\//);
});

test('解析 chat.utilitySmallModel 的 vendor/id 设置', () => {
  assert.deepEqual(parseUtilityModelSetting('copilot/gpt-4o-mini'), {
    vendor: 'copilot',
    id: 'gpt-4o-mini'
  });
  assert.equal(parseUtilityModelSetting(''), undefined);
  assert.equal(parseUtilityModelSetting('invalid'), undefined);
});

test('AI 不可用时仍可生成稳定的提交信息', () => {
  assert.equal(fallbackCommitMessage('vscode'), 'chore(sync): 同步 VS Code 配置');
  assert.equal(fallbackCommitMessage('cursor'), 'chore(sync): 同步 Cursor 配置');
});

test('冲突回退按本机优先并保证收敛到实际存在的一方', () => {
  assert.equal(resolveConflictFallback('local', 'cloud'), 'local');
  assert.equal(resolveConflictFallback(undefined, 'cloud'), 'cloud');
  assert.equal(resolveConflictFallback('local', undefined), 'local');
  assert.throws(() => resolveConflictFallback(undefined, undefined), /无法自动合并/);
});

test('自动合并后的状态文案说明处理方式并提示备份', () => {
  assert.equal(
    finalSyncMessage({
      ...createSyncReport(),
      changedFileCount: 2,
      merge: { conflicts: ['a', 'b'], aiMerged: ['a'], autoMerged: ['b'] },
    }),
    '同步完成（AI 已自动合并 1 项冲突；1 项冲突按本机优先自动处理；冲突前的两份配置已备份到扩展运行目录）。',
  );
  assert.equal(finalSyncMessage(createSyncReport()), '配置已是最新。');
  assert.equal(
    finalSyncMessage({
      ...createSyncReport(),
      changedFileCount: 1,
      structuralMessage: '远程包含 Profile 增删，只剩一个窗口时会自动应用。',
    }),
    '远程包含 Profile 增删，只剩一个窗口时会自动应用。',
  );
});

test('首次接入的状态文案说明已按云端覆盖并提示备份', () => {
  assert.equal(
    finalSyncMessage({ ...createSyncReport(), adoptedCloud: true }),
    '同步完成（已按云端配置覆盖本机；本机原配置已备份到扩展运行目录）。',
  );
  assert.equal(
    finalSyncMessage({
      ...createSyncReport(),
      adoptedCloud: true,
      structuralMessage: '已按云端覆盖共有 Profile 的配置；远程包含 Profile 增删，只剩一个窗口时会自动应用。',
    }),
    '已按云端覆盖共有 Profile 的配置；远程包含 Profile 增删，只剩一个窗口时会自动应用；已按云端配置覆盖本机；本机原配置已备份到扩展运行目录。',
  );
});

test('状态栏只在同步执行阶段显示忙碌', () => {
  assert.equal(displayIcon({ kind: 'running', stage: 'pull' }, 'in-sync'), '$(sync~spin)');
  assert.equal(displayIcon({ kind: 'running', stage: 'ai' }, 'in-sync'), '$(sync~spin)');
  assert.equal(displayIcon({ kind: 'idle' }, 'in-sync'), '$(check)');
  assert.equal(displayIcon({ kind: 'blocked', reason: 'other-windows' }, 'in-sync'), '$(question)');
});

test('凭据扫描覆盖常见键名与 token 值', () => {
  assert.equal(containsPotentialSecret('{"apiKey":"x"}'), true);
  assert.equal(containsPotentialSecret('{"token":"x"}'), true);
  assert.equal(containsPotentialSecret('{"label":"ghp_1234567890123456789012345678901234"}'), true);
  assert.equal(containsPotentialSecret('{"editor.fontSize":14}'), false);
});

test('仓库地址优先从 secret 读取，并迁移 globalState 中的旧值', () => {
  assert.deepEqual(resolveRepositoryUrl('git@github.com:user/settings.git', {}), {
    repositoryUrl: 'git@github.com:user/settings.git',
    persisted: { branch: 'main', gitUserName: '', gitUserEmail: '' },
    shouldPersistSecret: false
  });
  assert.deepEqual(resolveRepositoryUrl(undefined, {
    repositoryUrl: 'git@github.com:user/settings.git',
    branch: 'dev'
  }), {
    repositoryUrl: 'git@github.com:user/settings.git',
    persisted: { branch: 'dev', gitUserName: '', gitUserEmail: '' },
    shouldPersistSecret: true
  });
});

test('版本化配置区分因果更新与并发修改', () => {
  const configuration: PluginConfiguration = {
    ...DEFAULT_CONFIGURATION,
    repositoryUrl: 'git@github.com:user/settings.git',
  };
  const older = createConfigurationRecord(configuration, 'device-a', 0, 100, 'revision-a');
  const newer = createConfigurationRecord({ ...configuration, branch: 'dev' }, 'device-b', older.logicalTime, 90, 'revision-b', older.clock);
  assert.equal(newer.logicalTime, 101);
  assert.equal(relateConfigurationRecords(older, newer), 'right-newer');
  assert.equal(compareConfigurationRecords(older, newer), -1);
  assert.equal(compareConfigurationRecords(newer, older), 1);

  const concurrentA = createConfigurationRecord({ ...configuration, branch: 'a' }, 'device-a', 0, 200, 'same-time-a');
  const concurrentB = createConfigurationRecord({ ...configuration, branch: 'b' }, 'device-b', 0, 200, 'same-time-b');
  assert.equal(relateConfigurationRecords(concurrentA, concurrentB), 'concurrent');
  const records = [concurrentB, older, concurrentA, newer];
  const winner = records.reduce((left, right) => compareConfigurationRecords(left, right) >= 0 ? left : right);
  assert.equal(winner.revision, 'same-time-b');
});

test('同步配置记录拒绝无效结构和含凭据仓库地址', () => {
  const valid = createConfigurationRecord({
    ...DEFAULT_CONFIGURATION,
    repositoryUrl: 'git@github.com:user/settings.git',
  }, 'device-a', 0, 100, 'revision-a');
  assert.deepEqual(parseConfigurationRecord(valid), valid);
  assert.equal(parseConfigurationRecord({
    ...valid,
    configuration: { ...valid.configuration, repositoryUrl: 'https://user:token@example.com/settings.git' },
  }), undefined);
  assert.equal(parseConfigurationRecord({ ...valid, logicalTime: -1 }), undefined);
  assert.equal(parseConfigurationRecord({ ...valid, configuration: { ...valid.configuration, branch: '../main' } }), undefined);
});

test('独立 Profile 配置实例通过共享锁传播因果更新', async () => {
  resetApplicationSettings();
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-shared-configuration-'));
  const firstState = new Map<string, unknown>();
  const secondState = new Map<string, unknown>();
  const first = new ConfigurationStore(fakeExtensionContext(firstState), root);
  const second = new ConfigurationStore(fakeExtensionContext(secondState), root);
  try {
    await Promise.all([first.initialize(), second.initialize()]);
    const firstConfiguration = {
      ...DEFAULT_CONFIGURATION,
      repositoryUrl: 'git@github.com:user/settings.git',
      branch: 'first',
    };
    const secondConfiguration = {
      ...firstConfiguration,
      branch: 'second',
      pollIntervalSeconds: 900,
    };
    await first.save(firstConfiguration);
    await second.save(secondConfiguration);
    await Promise.all([first.reload(), second.reload()]);
    assert.deepEqual(first.get(), secondConfiguration);
    assert.deepEqual(second.get(), secondConfiguration);
    assert.deepEqual(firstState.get('profileGitSync.syncedConfiguration'), secondState.get('profileGitSync.syncedConfiguration'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('并发同步设置由当前机器配置胜出并合并版本向量', async () => {
  resetApplicationSettings();
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-configuration-concurrent-'));
  const localConfiguration = {
    ...DEFAULT_CONFIGURATION,
    repositoryUrl: 'git@github.com:user/settings.git',
    branch: 'local',
  };
  const cloudConfiguration = {
    ...localConfiguration,
    branch: 'cloud',
    pollIntervalSeconds: 900,
  };
  const local = createConfigurationRecord(localConfiguration, 'device-local', 0, 100, 'local-revision');
  const cloud = createConfigurationRecord(cloudConfiguration, 'device-cloud', 0, 100, 'cloud-revision');
  const state = new Map<string, unknown>([['profileGitSync.syncedConfiguration', cloud]]);
  const store = new ConfigurationStore(fakeExtensionContext(state), root);
  try {
    await writeFile(path.join(root, 'configuration.json'), JSON.stringify(local), 'utf8');
    await store.initialize();
    assert.deepEqual(store.get(), localConfiguration);
    const accepted = parseConfigurationRecord(state.get('profileGitSync.syncedConfiguration'));
    assert.ok(accepted);
    assert.notEqual(accepted.revision, local.revision);
    assert.equal(accepted.clock['device-local'], local.clock['device-local']);
    assert.equal(accepted.clock['device-cloud'], cloud.clock['device-cloud']);
    assert.deepEqual(parseConfigurationRecord(JSON.parse(await readFile(path.join(root, 'configuration.json'), 'utf8'))), accepted);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('内容相同的并发同步设置直接合并版本向量', async () => {
  resetApplicationSettings();
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-configuration-same-concurrent-'));
  const configuration = {
    ...DEFAULT_CONFIGURATION,
    repositoryUrl: 'git@github.com:user/settings.git',
  };
  const local = createConfigurationRecord(configuration, 'device-local', 0, 100, 'local-revision');
  const cloud = createConfigurationRecord(configuration, 'device-cloud', 0, 100, 'cloud-revision');
  const state = new Map<string, unknown>([['profileGitSync.syncedConfiguration', cloud]]);
  const store = new ConfigurationStore(fakeExtensionContext(state), root);
  try {
    await writeFile(path.join(root, 'configuration.json'), JSON.stringify(local), 'utf8');
    await store.initialize();
    const accepted = parseConfigurationRecord(state.get('profileGitSync.syncedConfiguration'));
    assert.ok(accepted);
    assert.deepEqual(accepted.configuration, configuration);
    assert.equal(accepted.clock['device-local'], local.clock['device-local']);
    assert.equal(accepted.clock['device-cloud'], cloud.clock['device-cloud']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('初始化静默清理旧版配置冲突和恢复记录', async () => {
  resetApplicationSettings();
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-legacy-recovery-'));
  const current = createConfigurationRecord({ ...DEFAULT_CONFIGURATION, branch: 'current' }, 'device-a', 0, 100, 'current');
  const backup = createConfigurationRecord({ ...DEFAULT_CONFIGURATION, branch: 'backup' }, 'device-a', 0, 90, 'backup');
  const state = new Map<string, unknown>([['profileGitSync.syncedConfiguration', current]]);
  const store = new ConfigurationStore(fakeExtensionContext(state), root);
  try {
    await writeFile(path.join(root, 'configuration.json'), JSON.stringify(current), 'utf8');
    await writeFile(path.join(root, 'configuration-recovery.json'), JSON.stringify(backup), 'utf8');
    await writeFile(path.join(root, 'configuration-conflict.json'), '{}', 'utf8');
    await store.initialize();
    assert.equal(store.get().branch, 'current');
    await assert.rejects(readFile(path.join(root, 'configuration-recovery.json')), /ENOENT/);
    await assert.rejects(readFile(path.join(root, 'configuration-conflict.json')), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('解析 extensions.json 中的扩展标识', () => {
  assert.deepEqual(parseExtensionIds('[]'), []);
  assert.deepEqual(parseExtensionIds('not-json'), []);
  assert.deepEqual(parseExtensionIds(JSON.stringify([
    { identifier: { id: 'ms-python.python', uuid: 'abc' }, version: '1.0.0' },
    { identifier: { id: 'vscodevim.vim' }, version: '2.0.0' },
    { identifier: {} }
  ])), ['ms-python.python', 'vscodevim.vim']);
});

test('筛选待安装扩展时跳过已安装、需跳过和重复项', () => {
  assert.deepEqual(selectMissingExtensionIds(
    ['ms-python.python', 'vscodevim.vim', 'ms-python.python', 'saltcoreyan.my-setting-sync', ''],
    ['ms-python.python'],
    ['saltcoreyan.my-setting-sync'],
  ), ['vscodevim.vim']);
  assert.deepEqual(selectMissingExtensionIds(['a.b'], ['a.b']), []);
  assert.deepEqual(selectMissingExtensionIds([], ['a.b']), []);
});

test('同步后会调用 IDE 安装尚未存在的扩展', async () => {
  resetExtensionStub();
  extensionWaitTesting.resetSkippedInstallIds();
  markExtensionInstalled('already.present');
  const result = await installAndWaitForExtensions(
    ['already.present', 'ms-python.python', 'saltcoreyan.my-setting-sync'],
    { timeoutMs: 1_000 },
  );
  assert.equal(result.converged, true);
  assert.deepEqual(result.pending, []);
  assert.deepEqual(installCommandCalls, ['ms-python.python']);
});

test('扩展安装失败时不中断同步并记录未完成项', async () => {
  resetExtensionStub();
  extensionWaitTesting.resetSkippedInstallIds();
  markExtensionInstallFailed('missing.one');
  const result = await installAndWaitForExtensions(['missing.one', 'ok.two'], { timeoutMs: 1_000 });
  assert.equal(result.converged, false);
  assert.deepEqual(result.pending, ['missing.one']);
  assert.deepEqual(installCommandCalls, ['missing.one', 'ok.two']);
  installCommandCalls.length = 0;
  const retry = await installAndWaitForExtensions(['missing.one', 'ok.two'], { timeoutMs: 1_000 });
  assert.deepEqual(retry.pending, ['missing.one']);
  assert.deepEqual(installCommandCalls, []);
});

test('云端移除的扩展会在本机卸载', async () => {
  resetExtensionStub();
  extensionWaitTesting.resetSkippedInstallIds();
  const failed = await uninstallRemovedExtensions(
    ['keep.one'],
    ['keep.one', 'drop.two', 'drop.three'],
    { timeoutMs: 1_000 },
  );
  assert.deepEqual(failed, []);
  assert.deepEqual(uninstallCommandCalls, ['drop.two', 'drop.three']);
});

test('卸载不会波及本插件自身和内置扩展', async () => {
  resetExtensionStub();
  extensionWaitTesting.resetSkippedInstallIds();
  // installedIds 只来自扩展清单文件，内置扩展本就不在其中；本插件即使在清单里也必须跳过。
  await uninstallRemovedExtensions(['keep.one'], ['keep.one', 'saltcoreyan.my-setting-sync'], { timeoutMs: 1_000 });
  assert.deepEqual(uninstallCommandCalls, []);
});

test('云端没有扩展信息时不清空本机扩展', () => {
  assert.deepEqual(selectRemovableExtensionIds(['a.one', 'b.two'], []), []);
  assert.deepEqual(selectRemovableExtensionIds(['a.one', 'b.two'], ['a.one']), ['b.two']);
});

test('扩展卸载失败时记录未完成项且本进程不再重试', async () => {
  resetExtensionStub();
  extensionWaitTesting.resetSkippedInstallIds();
  markExtensionUninstallFailed('stuck.one');
  const failed = await uninstallRemovedExtensions(['keep.one'], ['stuck.one', 'drop.two'], { timeoutMs: 1_000 });
  assert.deepEqual(failed, ['stuck.one']);
  assert.deepEqual(uninstallCommandCalls, ['stuck.one', 'drop.two']);

  uninstallCommandCalls.length = 0;
  const retry = await uninstallRemovedExtensions(['keep.one'], ['stuck.one'], { timeoutMs: 1_000 });
  assert.deepEqual(retry, []);
  assert.deepEqual(uninstallCommandCalls, []);
});

test('检测 URL 中嵌入的明文凭据', () => {
  assert.equal(hasEmbeddedCredentials('https://user:ghp_token@github.com/user/repo.git'), true);
  assert.equal(hasEmbeddedCredentials('git@github.com:user/repo.git'), false);
});

test('对外状态由链路状态和本地远端关系共同决定', () => {
  assert.equal(displayPhase({ kind: 'disabled' }, 'in-sync'), '已关闭');
  assert.equal(displayPhase({ kind: 'unconfigured' }, 'no-repository'), '未配置');
  assert.equal(displayPhase({ kind: 'running', stage: 'pull' }, 'in-sync'), '同步中');
  assert.equal(displayPhase({ kind: 'blocked', reason: 'unrelated' }, 'unrelated'), '需要处理');
  assert.equal(displayPhase({ kind: 'failed' }, 'in-sync'), '同步失败');
  assert.equal(displayPhase({ kind: 'idle' }, 'in-sync'), '已同步');
  assert.equal(displayPhase({ kind: 'idle' }, 'diverged'), '已同步');
  assert.equal(displayPhase({ kind: 'idle' }, 'never-synced'), '未同步');
});

test('删除本地仓库后即使留有上次同步时间也显示未同步', () => {
  assert.equal(displayPhase({ kind: 'idle' }, 'no-repository'), '未同步');
  assert.equal(displayIcon({ kind: 'idle' }, 'no-repository'), '$(circle-outline)');
  assert.equal(displayTone({ kind: 'idle' }, 'no-repository'), 'muted');
});

test('关闭同步时状态不按告警呈现', () => {
  assert.equal(displayIcon({ kind: 'disabled' }, 'in-sync'), '$(circle-slash)');
  assert.equal(displayTone({ kind: 'disabled' }, 'in-sync'), 'muted');
});

test('格式化同步相对时间', () => {
  const now = Date.UTC(2026, 7, 9, 12, 0, 0);
  assert.equal(formatRelativeSyncTime('2026-08-09T12:00:00.000Z', now), '刚刚');
  assert.equal(formatRelativeSyncTime('2026-08-09T11:37:00.000Z', now), '23分钟前');
  assert.equal(formatRelativeSyncTime('2026-08-09T09:00:00.000Z', now), '3小时前');
  assert.equal(formatRelativeSyncTime('2026-08-07T12:00:00.000Z', now), '2天前');
  assert.equal(formatRelativeSyncTime('2026-08-09T12:01:00.000Z', now), '刚刚');
  assert.equal(formatRelativeSyncTime('invalid', now), '时间无效');
});

test('三方判定在冲突检测与合并中给出一致结果', () => {
  assert.equal(classifyThreeWay('base', 'base', 'cloud'), 'cloud');
  assert.equal(classifyThreeWay('base', 'local', 'base'), 'local');
  assert.equal(classifyThreeWay('base', 'same', 'same'), 'local');
  assert.equal(classifyThreeWay('base', 'local', 'cloud'), 'conflict');
  assert.equal(classifyThreeWay('base', undefined, 'base'), 'local');
  assert.equal(classifyThreeWay(undefined, 'local', undefined), 'local');
  assert.equal(classifyThreeWay('base', undefined, 'cloud'), 'conflict');
});

test('推送失败留下的本地提交会被重新对齐并保留共同基准', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-divergence-'));
  const remote = path.join(root, 'remote.git');
  const configuration: SyncConfiguration = {
    repositoryUrl: remote,
    branch: 'main',
    gitUserName: '测试用户',
    gitUserEmail: 'test@example.com',
  };
  const manifestPath = (service: ConfigurationRepositoryGitService) => path.join(
    service.repositoryPath, '.profile-git-sync', 'hosts', 'vscode', 'manifest.json'
  );
  try {
    assert.equal((await runProcess('git', ['init', '--bare', remote])).exitCode, 0);
    const first = new ConfigurationRepositoryGitService(path.join(root, 'first'));
    await first.prepare(configuration);
    await mkdir(path.dirname(manifestPath(first)), { recursive: true });
    await writeFile(manifestPath(first), '{"schemaVersion":1,"files":{"a":"base"}}');
    await first.stageHost('vscode');
    await first.commitAndPush(configuration, 'chore(sync): 初始配置');

    const second = new ConfigurationRepositoryGitService(path.join(root, 'second'));
    await second.prepare(configuration);
    await second.pull(configuration);

    await writeFile(manifestPath(first), '{"schemaVersion":1,"files":{"a":"cloud"}}');
    await first.stageHost('vscode');
    await first.commitAndPush(configuration, 'chore(sync): 云端修改');

    await writeFile(manifestPath(second), '{"schemaVersion":1,"files":{"a":"local"}}');
    await second.stageHost('vscode');
    await assert.rejects(second.commitAndPush(configuration, 'chore(sync): 本机修改'), /推送失败/);

    const pull = await second.pull(configuration);
    assert.equal(pull.recoveredFromDivergence, true);
    assert.equal(await readFile(manifestPath(second), 'utf8'), '{"schemaVersion":1,"files":{"a":"cloud"}}');
    assert.ok(pull.mergeBase);

    const baseRoot = path.join(root, 'base');
    assert.equal(await second.exportHostTree(pull.mergeBase, 'vscode', baseRoot), true);
    assert.equal(await readFile(path.join(baseRoot, 'manifest.json'), 'utf8'), '{"schemaVersion":1,"files":{"a":"base"}}');

    // 恢复后必须能继续正常推送，同步不会停留在失败状态。
    await writeFile(manifestPath(second), '{"schemaVersion":1,"files":{"a":"merged"}}');
    await second.stageHost('vscode');
    await second.commitAndPush(configuration, 'chore(sync): 合并结果');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('本地没有历史时拉取判定为首次克隆且没有共同基准', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-clone-'));
  const remote = path.join(root, 'remote.git');
  const configuration: SyncConfiguration = {
    repositoryUrl: remote,
    branch: 'main',
    gitUserName: '测试用户',
    gitUserEmail: 'test@example.com',
  };
  try {
    assert.equal((await runProcess('git', ['init', '--bare', remote])).exitCode, 0);
    const first = new ConfigurationRepositoryGitService(path.join(root, 'first'));
    await first.prepare(configuration);
    const manifestPath = path.join(first.repositoryPath, '.profile-git-sync', 'hosts', 'vscode', 'manifest.json');
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, '{"schemaVersion":1,"files":{"a":"cloud"}}');
    await first.stageHost('vscode');
    await first.commitAndPush(configuration, 'chore(sync): 初始配置');

    // 远端分支还不存在时不能算首次克隆，否则本机第一次推送会被当成采纳云端。
    const empty = new ConfigurationRepositoryGitService(path.join(root, 'empty'));
    await empty.prepare({ ...configuration, branch: 'other' });
    assert.equal((await empty.pull({ ...configuration, branch: 'other' })).state, 'synced');

    const second = new ConfigurationRepositoryGitService(path.join(root, 'second'));
    await second.prepare(configuration);
    const pull = await second.pull(configuration);
    assert.equal(pull.state, 'cloned');
    assert.equal(pull.mergeBase, undefined);
    assert.equal(
      await readFile(path.join(second.repositoryPath, '.profile-git-sync', 'hosts', 'vscode', 'manifest.json'), 'utf8'),
      '{"schemaVersion":1,"files":{"a":"cloud"}}',
    );

    // 克隆完成后再次拉取即视为同源，从这一轮起才允许三方合并。
    assert.equal((await second.pull(configuration)).state, 'synced');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('本地仓库与远端没有共同祖先时拒绝合并且不改写本地历史', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-unrelated-'));
  const remote = path.join(root, 'remote.git');
  const other = path.join(root, 'other.git');
  const configuration: SyncConfiguration = {
    repositoryUrl: remote,
    branch: 'main',
    gitUserName: '测试用户',
    gitUserEmail: 'test@example.com',
  };
  try {
    assert.equal((await runProcess('git', ['init', '--bare', remote])).exitCode, 0);
    assert.equal((await runProcess('git', ['init', '--bare', other])).exitCode, 0);
    const manifestPath = (service: ConfigurationRepositoryGitService) => path.join(
      service.repositoryPath, '.profile-git-sync', 'hosts', 'vscode', 'manifest.json'
    );

    const cloud = new ConfigurationRepositoryGitService(path.join(root, 'cloud'));
    await cloud.prepare(configuration);
    await mkdir(path.dirname(manifestPath(cloud)), { recursive: true });
    await writeFile(manifestPath(cloud), '{"schemaVersion":1,"files":{"a":"cloud"}}');
    await cloud.stageHost('vscode');
    await cloud.commitAndPush(configuration, 'chore(sync): 云端配置');

    // 本机曾经同步到另一个仓库，改仓库地址后两边历史互不相关。
    const local = new ConfigurationRepositoryGitService(path.join(root, 'local'));
    await local.prepare({ ...configuration, repositoryUrl: other });
    await mkdir(path.dirname(manifestPath(local)), { recursive: true });
    await writeFile(manifestPath(local), '{"schemaVersion":1,"files":{"a":"local"}}');
    await local.stageHost('vscode');
    await local.commitAndPush({ ...configuration, repositoryUrl: other }, 'chore(sync): 本机配置');
    const head = await local.head();

    await local.prepare(configuration);
    const pull = await local.pull(configuration);
    assert.equal(pull.state, 'unrelated');
    assert.equal(pull.mergeBase, undefined);
    assert.equal(await local.head(), head);
    assert.equal(await readFile(manifestPath(local), 'utf8'), '{"schemaVersion":1,"files":{"a":"local"}}');

    // 重建后按首次接入处理，本机内容不会再被推到云端。
    await local.removeRepository();
    await local.prepare(configuration);
    assert.equal((await local.pull(configuration)).state, 'cloned');
    assert.equal(await readFile(manifestPath(local), 'utf8'), '{"schemaVersion":1,"files":{"a":"cloud"}}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('快照剥离插件自身设置并在写回本机时保留原值', () => {
  const text = '{\n  // 编辑器\n  "editor.fontSize": 14,\n  "profileGitSync.enabled": false\n}';
  const stripped = testing.stripPluginSettings(text);
  assert.match(stripped, /\/\/ 编辑器/);
  assert.doesNotMatch(stripped, /profileGitSync/);
  const restored = testing.restorePluginSettings(stripped, '{"profileGitSync.enabled": true}');
  assert.match(restored, /"profileGitSync.enabled":\s*true/);
  assert.match(restored, /"editor.fontSize":\s*14/);
  assert.equal(testing.stripPluginSettings('not-json'), 'not-json');
  assert.equal(testing.restorePluginSettings('{}', 'not-json'), '{}');
});

test('本机专属的插件设置变化不会改变同步指纹', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-fingerprint-'));
  const userDataPath = path.join(root, 'User');
  const runtimePath = path.join(userDataPath, 'globalStorage', 'local.profile-git-sync');
  try {
    await mkdir(runtimePath, { recursive: true });
    const settingsPath = path.join(userDataPath, 'settings.json');
    await writeFile(settingsPath, '{"editor.fontSize": 14}');
    const adapter = new ProfileAdapter({ kind: 'vscode', userDataPath, runtimePath });
    const before = await adapter.fingerprint();
    await writeFile(settingsPath, '{"editor.fontSize": 14, "profileGitSync.pollIntervalSeconds": 900}');
    assert.equal(await adapter.fingerprint(), before);
    await writeFile(settingsPath, '{"editor.fontSize": 16}');
    assert.notEqual(await adapter.fingerprint(), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('写回配置不会在 Profile 目录留下临时文件，残留文件也不进入快照', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-staging-'));
  const userDataPath = path.join(root, 'User');
  const runtimePath = path.join(userDataPath, 'globalStorage', 'local.profile-git-sync');
  const snippetsPath = path.join(userDataPath, 'snippets');
  try {
    await mkdir(runtimePath, { recursive: true });
    await mkdir(snippetsPath, { recursive: true });
    await writeFile(path.join(userDataPath, 'settings.json'), '{"editor.fontSize": 14}');
    await writeFile(path.join(snippetsPath, 'zh.code-snippets'), '{}');
    await writeFile(path.join(snippetsPath, 'zh.code-snippets.profile-git-sync-1234'), '残留内容');
    const adapter = new ProfileAdapter({ kind: 'vscode', userDataPath, runtimePath });
    const snapshot = path.join(root, 'snapshot');
    const manifest = await adapter.createSnapshot(snapshot);
    assert.deepEqual(Object.keys(manifest.files).filter((file) => file.includes('.profile-git-sync-')), []);

    await writeFile(path.join(userDataPath, 'settings.json'), '{"editor.fontSize": 99}');
    await adapter.restoreSnapshot(snapshot, false);
    assert.equal(await readFile(path.join(userDataPath, 'settings.json'), 'utf8'), '{"editor.fontSize": 14}');
    assert.deepEqual((await readdir(userDataPath)).filter((name) => name.includes('.profile-git-sync-')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('配置备份只保留最近若干份', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-backups-'));
  try {
    for (let index = 0; index < 13; index += 1) {
      const backup = path.join(root, `backup-${index}`);
      await mkdir(backup);
      const time = new Date(Date.UTC(2026, 0, 1) + index * 60_000);
      await utimes(backup, time, time);
    }
    await testing.pruneBackups(root);
    const remaining = (await readdir(root)).sort((left, right) => left.localeCompare(right));
    assert.equal(remaining.length, 10);
    assert.equal(remaining.includes('backup-0'), false);
    assert.equal(remaining.includes('backup-12'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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

test('运行状态解析拒绝结构不符的记录', () => {
  const valid = { schemaVersion: 1, enabled: true, link: 'in-sync', cloudAdoptPending: false };
  assert.deepEqual(parseRuntimeState(valid), valid);
  assert.deepEqual(parseRuntimeState({ ...valid, lastSyncAt: '2026-08-09T04:44:35.000Z' }), {
    ...valid,
    lastSyncAt: '2026-08-09T04:44:35.000Z',
  });
  assert.equal(parseRuntimeState({ ...valid, schemaVersion: 2 }), undefined);
  assert.equal(parseRuntimeState({ ...valid, link: '已同步' }), undefined);
  assert.equal(parseRuntimeState({ ...valid, enabled: 'true' }), undefined);
  assert.equal(parseRuntimeState({ ...valid, lastSyncAt: 12 }), undefined);
  assert.equal(parseRuntimeState(undefined), undefined);
});

test('运行状态在多个窗口之间共享且互不覆盖其他字段', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-runtime-state-'));
  try {
    const first = new RuntimeStateStore(root);
    const second = new RuntimeStateStore(root);
    await first.initialize();
    await second.initialize();

    await first.update({ link: 'in-sync', lastSyncAt: '2026-08-09T04:44:35.000Z' });
    // 第二个窗口在自己的缓存上只改另一个字段，不应把第一个窗口写入的值退回默认。
    await second.update({ cloudAdoptPending: true });

    const third = new RuntimeStateStore(root);
    await third.initialize();
    assert.equal(third.get().link, 'in-sync');
    assert.equal(third.get().lastSyncAt, '2026-08-09T04:44:35.000Z');
    assert.equal(third.get().cloudAdoptPending, true);

    assert.equal(await first.reload(), true);
    assert.equal(first.get().cloudAdoptPending, true);
    assert.equal(await first.reload(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('删除本地仓库后清空上次同步时间', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-runtime-clear-'));
  try {
    const store = new RuntimeStateStore(root);
    await store.initialize();
    await store.update({ link: 'in-sync', lastSyncAt: '2026-08-09T04:44:35.000Z' });
    await store.update({ link: 'no-repository', lastSyncAt: undefined });

    const reopened = new RuntimeStateStore(root);
    await reopened.initialize();
    assert.equal(reopened.get().link, 'no-repository');
    assert.equal(reopened.get().lastSyncAt, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('拉取到不同源的远端时暂停同步而不是直接失败', async () => {
  const context = stageContext({
    dependencies: stageDependencies({
      git: fakeGit({ pull: async () => ({ state: 'unrelated', recoveredFromDivergence: false }) }),
    }),
  });
  assert.deepEqual(await stageTesting.pullStage.run(context), { kind: 'blocked', reason: 'unrelated', link: 'unrelated' });
});

test('整包采用云端时不产生新的远端提交', async () => {
  let staged = false;
  const context = stageContext({
    artifacts: { strategy: 'adopt' },
    dependencies: stageDependencies({
      git: fakeGit({ stageHost: async () => { staged = true; return []; } }),
    }),
  });
  assert.deepEqual(await stageTesting.pushStage.run(context), { kind: 'continue' });
  assert.equal(staged, false);
});

test('提交前发现未保存的配置文档时暂停且不推送', async () => {
  let pushed = false;
  const context = stageContext({
    artifacts: { strategy: 'merge' },
    dependencies: stageDependencies({
      git: fakeGit({ stageHost: async () => [], pushIfAhead: async () => { pushed = true; } }),
      windowSafety: async () => ({ activeWindows: 2, dirtyWindows: 1, unreadableWindows: 0 }),
    }),
  });
  const outcome = await stageTesting.pushStage.run(context);
  assert.equal(outcome.kind, 'blocked');
  assert.equal(outcome.kind === 'blocked' ? outcome.reason : undefined, 'dirty-windows');
  assert.equal(pushed, false);
});

test('强制采用云端但云端没有本宿主快照时中止并清除重建标记', async () => {
  const updates: Array<Record<string, unknown>> = [];
  const context = stageContext({
    adoptCloud: true,
    artifacts: { pull: { state: 'synced', recoveredFromDivergence: false } },
    dependencies: stageDependencies({
      runtimeState: { update: async (patch: Record<string, unknown>) => { updates.push(patch); } } as unknown as RuntimeStateStore,
    }),
  });
  await assert.rejects(() => stageTesting.decideStage.run(context), /云端没有 VS Code 的配置快照/);
  assert.deepEqual(updates, [{ cloudAdoptPending: false }]);
});

test('远端还没有本宿主快照时直接用本机内容初始化', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-seed-'));
  try {
    const localHostRoot = path.join(root, 'tmp', 'vscode');
    const repositoryHostRoot = path.join(root, 'repository', 'vscode');
    await mkdir(localHostRoot, { recursive: true });
    await writeFile(path.join(localHostRoot, 'manifest.json'), JSON.stringify({
      schemaVersion: 1, host: 'vscode', createdAt: '', profiles: [], files: {},
    }));

    const context = stageContext({
      artifacts: { strategy: 'seed-local', remoteExists: false },
      paths: {
        temporaryRoot: path.join(root, 'tmp'),
        localHostRoot,
        baseHostRoot: path.join(root, 'tmp', 'base'),
        repositoryHostRoot,
      },
    });

    // 远端缺少 manifest.json，走合并会直接读文件失败，这里必须跳过合并。
    assert.deepEqual(await mergeStage.run(context), { kind: 'continue' });
    assert.equal(context.report.merge, undefined);
    assert.deepEqual(await readJsonFile(path.join(repositoryHostRoot, 'manifest.json')), {
      schemaVersion: 1, host: 'vscode', createdAt: '', profiles: [], files: {},
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('扩展同步只认宿主级清单，忽略 Profile 目录下的启用状态', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-ext-stage-'));
  resetExtensionStub();
  extensionWaitTesting.resetSkippedInstallIds();
  try {
    const repositoryHostRoot = path.join(root, 'repository', 'cursor');
    await mkdir(path.join(repositoryHostRoot, 'profiles', 'default'), { recursive: true });
    // 仅 Profile 级清单存在时不应触发任何安装或卸载。
    await writeFile(path.join(repositoryHostRoot, 'profiles', 'default', 'extensions.json'),
      JSON.stringify([{ identifier: { id: 'stale.one' } }]));
    await writeFile(path.join(repositoryHostRoot, 'manifest.json'), JSON.stringify({
      schemaVersion: 1, host: 'cursor', createdAt: '', profiles: [],
      files: { 'profiles/default/extensions.json': 'x' },
    }));

    const context = stageContext({
      paths: {
        temporaryRoot: path.join(root, 'tmp'),
        localHostRoot: path.join(root, 'tmp', 'cursor'),
        baseHostRoot: path.join(root, 'tmp', 'base'),
        repositoryHostRoot,
      },
      dependencies: stageDependencies({
        adapter: { listInstalledExtensionIds: async () => ['local.only'] } as unknown as ProfileAdapter,
      }),
    });

    assert.deepEqual(await stageTesting.extensionsStage.run(context), { kind: 'continue' });
    assert.deepEqual(installCommandCalls, []);
    assert.deepEqual(uninstallCommandCalls, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('管道在阻塞时不再执行后续步骤', async () => {
  const executed: string[] = [];
  const stages: Stage[] = [
    { name: 'snapshot', async run() { executed.push('snapshot'); return { kind: 'continue' }; } },
    { name: 'pull', async run() { executed.push('pull'); return { kind: 'blocked', reason: 'unrelated', link: 'unrelated' }; } },
    { name: 'push', async run() { executed.push('push'); return { kind: 'continue' }; } },
  ];
  const patches: Array<Partial<RuntimeStatus>> = [];
  const context = stageContext({ dependencies: stageDependencies({ updateStatus: (patch) => { patches.push(patch); } }) });

  assert.deepEqual(await runPipeline(context, stages), { ok: false, unrelated: true, blockReason: 'unrelated' });
  assert.deepEqual(executed, ['snapshot', 'pull']);
  // 每进入一个步骤都会上报进度，无需 stage 自己写状态。
  assert.deepEqual(patches.slice(0, 2).map((patch) => patch.sync), [
    { kind: 'running', stage: 'snapshot' },
    { kind: 'running', stage: 'pull' },
  ]);
});

test('结构变化未应用时同步仍算完成但报告需要关闭其他窗口', async () => {
  const context = stageContext({ report: { ...createSyncReport(), waitingForWindows: true, activeWindows: 2 } });
  const outcome = await runPipeline(context, []);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.waitingForWindows, true);
});

test('同步顺利结束时报告完成并给出状态说明', async () => {
  const patches: Array<Partial<RuntimeStatus>> = [];
  const context = stageContext({
    dependencies: stageDependencies({ updateStatus: (patch) => { patches.push(patch); } }),
  });

  const outcome = await runPipeline(context, []);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.waitingForWindows, false);
  // 流程只写说明文案，链路状态交给调度层判定。
  assert.equal(patches.at(-1)?.sync, undefined);
  assert.equal(patches.at(-1)?.link, undefined);
  assert.equal(patches.at(-1)?.message, '配置已是最新。');
});

test('关闭同步开关后不再发起任何同步', () => {
  const machine = { ...leaderMachine(), enabled: false, sync: { kind: 'disabled' } as SyncState };
  for (const event of [
    { type: 'sync-requested', source: 'user' },
    { type: 'sync-requested', source: 'timer' },
    { type: 'sync-requested', source: 'startup' },
  ] as SchedulerEvent[]) {
    const { next, commands } = reduce(machine, event);
    assert.deepEqual(commands, []);
    assert.deepEqual(next.sync, { kind: 'disabled' });
  }
});

test('同步进行中关闭开关不打断当前这一轮', () => {
  const running: SchedulerMachine = { ...leaderMachine(), sync: { kind: 'running', stage: 'push' } };
  const closed = reduce(running, { type: 'enabled-changed', enabled: false });
  // 仍在 running：已经提交但未推送的中间态不能被切断。
  assert.deepEqual(closed.next.sync, { kind: 'running', stage: 'push' });
  assert.deepEqual(closed.commands.map((command) => command.type), ['stop-schedules', 'cancel-retry']);

  const finished = reduce(closed.next, { type: 'sync-finished', outcome: { ok: true, structuralApplied: false } });
  assert.deepEqual(finished.next.sync, { kind: 'disabled' });
});

test('开启开关后立即同步一次并启动定时器', () => {
  const disabled: SchedulerMachine = { ...leaderMachine(), enabled: false, sync: { kind: 'disabled' } };
  const { next, commands } = reduce(disabled, { type: 'enabled-changed', enabled: true });
  assert.deepEqual(next.sync, { kind: 'idle' });
  assert.deepEqual(commands, [{ type: 'start-schedules' }, { type: 'start-sync', adoptCloud: false }]);
});

test('同步期间的请求排队，结束后再跑一轮', () => {
  const running: SchedulerMachine = { ...leaderMachine(), sync: { kind: 'running', stage: 'merge' } };
  const queued = reduce(running, { type: 'sync-requested', source: 'timer' });
  assert.equal(queued.next.pending, true);
  assert.deepEqual(queued.commands, []);

  const finished = reduce(queued.next, { type: 'sync-finished', outcome: { ok: true, structuralApplied: false } });
  assert.deepEqual(finished.next.sync, { kind: 'running', stage: 'snapshot' });
  assert.deepEqual(finished.commands, [{ type: 'start-sync', adoptCloud: false }]);
});

test('阻塞是否可自动恢复取决于原因', () => {
  const safe = { activeWindows: 1, dirtyWindows: 0, unreadableWindows: 0 };
  const resolvable: Array<[SchedulerMachine['sync'], boolean]> = [
    [{ kind: 'blocked', reason: 'dirty-windows' }, true],
    [{ kind: 'blocked', reason: 'unreadable-windows' }, true],
    [{ kind: 'blocked', reason: 'other-windows' }, true],
    [{ kind: 'blocked', reason: 'unrelated' }, false],
    [{ kind: 'blocked', reason: 'exclusive-lock' }, false],
  ];
  for (const [sync, shouldResume] of resolvable) {
    const { commands } = reduce({ ...leaderMachine(), sync }, { type: 'windows-changed', safety: safe });
    assert.deepEqual(commands, shouldResume ? [{ type: 'start-sync', adoptCloud: false }] : []);
  }
});

test('未保存文档仍在时阻塞不解除', () => {
  const blocked: SchedulerMachine = { ...leaderMachine(), sync: { kind: 'blocked', reason: 'dirty-windows' } };
  const { commands } = reduce(blocked, {
    type: 'windows-changed',
    safety: { activeWindows: 2, dirtyWindows: 1, unreadableWindows: 0 },
  });
  assert.deepEqual(commands, []);
});

test('不同源只询问一次，用户拒绝后不再弹窗', () => {
  const first = reduce(leaderMachine(), { type: 'sync-finished', outcome: { ok: false, unrelated: true } });
  assert.deepEqual(first.next.sync, { kind: 'blocked', reason: 'unrelated' });
  assert.equal(first.next.link, 'unrelated');
  assert.deepEqual(first.commands, [{ type: 'prompt-cloud-adopt' }]);

  const declined = reduce(first.next, { type: 'cloud-adopt-declined' });
  assert.deepEqual(reduce(declined.next, { type: 'sync-requested', source: 'timer' }).commands, []);

  // 换了仓库地址后重新允许询问。
  const reconfigured = reduce(declined.next, { type: 'configuration-changed', configured: true, repositoryChanged: true });
  assert.deepEqual(reconfigured.next.sync, { kind: 'idle' });
  assert.equal(reconfigured.next.cloudAdoptPrompted, false);
});

test('用户确认重建时绕过不同源阻塞直接同步', () => {
  const blocked: SchedulerMachine = {
    ...leaderMachine(),
    sync: { kind: 'blocked', reason: 'unrelated' },
    link: 'unrelated',
    cloudAdoptPrompted: true,
  };
  const { next, commands } = reduce(blocked, { type: 'sync-requested', source: 'user', adoptCloud: true });
  assert.deepEqual(next.sync, { kind: 'running', stage: 'snapshot' });
  assert.deepEqual(commands, [{ type: 'start-sync', adoptCloud: true }]);
});

test('抢不到独占锁时按指数退避重试', () => {
  let machine = leaderMachine();
  const delays: number[] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { next, commands } = reduce(machine, { type: 'sync-lock-busy' });
    machine = next;
    const retry = commands.find((command) => command.type === 'schedule-retry');
    if (retry?.type === 'schedule-retry') delays.push(retry.delayMs);
  }
  assert.deepEqual(delays, [5_000, 10_000, 20_000, 40_000, 60_000]);
  assert.deepEqual(machine.sync, { kind: 'blocked', reason: 'exclusive-lock' });

  // 成功一轮后退避重新归零。
  const recovered = reduce(machine, { type: 'sync-finished', outcome: { ok: true, structuralApplied: false } });
  assert.equal(recovered.next.retryAttempt, 0);
  assert.deepEqual(recovered.next.sync, { kind: 'idle' });
});

test('follower 收到请求时转交给 leader 而不是自己执行', () => {
  const follower: SchedulerMachine = { ...leaderMachine(), isLeader: false };
  const { next, commands } = reduce(follower, { type: 'sync-requested', source: 'user' });
  assert.deepEqual(commands, [{ type: 'forward-sync-request' }]);
  assert.deepEqual(next.sync, { kind: 'idle' });
});

test('删除本地仓库后链路状态回到没有仓库', () => {
  const synced: SchedulerMachine = { ...leaderMachine(), link: 'in-sync' };
  const { next } = reduce(synced, { type: 'repository-removed' });
  assert.equal(next.link, 'no-repository');
  assert.deepEqual(next.sync, { kind: 'idle' });
  assert.equal(displayPhase(next.sync, next.link), '未同步');
});

test('结构变化已应用时请求重载窗口', () => {
  const running: SchedulerMachine = { ...leaderMachine(), sync: { kind: 'running', stage: 'apply' } };
  const { next, commands } = reduce(running, {
    type: 'sync-finished',
    outcome: { ok: true, structuralApplied: true, waitingForWindows: false },
  });
  assert.deepEqual(next.sync, { kind: 'idle' });
  assert.deepEqual(commands.map((command) => command.type), ['reload-window', 'complete-sync-requests']);
});

function leaderMachine(): SchedulerMachine {
  return { ...createMachine({ enabled: true, configured: true, link: 'never-synced' }), isLeader: true };
}

function stageDependencies(overrides: Partial<SyncDependencies> = {}): SyncDependencies {
  return {
    environment: { kind: 'vscode', userDataPath: '/user-data', runtimePath: '/runtime' },
    adapter: {} as unknown as ProfileAdapter,
    git: fakeGit({}),
    ai: {} as unknown as AiService,
    runtimeState: { update: async () => undefined } as unknown as RuntimeStateStore,
    windowSafety: async () => ({ activeWindows: 1, dirtyWindows: 0, unreadableWindows: 0 }),
    updateStatus: () => undefined,
    conflictBackupRoot: '/runtime/conflict-backups',
    ...overrides,
  };
}

function stageContext(overrides: Partial<SyncContext> = {}): SyncContext {
  return {
    dependencies: stageDependencies(),
    configuration: { ...DEFAULT_CONFIGURATION, repositoryUrl: 'git@example.com:user/settings.git' },
    adoptCloud: false,
    paths: {
      temporaryRoot: path.join(tmpdir(), 'profile-git-sync-absent', 'tmp'),
      localHostRoot: path.join(tmpdir(), 'profile-git-sync-absent', 'tmp', 'vscode'),
      baseHostRoot: path.join(tmpdir(), 'profile-git-sync-absent', 'tmp', 'base'),
      repositoryHostRoot: path.join(tmpdir(), 'profile-git-sync-absent', 'repository'),
    },
    report: createSyncReport(),
    artifacts: {},
    ...overrides,
  };
}

function fakeGit(overrides: Partial<ConfigurationRepositoryGitService>): ConfigurationRepositoryGitService {
  return { repositoryPath: '/runtime/repository', ...overrides } as unknown as ConfigurationRepositoryGitService;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('等待条件超时。');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function fakeExtensionContext(globalValues: Map<string, unknown>): vscode.ExtensionContext {
  const secrets = new Map<string, string>();
  return {
    globalState: {
      get: <T>(key: string, defaultValue?: T): T | undefined => (
        globalValues.has(key) ? globalValues.get(key) as T : defaultValue
      ),
      update: async (key: string, value: unknown): Promise<void> => {
        if (value === undefined) globalValues.delete(key);
        else globalValues.set(key, value);
      },
      keys: () => [...globalValues.keys()],
      setKeysForSync: () => undefined,
    },
    secrets: {
      get: async (key: string): Promise<string | undefined> => secrets.get(key),
      store: async (key: string, value: string): Promise<void> => { secrets.set(key, value); },
      delete: async (key: string): Promise<void> => { secrets.delete(key); },
    },
  } as unknown as vscode.ExtensionContext;
}
