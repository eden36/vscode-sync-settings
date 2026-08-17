import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type * as vscode from 'vscode';
import { MultiWindowCoordinator } from '../src/coordinator';
import { ConfigurationStore } from '../src/configuration';
import { parseUtilityModelSetting } from '../src/ai-model';
import type { AiService } from '../src/ai';
import { fallbackCommitMessage } from '../src/sync-fallback';
import { ConfigurationRepositoryGitService } from '../src/git-service';
import { resolveHostStoragePaths } from '../src/host-paths';
import { ProfileAdapter, testing } from '../src/profile-adapter';
import { runProcess } from '../src/process';
import { containsPotentialSecret } from '../src/secret-scanner';
import { atomicWriteJson, readJsonFile } from '../src/json-store';
import { classifyThreeWay, resolveConflictFallback } from '../src/snapshot-conflict';
import {
  compareConfigurationRecords,
  createConfigurationRecord,
  hasEmbeddedCredentials,
  parseConfigurationRecord,
  parsePluginConfiguration,
  relateConfigurationRecords,
  resolveRepositoryUrl,
} from '../src/configuration-record';
import { parseExtensionIds } from '../src/extension-manifest';
import { displaySyncPhase, formatRelativeSyncTime, isBusyPhase } from '../src/sidebar-status';
import { SyncEngine, finalSyncMessage } from '../src/sync-engine';
import { DEFAULT_CONFIGURATION, PluginConfiguration, SyncConfiguration } from '../src/types';
import { resetApplicationSettings } from './vscode-stub';

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
      phase: '空闲',
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
      mode: 'sync',
      changed: true,
      usedAiFallback: false,
      recoveredPendingChanges: false,
      recoveredFromDivergence: false,
      merge: { conflicts: ['a', 'b'], aiMerged: ['a'], autoMerged: ['b'] },
    }),
    '同步完成（AI 已自动合并 1 项冲突；1 项冲突按本机优先自动处理；冲突前的两份配置已备份到扩展运行目录）。',
  );
  assert.equal(
    finalSyncMessage({
      mode: 'sync',
      changed: false,
      usedAiFallback: false,
      recoveredPendingChanges: false,
      recoveredFromDivergence: false,
    }),
    '配置已是最新。',
  );
  assert.equal(
    finalSyncMessage({
      mode: 'sync',
      structuralMessage: '远程包含 Profile 增删，只剩一个窗口时会自动应用。',
      changed: true,
      usedAiFallback: false,
      recoveredPendingChanges: false,
      recoveredFromDivergence: false,
    }),
    '远程包含 Profile 增删，只剩一个窗口时会自动应用。',
  );
});

test('备份模式状态文案使用备份完成前缀', () => {
  assert.equal(
    finalSyncMessage({
      mode: 'backup',
      changed: true,
      usedAiFallback: true,
      recoveredPendingChanges: false,
      recoveredFromDivergence: false,
    }),
    '备份完成（AI 不可用或结果无效，已使用兜底策略）。',
  );
});

