import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { ConfigurationStore } from '../src/configuration';
import { ProfileAdapter } from '../src/profile-adapter';
import { DEFAULT_RUNTIME_STATE, RuntimeStateStore } from '../src/runtime-state';
import { readJsonFile } from '../src/json-store';
import { snapshotDigest } from '../src/snapshot-conflict';
import { AiService } from '../src/ai';
import { chooseStage } from '../src/pipeline/choose';
import { testing as restoreTesting } from '../src/pipeline/restore';
import { runPipeline } from '../src/pipeline/pipeline';
import { BACKUP_STAGES, SYNC_STAGES, testing as stageTesting } from '../src/pipeline/stages';
import { Stage } from '../src/pipeline/types';
import { SyncEngine } from '../src/sync-engine';
import { decideSnapshotChoice } from '../src/sync-strategy';
import { createSyncReport, DEFAULT_CONFIGURATION, RuntimeStatus, SyncConfiguration } from '../src/types';
import { testing as extensionWaitTesting } from '../src/extension-wait';
import { resetExtensionStub, installCommandCalls, uninstallCommandCalls, markExtensionInstalled, installedExtensionIds } from './vscode-stub';
import {
  restoreContext,
  writeHistorySnapshot,
  testManifest,
  chooseContext,
  profileManifest,
  stageDependencies,
  stageContext,
  fakeGit,
  writeExtensionSnapshot,
} from './helpers';

test('备份模式的流程止于推送，不含写回本机的步骤', () => {
  const names = BACKUP_STAGES.map((stage) => stage.name);
  assert.deepEqual(names, ['snapshot', 'scan-secrets', 'prepare', 'pull', 'decide', 'choose', 'push', 'finalize']);
  // 备份模式只少了写回本机与装卸扩展两步，其余步骤和顺序必须与同步模式一致。
  const sync = SYNC_STAGES.map((stage) => stage.name).filter((name) => name !== 'apply' && name !== 'extensions');
  assert.deepEqual(sync, names);
});

