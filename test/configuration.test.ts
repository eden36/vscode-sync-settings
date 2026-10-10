import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { ConfigurationStore } from '../src/configuration';
import {
  compareConfigurationRecords,
  createConfigurationRecord,
  hasEmbeddedCredentials,
  isValidTagName,
  parseConfigurationRecord,
  parsePluginConfiguration,
  relateConfigurationRecords,
  resolveRepositoryUrl,
} from '../src/configuration-record';
import { DEFAULT_CONFIGURATION, PluginConfiguration } from '../src/types';
import { resetApplicationSettings } from './vscode-stub';
import { fakeExtensionContext } from './helpers';

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

test('检测 URL 中嵌入的明文凭据', () => {
  assert.equal(hasEmbeddedCredentials('https://user:ghp_token@github.com/user/repo.git'), true);
  assert.equal(hasEmbeddedCredentials('git@github.com:user/repo.git'), false);
});

test('标签名称沿用分支的命名规则并另加长度上限', () => {
  assert.equal(isValidTagName('v1.0-stable'), true);
  assert.equal(isValidTagName('release/2026_08'), true);
  assert.equal(isValidTagName(''), false);
  assert.equal(isValidTagName('-v1'), false);
  assert.equal(isValidTagName('.v1'), false);
  assert.equal(isValidTagName('v1..2'), false);
  assert.equal(isValidTagName('v 1'), false);
  assert.equal(isValidTagName('v1.lock'), false);
  assert.equal(isValidTagName('v'.repeat(100)), true);
  assert.equal(isValidTagName('v'.repeat(101)), false);
});