test('状态栏只在同步执行阶段显示忙碌', () => {
  assert.equal(isBusyPhase('正在拉取'), true);
  assert.equal(isBusyPhase('等待 AI'), true);
  assert.equal(isBusyPhase('空闲'), false);
  assert.equal(isBusyPhase('等待其他窗口关闭'), false);
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

test('同步配置解析缺省回落到备份模式并拒绝非法模式', () => {
  const parsed = parsePluginConfiguration({
    repositoryUrl: 'git@github.com:user/settings.git',
    branch: 'main',
    gitUserName: '',
    gitUserEmail: '',
    autoSync: true,
    debounceSeconds: 10,
    pollIntervalSeconds: 300,
    includeProfileAssociations: false,
  });
  assert.equal(parsed?.mode, 'backup');
  assert.equal(parsePluginConfiguration({
    repositoryUrl: 'git@github.com:user/settings.git',
    branch: 'main',
    gitUserName: '',
    gitUserEmail: '',
    mode: 'sync',
    autoSync: true,
    debounceSeconds: 10,
    pollIntervalSeconds: 300,
    includeProfileAssociations: false,
  })?.mode, 'sync');
  assert.equal(parsePluginConfiguration({
    repositoryUrl: 'git@github.com:user/settings.git',
    branch: 'main',
    gitUserName: '',
    gitUserEmail: '',
    mode: 'invalid',
    autoSync: true,
    debounceSeconds: 10,
    pollIntervalSeconds: 300,
    includeProfileAssociations: false,
  }), undefined);
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
      mode: 'sync' as const,
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

test('备份模式同步只写仓库不写回本机', async () => {
  const configuration = {
    ...DEFAULT_CONFIGURATION,
    repositoryUrl: 'git@github.com:user/settings.git',
    mode: 'backup' as const,
  };
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-backup-mode-'));
  let restoreCalled = false;
  let exportedBase = false;
  let committed = false;
  let pushedAhead = false;
  try {
    const repositoryPath = path.join(root, 'repository');
    await mkdir(path.join(repositoryPath, '.profile-git-sync', 'hosts'), { recursive: true });
    const engine = new SyncEngine(
      { kind: 'vscode', userDataPath: path.join(root, 'User'), runtimePath: path.join(root, 'Runtime') },
      {
        createSnapshot: async (hostRoot: string) => {
          await mkdir(hostRoot, { recursive: true });
          await writeFile(path.join(hostRoot, 'manifest.json'), '{"schemaVersion":1,"host":"vscode","createdAt":"","profiles":[],"files":{}}');
          return {
            schemaVersion: 1,
            host: 'vscode',
            createdAt: '',
            profiles: [],
            files: {},
          };
        },
        restoreSnapshot: async () => {
          restoreCalled = true;
          return { changedFiles: [], structuralChange: false, structuralApplied: false };
        },
      } as unknown as ProfileAdapter,
      {
        repositoryPath,
        prepare: async () => undefined,
        discardPendingHostChanges: async () => false,
        pull: async () => ({ recoveredFromDivergence: false }),
        exportHostTree: async () => {
          exportedBase = true;
          return true;
        },
        stageHost: async () => ['.profile-git-sync/hosts/vscode/manifest.json'],
        commitAndPush: async () => { committed = true; },
        pushIfAhead: async () => { pushedAhead = true; },
      } as unknown as ConfigurationRepositoryGitService,
      {
        createCommitMessage: async () => 'chore(sync): 备份',
        resolveConflict: async () => '',
      } as unknown as AiService,
      {
        get: () => configuration,
      } as unknown as ConfigurationStore,
      () => undefined,
      async () => ({ activeWindows: 1, dirtyWindows: 0, unreadableWindows: 0 }),
    );
    const result = await engine.synchronize();
    assert.equal(result?.ok, true);
    assert.equal(restoreCalled, false);
    assert.equal(exportedBase, false);
    assert.equal(committed, true);
    assert.equal(pushedAhead, false);
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

test('检测 URL 中嵌入的明文凭据', () => {
  assert.equal(hasEmbeddedCredentials('https://user:ghp_token@github.com/user/repo.git'), true);
  assert.equal(hasEmbeddedCredentials('git@github.com:user/repo.git'), false);
});

test('侧边栏仅在已有成功同步记录时显示已同步', () => {
  assert.equal(displaySyncPhase('空闲', undefined), '未同步');
  assert.equal(displaySyncPhase('空闲', '2026-08-09T04:44:35.000Z'), '已同步');
  assert.equal(displaySyncPhase('正在拉取', undefined), '正在拉取');
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

test('快照剥离插件自身设置并在写回本机时保留原值', () => {
  const text = '{\n  // 编辑器\n  "editor.fontSize": 14,\n  "profileGitSync.autoSync": false\n}';
  const stripped = testing.stripPluginSettings(text);
  assert.match(stripped, /\/\/ 编辑器/);
  assert.doesNotMatch(stripped, /profileGitSync/);
  const restored = testing.restorePluginSettings(stripped, '{"profileGitSync.autoSync": true}');
  assert.match(restored, /"profileGitSync.autoSync":\s*true/);
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