test('备份模式同步前会清除遗留的采用云端标记', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-backup-pending-'));
  try {
    const runtimeState = new RuntimeStateStore(root);
    await runtimeState.initialize();
    await runtimeState.update({ cloudAdoptPending: true });
    const engine = new SyncEngine(
      { kind: 'vscode', userDataPath: root, runtimePath: root },
      { createSnapshot: async () => { throw new Error('快照未执行'); } } as unknown as ProfileAdapter,
      fakeGit({ prepare: async () => undefined, pull: async () => ({ state: 'synced', recoveredFromDivergence: false }) }),
      {} as unknown as AiService,
      { get: () => ({ ...DEFAULT_CONFIGURATION, repositoryUrl: 'git@example.com:user/settings.git', mode: 'backup' }) } as unknown as ConfigurationStore,
      runtimeState,
      () => undefined,
      async () => ({ activeWindows: 1, dirtyWindows: 0, unreadableWindows: 0 }),
    );
    const outcome = await engine.synchronize();
    assert.equal(runtimeState.get().cloudAdoptPending, false);
    assert.equal(outcome?.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('尚未开始的同步也会响应停止请求，且停止意图只兑现一次', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-stop-'));
  try {
    const engine = new SyncEngine(
      { kind: 'vscode', userDataPath: root, runtimePath: root },
      { createSnapshot: async () => { throw new Error('快照未执行'); } } as unknown as ProfileAdapter,
      fakeGit({}),
      {} as unknown as AiService,
      { get: () => ({ ...DEFAULT_CONFIGURATION, repositoryUrl: 'git@example.com:user/settings.git' }) } as unknown as ConfigurationStore,
      { reload: async () => undefined, get: () => ({ cloudAdoptPending: false }) } as unknown as RuntimeStateStore,
      () => undefined,
      async () => ({ activeWindows: 1, dirtyWindows: 0, unreadableWindows: 0 }),
    );
    engine.requestStop();
    assert.deepEqual(await engine.synchronize(), { ok: false, cancelled: true });
    // 意图已经兑现，不能粘住让之后每一轮都被直接取消。
    assert.deepEqual(await engine.synchronize(), { ok: false });
    engine.requestStop();
    engine.clearStop();
    assert.deepEqual(await engine.synchronize(), { ok: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('备份模式直接用本机内容覆盖仓库快照', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-backup-merge-'));
  try {
    const localHostRoot = path.join(root, 'tmp', 'vscode');
    const repositoryHostRoot = path.join(root, 'repository', 'vscode');
    const localManifest = { schemaVersion: 1, host: 'vscode', createdAt: '', profiles: [], files: {} };
    await mkdir(localHostRoot, { recursive: true });
    await writeFile(path.join(localHostRoot, 'manifest.json'), JSON.stringify(localManifest));
    await mkdir(repositoryHostRoot, { recursive: true });
    await writeFile(path.join(repositoryHostRoot, 'manifest.json'), JSON.stringify({
      schemaVersion: 1, host: 'vscode', createdAt: '', profiles: [{ id: 'cloud', name: '云端', isDefault: true }], files: {},
    }));

    const context = stageContext({
      configuration: { ...DEFAULT_CONFIGURATION, repositoryUrl: 'git@example.com:user/settings.git', mode: 'backup' },
      artifacts: { strategy: 'backup', remoteExists: true },
      paths: {
        temporaryRoot: path.join(root, 'tmp'),
        localHostRoot,
        repositoryHostRoot,
      },
    });

    assert.deepEqual(await chooseStage.run(context), { kind: 'continue' });
    // 云端快照存在也不参与比较：备份模式下本机是仓库内容的唯一来源。
    assert.equal(context.report.snapshotChoice, 'local');
    assert.deepEqual(await readJsonFile(path.join(repositoryHostRoot, 'manifest.json')), localManifest);
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
  assert.deepEqual(await stageTesting.pullStage.run(context), { kind: 'blocked', reason: 'unrelated' });
});

test('整包采用云端时不产生新的远端提交', async () => {
  let staged = false;
  let pushed = false;
  const context = stageContext({
    artifacts: { strategy: 'adopt', choice: 'cloud' },
    dependencies: stageDependencies({
      git: fakeGit({
        stageHost: async () => { staged = true; return []; },
        pushIfAhead: async () => { pushed = true; },
      }),
    }),
  });
  assert.deepEqual(await stageTesting.pushStage.run(context), { kind: 'continue' });
  assert.equal(staged, false);
  // 仓库内容没被改写，但上次推送失败留下的提交仍要补推。
  assert.equal(pushed, true);
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
      runtimeState: {
        get: () => ({ ...DEFAULT_RUNTIME_STATE }),
        update: async (patch: Record<string, unknown>) => { updates.push(patch); },
      } as unknown as RuntimeStateStore,
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
        repositoryHostRoot,
      },
    });

    // 远端缺少 manifest.json，读云端快照会直接失败，这里必须跳过比较。
    assert.deepEqual(await chooseStage.run(context), { kind: 'continue' });
    assert.equal(context.report.snapshotChoice, 'local');
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

test('Profile 不一致的阻塞交回调度层询问用户，与可自动恢复的阻塞区分开', async () => {
  const stages: Stage[] = [
    { name: 'choose', async run() { return { kind: 'blocked', reason: 'profiles-mismatch' }; } },
  ];
  assert.deepEqual(await runPipeline(stageContext(), stages), {
    ok: false, profilesMismatch: true, blockReason: 'profiles-mismatch',
  });
});

test('同步顺利结束时报告完成并给出状态说明', async () => {
  const patches: Array<Partial<RuntimeStatus>> = [];
  const context = stageContext({
    dependencies: stageDependencies({ updateStatus: (patch) => { patches.push(patch); } }),
  });

  const outcome = await runPipeline(context, []);
  assert.equal(outcome.ok, true);
  // 流程只写说明文案，链路状态交给调度层判定。
  assert.equal(patches.at(-1)?.sync, undefined);
  assert.equal(patches.at(-1)?.link, undefined);
  assert.equal(patches.at(-1)?.message, '配置已是最新。');
});

test('请求停止后当前阶段结束且不再执行后续阶段', async () => {
  let cancellationRequested = false;
  const executed: string[] = [];
  const context = stageContext({
    dependencies: stageDependencies({ isCancellationRequested: () => cancellationRequested }),
  });
  const stages: Stage[] = [
    { name: 'snapshot', run: async () => { executed.push('snapshot'); cancellationRequested = true; return { kind: 'continue' }; } },
    { name: 'scan-secrets', run: async () => { executed.push('scan-secrets'); return { kind: 'continue' }; } },
  ];

  const outcome = await runPipeline(context, stages);

  assert.deepEqual(executed, ['snapshot']);
  assert.deepEqual(outcome, { ok: false, cancelled: true });
});

test('本机没改时采用云端且不改写仓库内容', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-choose-cloud-'));
  try {
    const localManifest = testManifest({ 'profiles/default/settings.json': 'local' });
    const cloudManifest = testManifest({ 'profiles/default/settings.json': 'cloud' });
    const { context } = await chooseContext(root, localManifest, cloudManifest, {
      localSnapshot: snapshotDigest(localManifest, 'win32').snapshot,
      localExtensions: '',
      cloudSnapshot: 'stale',
      cloudExtensions: '',
    });

    assert.deepEqual(await chooseStage.run(context), { kind: 'continue' });
    assert.equal(context.report.snapshotChoice, 'cloud');
    assert.deepEqual(await readJsonFile(path.join(context.paths.repositoryHostRoot, 'manifest.json')), cloudManifest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('两边都改时暂停并先备份双方，不改写任何一侧', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-choose-conflict-'));
  try {
    const localManifest = testManifest({ 'profiles/default/settings.json': 'local' });
    const cloudManifest = testManifest({ 'profiles/default/settings.json': 'cloud' });
    const { context, conflictBackupRoot } = await chooseContext(root, localManifest, cloudManifest, {
      localSnapshot: 'stale-local',
      localExtensions: '',
      cloudSnapshot: 'stale-cloud',
      cloudExtensions: '',
    });

    const outcome = await chooseStage.run(context);
    assert.equal(outcome.kind, 'blocked');
    assert.equal(outcome.kind === 'blocked' ? outcome.reason : undefined, 'both-changed');
    // 用户可能过很久才选择，暂停期间两份内容都要有副本。
    assert.equal((await readdir(conflictBackupRoot)).length, 1);
    assert.deepEqual(await readJsonFile(path.join(context.paths.repositoryHostRoot, 'manifest.json')), cloudManifest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('用户选定本机后按本机覆盖云端，不再询问', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-choose-resolved-'));
  try {
    const localManifest = testManifest({ 'profiles/default/settings.json': 'local' });
    const cloudManifest = testManifest({ 'profiles/default/settings.json': 'cloud' });
    const { context } = await chooseContext(root, localManifest, cloudManifest, {
      localSnapshot: 'stale-local',
      localExtensions: '',
      cloudSnapshot: 'stale-cloud',
      cloudExtensions: '',
    }, 'local');

    assert.deepEqual(await chooseStage.run(context), { kind: 'continue' });
    assert.equal(context.report.snapshotChoice, 'local');
    assert.equal(context.report.resolvedConflict, true);
    assert.deepEqual(await readJsonFile(path.join(context.paths.repositoryHostRoot, 'manifest.json')), localManifest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('同步期间本机被改动时放弃写回', async () => {
  const context = stageContext({
    artifacts: { strategy: 'merge', choice: 'cloud', localFingerprint: 'round-start' },
    dependencies: stageDependencies({
      adapter: {
        fingerprint: async () => 'changed-midway',
        restoreSnapshot: async () => { throw new Error('本机已改动时不应写回'); },
      } as unknown as ProfileAdapter,
    }),
  });
  assert.deepEqual(await stageTesting.applyStage.run(context), { kind: 'blocked', reason: 'local-changed' });
});

test('采用本机并推送成功后立即前移基准，之后被拦住也不会误判冲突', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-push-baseline-'));
  try {
    const repositoryHostRoot = path.join(root, 'repository', 'vscode');
    const pushed = testManifest({ 'profiles/default/settings.json': 'first-edit' });
    await mkdir(repositoryHostRoot, { recursive: true });
    await writeFile(path.join(repositoryHostRoot, 'manifest.json'), JSON.stringify(pushed));

    const updates: Array<Record<string, unknown>> = [];
    const context = stageContext({
      artifacts: { strategy: 'merge', choice: 'local', localManifest: pushed, localFingerprint: 'round-start' },
      paths: { temporaryRoot: path.join(root, 'tmp'), localHostRoot: path.join(root, 'tmp', 'vscode'), repositoryHostRoot },
      dependencies: stageDependencies({
        git: fakeGit({ stageHost: async () => [], pushIfAhead: async () => undefined }),
        adapter: { fingerprint: async () => 'changed-midway' } as unknown as ProfileAdapter,
        runtimeState: {
          get: () => ({ ...DEFAULT_RUNTIME_STATE }),
          update: async (patch: Record<string, unknown>) => { updates.push(patch); },
        } as unknown as RuntimeStateStore,
      }),
    });

    assert.deepEqual(await stageTesting.pushStage.run(context), { kind: 'continue' });
    const digest = snapshotDigest(pushed, 'win32');
    const baseline = {
      localSnapshot: digest.snapshot,
      localExtensions: digest.extensions,
      cloudSnapshot: digest.snapshot,
      cloudExtensions: digest.extensions,
      localProfiles: [],
      cloudProfiles: [],
    };
    // 用户的选择随这次推送兑现，一并清除，不留给下一次真正的冲突。
    assert.deepEqual(updates, [{ baseline, pendingResolution: undefined, profileResolution: undefined }]);

    // 用户在本轮期间又改了一次：写回被拦住，finalize 不会执行。
    assert.deepEqual(await stageTesting.applyStage.run(context), { kind: 'blocked', reason: 'local-changed' });
    // 下一轮云端仍是刚推上去的那份，只有本机变了，应当直接采用本机而不是询问用户。
    const secondEdit = snapshotDigest(testManifest({ 'profiles/default/settings.json': 'second-edit' }), 'win32');
    assert.equal(decideSnapshotChoice(baseline, secondEdit, digest, { ignoreExtensions: false }), 'local');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('推送失败、采用云端或还原流程时推送步骤不写基准', async () => {
  const updates: Array<Record<string, unknown>> = [];
  const runtimeState = {
    get: () => ({ ...DEFAULT_RUNTIME_STATE }),
    update: async (patch: Record<string, unknown>) => { updates.push(patch); },
  } as unknown as RuntimeStateStore;
  const localManifest = testManifest({ 'profiles/default/settings.json': 'local' });

  const failing = stageContext({
    artifacts: { choice: 'local', localManifest },
    dependencies: stageDependencies({
      runtimeState,
      git: fakeGit({ stageHost: async () => [], pushIfAhead: async () => { throw new Error('推送失败'); } }),
    }),
  });
  await assert.rejects(() => stageTesting.pushStage.run(failing), /推送失败/);

  const git = fakeGit({ stageHost: async () => [], pushIfAhead: async () => undefined });
  const adopting = stageContext({
    artifacts: { choice: 'cloud', localManifest },
    dependencies: stageDependencies({ runtimeState, git }),
  });
  assert.deepEqual(await stageTesting.pushStage.run(adopting), { kind: 'continue' });

  // 还原流程的仓库内容是历史快照，不等于本机清单，基准留给 finalize 在写回之后记录。
  const restoring = restoreContext(tmpdir(), {
    artifacts: { choice: 'local', localManifest },
    dependencies: stageDependencies({ runtimeState, git }),
  });
  assert.deepEqual(await stageTesting.pushStage.run(restoring), { kind: 'continue' });
  assert.deepEqual(updates, []);
});

test('没有写回本机时基准取本轮推送的快照，并记录待收敛的扩展', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-finalize-'));
  try {
    const repositoryHostRoot = path.join(root, 'repository', 'vscode');
    const localManifest = testManifest({ 'profiles/default/settings.json': 'local', 'extensions.json': 'ext' });
    const cloudManifest = testManifest({ 'profiles/default/settings.json': 'cloud' });
    await mkdir(repositoryHostRoot, { recursive: true });
    await writeFile(path.join(repositoryHostRoot, 'manifest.json'), JSON.stringify(cloudManifest));

    const updates: Array<Record<string, unknown>> = [];
    const context = stageContext({
      artifacts: { localManifest },
      report: { ...createSyncReport('sync'), extensionsPending: ['missing.one'] },
      paths: { temporaryRoot: path.join(root, 'tmp'), localHostRoot: path.join(root, 'tmp', 'vscode'), repositoryHostRoot },
      dependencies: stageDependencies({
        adapter: {
          createSnapshot: async () => { throw new Error('没有写回本机就不该重新采集'); },
        } as unknown as ProfileAdapter,
        runtimeState: {
          get: () => ({ ...DEFAULT_RUNTIME_STATE }),
          update: async (patch: Record<string, unknown>) => { updates.push(patch); },
        } as unknown as RuntimeStateStore,
      }),
    });

    assert.deepEqual(await stageTesting.finalizeStage.run(context), { kind: 'continue' });
    assert.deepEqual(updates, [{
      baseline: {
        localSnapshot: snapshotDigest(localManifest, 'win32').snapshot,
        localExtensions: 'ext',
        cloudSnapshot: snapshotDigest(cloudManifest, 'win32').snapshot,
        cloudExtensions: '',
        localProfiles: [],
        cloudProfiles: [],
      },
      extensionsPending: ['missing.one'],
      extensionsPendingRounds: 1,
      pendingResolution: undefined,
      profileResolution: undefined,
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('扩展连续多轮装不上后不再排除在改动判定之外', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-finalize-settle-'));
  try {
    const repositoryHostRoot = path.join(root, 'repository', 'vscode');
    const manifest = testManifest({ 'profiles/default/settings.json': 'x' });
    await mkdir(repositoryHostRoot, { recursive: true });
    await writeFile(path.join(repositoryHostRoot, 'manifest.json'), JSON.stringify(manifest));

    const updates: Array<Record<string, unknown>> = [];
    const context = stageContext({
      artifacts: { localManifest: manifest },
      report: { ...createSyncReport('sync'), extensionsPending: ['gone.one'] },
      paths: { temporaryRoot: path.join(root, 'tmp'), localHostRoot: path.join(root, 'tmp', 'vscode'), repositoryHostRoot },
      dependencies: stageDependencies({
        runtimeState: {
          get: () => ({ ...DEFAULT_RUNTIME_STATE, extensionsPending: ['gone.one'], extensionsPendingRounds: 2 }),
          update: async (patch: Record<string, unknown>) => { updates.push(patch); },
        } as unknown as RuntimeStateStore,
      }),
    });

    assert.deepEqual(await stageTesting.finalizeStage.run(context), { kind: 'continue' });
    assert.equal(updates[0]?.extensionsPending, undefined);
    assert.equal(updates[0]?.extensionsPendingRounds, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('所选提交没有本宿主快照时中止还原且不清空仓库目录', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-restore-missing-'));
  try {
    const repositoryHostRoot = path.join(root, 'repository', 'vscode');
    await mkdir(repositoryHostRoot, { recursive: true });
    await writeFile(path.join(repositoryHostRoot, 'manifest.json'), '{"schemaVersion":1}');
    const context = restoreContext(root, {
      dependencies: stageDependencies({ git: fakeGit({ exportHostTree: async () => false }) }),
    });
    await assert.rejects(() => restoreTesting.exportHistoryStage.run(context), /没有本宿主的配置快照/);
    assert.equal(await readFile(path.join(repositoryHostRoot, 'manifest.json'), 'utf8'), '{"schemaVersion":1}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('历史快照可能包含凭据时拒绝还原且不写入仓库目录', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-restore-secret-'));
  try {
    const context = restoreContext(root, {
      dependencies: stageDependencies({
        adapter: { listProfiles: async () => [] } as unknown as ProfileAdapter,
        git: fakeGit({
          exportHostTree: async (_commit: string, _host: string, targetRoot: string) => {
            await writeHistorySnapshot(targetRoot, [], { 'profiles/default/settings.json': '{"apiKey": "abcdef123456"}' });
            return true;
          },
        }),
      }),
    });
    await assert.rejects(() => restoreTesting.exportHistoryStage.run(context), /已拒绝还原/);
    await assert.rejects(readdir(path.join(root, 'repository', 'vscode')), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('还原把历史快照换进仓库目录并按采用本机处理', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-restore-export-'));
  try {
    const repositoryHostRoot = path.join(root, 'repository', 'vscode');
    await mkdir(repositoryHostRoot, { recursive: true });
    // 仓库里已有的多余文件必须被历史快照整体替换，不能残留。
    await writeFile(path.join(repositoryHostRoot, 'stale.json'), '{}');
    const context = restoreContext(root, {
      dependencies: stageDependencies({
        adapter: { listProfiles: async () => [] } as unknown as ProfileAdapter,
        git: fakeGit({
          exportHostTree: async (_commit: string, _host: string, targetRoot: string) => {
            await writeHistorySnapshot(targetRoot, [], { 'profiles/default/settings.json': '{"editor.fontSize": 14}' });
            return true;
          },
        }),
      }),
    });
    assert.deepEqual(await restoreTesting.exportHistoryStage.run(context), { kind: 'continue' });
    assert.equal(context.artifacts.commitMessage, '还原到 abcdefg：第一次 备份：初始配置');
    assert.equal(context.artifacts.choice, 'local');
    assert.equal(context.report.snapshotChoice, 'local');
    assert.equal(
      await readFile(path.join(repositoryHostRoot, 'profiles', 'default', 'settings.json'), 'utf8'),
      '{"editor.fontSize": 14}',
    );
    await assert.rejects(readFile(path.join(repositoryHostRoot, 'stale.json'), 'utf8'), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('还原使用预置的提交说明，不再调用 AI', async () => {
  let committed: string | undefined;
  let aiCalled = false;
  const context = restoreContext(tmpdir(), {
    artifacts: { choice: 'local', commitMessage: '还原到 abcdefg：初始配置' },
    dependencies: stageDependencies({
      git: fakeGit({
        stageHost: async () => ['profiles/default/settings.json'],
        commitAndPush: async (_configuration: SyncConfiguration, message: string) => { committed = message; },
      }),
      ai: { createCommitMessage: async () => { aiCalled = true; return 'AI 生成的说明'; } } as unknown as AiService,
    }),
  });
  assert.deepEqual(await stageTesting.pushStage.run(context), { kind: 'continue' });
  assert.equal(committed, '[test-device] 还原到 abcdefg：初始配置');
  assert.equal(aiCalled, false);
});

test('云端有本机没有、也不是本机删掉的 Profile 时暂停并记下名称，不改写仓库', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-profiles-cloud-only-'));
  try {
    const local = profileManifest([]);
    const cloud = profileManifest(['工作'], { 'profiles/named-工作/settings.json': 'w' });
    const { context, updates } = await chooseContext(root, local, cloud, {
      localSnapshot: 's', localExtensions: '', cloudSnapshot: 's', cloudExtensions: '', localProfiles: [], cloudProfiles: [],
    });
    const outcome = await chooseStage.run(context);
    assert.equal(outcome.kind === 'blocked' ? outcome.reason : undefined, 'profiles-mismatch');
    assert.deepEqual(updates, [{ profileMismatch: { kind: 'cloud-only', names: ['工作'] } }]);
    assert.deepEqual(await readJsonFile(path.join(context.paths.repositoryHostRoot, 'manifest.json')), cloud);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('本机删掉的 Profile 随本机推送传播，不打扰用户', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-profiles-local-deleted-'));
  try {
    const local = profileManifest([]);
    const cloud = profileManifest(['工作'], { 'profiles/named-工作/settings.json': 'w' });
    const synced = snapshotDigest(cloud, 'win32').snapshot;
    const { context } = await chooseContext(root, local, cloud, {
      localSnapshot: synced, localExtensions: '', cloudSnapshot: synced, cloudExtensions: '', localProfiles: ['工作'], cloudProfiles: ['工作'],
    });
    assert.deepEqual(await chooseStage.run(context), { kind: 'continue' });
    assert.equal(context.report.snapshotChoice, 'local');
    assert.deepEqual(await readJsonFile(path.join(context.paths.repositoryHostRoot, 'manifest.json')), local);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('用户确认从云端删除 Profile 后改写仓库，没有采用本机时单独提交这次删除', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-profiles-drop-'));
  try {
    const local = profileManifest([], { 'profiles/default/settings.json': 'a' });
    const cloud = profileManifest(['工作'], { 'profiles/default/settings.json': 'a', 'profiles/named-工作/settings.json': 'w' });
    let committed: string | undefined;
    const { context } = await chooseContext(root, local, cloud, {
      localSnapshot: snapshotDigest(local, 'win32').snapshot, localExtensions: '', cloudSnapshot: 'stale', cloudExtensions: '',
      localProfiles: [], cloudProfiles: [],
    }, undefined, {
      state: { profileResolution: { kind: 'cloud-only', names: ['工作'] } },
      dependencies: {
        git: fakeGit({
          stageHost: async () => ['profiles/named-工作/settings.json'],
          commitAndPush: async (_configuration: SyncConfiguration, message: string) => { committed = message; },
        }),
      },
    });
    const profileRoot = path.join(context.paths.repositoryHostRoot, 'profiles', 'named-工作');
    await mkdir(profileRoot, { recursive: true });
    await writeFile(path.join(profileRoot, 'settings.json'), '{}');

    assert.deepEqual(await chooseStage.run(context), { kind: 'continue' });
    // 去掉那个 Profile 后两侧一致，不改写本机，但仓库的删除仍要提交。
    assert.equal(context.report.snapshotChoice, 'none');
    assert.equal(context.artifacts.commitMessage, '从云端删除 Profile：工作');
    await assert.rejects(readdir(profileRoot), /ENOENT/);
    const manifest = await readJsonFile(path.join(context.paths.repositoryHostRoot, 'manifest.json')) as typeof cloud;
    assert.deepEqual(manifest.profiles.map((profile) => profile.name), ['默认']);
    assert.deepEqual(Object.keys(manifest.files), ['profiles/default/settings.json']);

    assert.deepEqual(await stageTesting.pushStage.run(context), { kind: 'continue' });
    assert.equal(committed, '[test-device] 从云端删除 Profile：工作');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('云端删掉、本机仍有的 Profile 暂停询问，用户选择保留后继续', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-profiles-deleted-in-cloud-'));
  try {
    const local = profileManifest(['旧'], { 'profiles/named-旧/settings.json': 'o' });
    const cloud = profileManifest([]);
    const baseline = {
      localSnapshot: snapshotDigest(local, 'win32').snapshot, localExtensions: '', cloudSnapshot: 'stale', cloudExtensions: '',
      localProfiles: ['旧'], cloudProfiles: ['旧'],
    };
    const first = await chooseContext(root, local, cloud, baseline);
    const outcome = await chooseStage.run(first.context);
    assert.equal(outcome.kind === 'blocked' ? outcome.reason : undefined, 'profiles-mismatch');
    assert.deepEqual(first.updates, [{ profileMismatch: { kind: 'deleted-in-cloud', names: ['旧'] } }]);

    const kept = await chooseContext(root, local, cloud, baseline, undefined, {
      state: { profileResolution: { kind: 'deleted-in-cloud', names: ['旧'] } },
    });
    assert.deepEqual(await chooseStage.run(kept.context), { kind: 'continue' });
    // 本机没改、云端改了：采用云端，本机的 Profile 原样保留，之后随本机改动重新上传。
    assert.equal(kept.context.report.snapshotChoice, 'cloud');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('本机新建了云端已有的同名 Profile 时先套用云端内容再判定', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-profiles-claim-'));
  try {
    const files = { 'profiles/default/settings.json': 'a', 'profiles/named-工作/settings.json': 'w' };
    const local = profileManifest(['工作'], { 'profiles/default/settings.json': 'a' });
    const cloud = profileManifest(['工作'], files);
    let claimed: string[] | undefined;
    const { context } = await chooseContext(root, local, cloud, {
      localSnapshot: 'stale', localExtensions: '', cloudSnapshot: snapshotDigest(cloud, 'win32').snapshot, cloudExtensions: '',
      localProfiles: [], cloudProfiles: ['工作'],
    }, undefined, {
      dependencies: {
        adapter: {
          restoreSnapshot: async (_root: string, options: { profileNames?: Set<string> }) => {
            claimed = [...options.profileNames ?? []];
            return { changedFiles: [], missingProfiles: [], localOnlyProfiles: [] };
          },
          createSnapshot: async () => profileManifest(['工作'], files),
          fingerprint: async () => 'claimed',
        } as unknown as ProfileAdapter,
      },
    });
    assert.deepEqual(await chooseStage.run(context), { kind: 'continue' });
    assert.deepEqual(claimed, ['工作']);
    // 写回前的二次确认要以套用后的本机为准，否则会被误判成同步期间被改动。
    assert.equal(context.artifacts.localFingerprint, 'claimed');
    // 新建的空 Profile 没有被当成本机改动推上去覆盖云端。
    assert.equal(context.report.snapshotChoice, 'none');
    assert.match(context.report.profileMessage ?? '', /工作/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('推送本机快照时保留云端其他平台的快捷键，非默认 Profile 窗口还保留云端扩展清单', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-preserve-'));
  try {
    const local = profileManifest([], { 'profiles/default/keybindings.win32.json': 'win-new', 'extensions.json': 'local-ext' });
    const cloud = profileManifest([], {
      'profiles/default/keybindings.win32.json': 'win-old',
      'profiles/default/keybindings.darwin.json': 'mac',
      'extensions.json': 'cloud-ext',
    });
    const { context } = await chooseContext(root, local, cloud, {
      localSnapshot: 'stale', localExtensions: 'cloud-ext', cloudSnapshot: snapshotDigest(cloud, 'win32').snapshot, cloudExtensions: 'cloud-ext',
    }, undefined, {
      dependencies: { environment: { kind: 'vscode', userDataPath: '/user-data', runtimePath: '/runtime', platform: 'win32', inDefaultProfile: false } },
    });
    const { localHostRoot, repositoryHostRoot } = context.paths;
    await mkdir(path.join(localHostRoot, 'profiles', 'default'), { recursive: true });
    await writeFile(path.join(localHostRoot, 'profiles', 'default', 'keybindings.win32.json'), '[]');
    await writeFile(path.join(localHostRoot, 'extensions.json'), '[{"identifier":{"id":"local.only"}}]');
    await mkdir(path.join(repositoryHostRoot, 'profiles', 'default'), { recursive: true });
    await writeFile(path.join(repositoryHostRoot, 'profiles', 'default', 'keybindings.darwin.json'), '[{"key":"cmd+k"}]');
    await writeFile(path.join(repositoryHostRoot, 'extensions.json'), '[{"identifier":{"id":"cloud.only"}}]');

    assert.deepEqual(await chooseStage.run(context), { kind: 'continue' });
    assert.equal(context.report.snapshotChoice, 'local');
    const manifest = await readJsonFile(path.join(repositoryHostRoot, 'manifest.json')) as typeof cloud;
    assert.deepEqual(manifest.files, {
      'profiles/default/keybindings.win32.json': 'win-new',
      'profiles/default/keybindings.darwin.json': 'mac',
      'extensions.json': 'cloud-ext',
    });
    assert.equal(await readFile(path.join(repositoryHostRoot, 'profiles', 'default', 'keybindings.darwin.json'), 'utf8'), '[{"key":"cmd+k"}]');
    assert.equal(await readFile(path.join(repositoryHostRoot, 'extensions.json'), 'utf8'), '[{"identifier":{"id":"cloud.only"}}]');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** 扩展步骤的上下文：仓库里有一份宿主级扩展清单，本机已安装列表来自 vscode 桩。 */
async function extensionContext(root: string, choice: 'none' | 'cloud', overrides: { pending?: string[]; inDefaultProfile?: boolean } = {}) {
  const repositoryHostRoot = path.join(root, 'repository', 'vscode');
  await writeExtensionSnapshot(repositoryHostRoot, ['cloud.one'], 'x');
  return stageContext({
    artifacts: { choice },
    paths: { temporaryRoot: path.join(root, 'tmp'), localHostRoot: path.join(root, 'tmp', 'vscode'), repositoryHostRoot },
    dependencies: stageDependencies({
      environment: { kind: 'vscode', userDataPath: '/user-data', runtimePath: '/runtime', platform: 'win32', inDefaultProfile: overrides.inDefaultProfile ?? true },
      adapter: { listInstalledExtensionIds: installedExtensionIds } as unknown as ProfileAdapter,
      runtimeState: {
        get: () => ({ ...DEFAULT_RUNTIME_STATE, ...(overrides.pending ? { extensionsPending: overrides.pending } : {}) }),
        update: async () => undefined,
      } as unknown as RuntimeStateStore,
    }),
  });
}

test('没有采用云端也没有待收敛扩展时不装卸任何扩展，用户新装的扩展不会被卸掉', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-ext-none-'));
  resetExtensionStub();
  extensionWaitTesting.resetSkippedInstallIds();
  try {
    markExtensionInstalled('local.new');
    const context = await extensionContext(root, 'none');
    assert.deepEqual(await stageTesting.extensionsStage.run(context), { kind: 'continue' });
    assert.deepEqual(installCommandCalls, []);
    assert.deepEqual(uninstallCommandCalls, []);

    // 收敛期间只继续处理上一轮没装完的那几个。
    const settling = await extensionContext(root, 'none', { pending: ['cloud.one'] });
    assert.deepEqual(await stageTesting.extensionsStage.run(settling), { kind: 'continue' });
    assert.deepEqual(installCommandCalls, ['cloud.one']);
    assert.deepEqual(uninstallCommandCalls, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('采用云端时本机扩展按清单收敛', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-ext-cloud-'));
  resetExtensionStub();
  extensionWaitTesting.resetSkippedInstallIds();
  try {
    markExtensionInstalled('local.only');
    const context = await extensionContext(root, 'cloud');
    assert.deepEqual(await stageTesting.extensionsStage.run(context), { kind: 'continue' });
    assert.deepEqual(uninstallCommandCalls, ['local.only']);
    assert.deepEqual(installCommandCalls, ['cloud.one']);
    assert.equal(context.report.extensionsPending, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('窗口不在默认 Profile 时不装卸扩展，收敛状态与扩展基准原样保留', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-ext-deferred-'));
  resetExtensionStub();
  extensionWaitTesting.resetSkippedInstallIds();
  try {
    markExtensionInstalled('local.only');
    const context = await extensionContext(root, 'cloud', { inDefaultProfile: false });
    assert.deepEqual(await stageTesting.extensionsStage.run(context), { kind: 'continue' });
    assert.deepEqual(installCommandCalls, []);
    assert.deepEqual(uninstallCommandCalls, []);
    assert.equal(context.report.extensionsDeferred, true);

    const updates: Array<Record<string, unknown>> = [];
    const manifest = testManifest({ 'profiles/default/settings.json': 'x', 'extensions.json': 'now' });
    const finalizing = stageContext({
      artifacts: { localManifest: manifest },
      report: { ...createSyncReport('sync'), extensionsDeferred: true },
      paths: context.paths,
      dependencies: stageDependencies({
        environment: { kind: 'vscode', userDataPath: '/user-data', runtimePath: '/runtime', platform: 'win32', inDefaultProfile: false },
        runtimeState: {
          get: () => ({
            ...DEFAULT_RUNTIME_STATE,
            baseline: { localSnapshot: 'l', localExtensions: 'old-local', cloudSnapshot: 'c', cloudExtensions: 'old-cloud' },
            extensionsPending: ['p.one'],
            extensionsPendingRounds: 1,
          }),
          update: async (patch: Record<string, unknown>) => { updates.push(patch); },
        } as unknown as RuntimeStateStore,
      }),
    });
    assert.deepEqual(await stageTesting.finalizeStage.run(finalizing), { kind: 'continue' });
    const baseline = updates[0]?.baseline as { localExtensions: string; cloudExtensions: string };
    // 前移扩展基准会把没装的云端清单记成「已同步」，回到默认 Profile 窗口后也不会再装。
    assert.equal(baseline.localExtensions, 'old-local');
    assert.equal(baseline.cloudExtensions, 'old-cloud');
    assert.deepEqual(updates[0]?.extensionsPending, ['p.one']);
    assert.equal(updates[0]?.extensionsPendingRounds, 1);

    // 第一次同步就在命名 Profile 窗口里时没有可沿用的基准，云端扩展部分记成空，留给默认 Profile 窗口去收敛。
    updates.length = 0;
    const first = stageContext({
      ...finalizing,
      dependencies: { ...finalizing.dependencies, runtimeState: {
        get: () => ({ ...DEFAULT_RUNTIME_STATE }),
        update: async (patch: Record<string, unknown>) => { updates.push(patch); },
      } as unknown as RuntimeStateStore },
    });
    assert.deepEqual(await stageTesting.finalizeStage.run(first), { kind: 'continue' });
    assert.equal((updates[0]?.baseline as { cloudExtensions: string }).cloudExtensions, '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
