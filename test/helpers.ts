import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { ConfigurationRepositoryGitService } from '../src/git-service';
import { ProfileAdapter } from '../src/profile-adapter';
import { DEFAULT_RUNTIME_STATE, RuntimeStateRecord, RuntimeStateStore } from '../src/runtime-state';
import { AiService } from '../src/ai';
import { SyncContext, SyncDependencies } from '../src/pipeline/types';
import { createMachine, SchedulerMachine } from '../src/scheduler';
import { createSyncReport, DEFAULT_CONFIGURATION, SnapshotManifest, SyncBaseline } from '../src/types';

export async function writeExtensionSnapshot(root: string, ids: string[] | undefined, hash: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const files: Record<string, string> = {};
  if (ids) {
    await writeFile(path.join(root, 'extensions.json'), `${JSON.stringify(ids.map((id) => ({ identifier: { id } })), null, 2)}
`);
    files['extensions.json'] = hash;
  }
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    host: 'vscode',
    createdAt: '',
    profiles: [{ id: 'default', name: '默认', isDefault: true }],
    files,
  }));
}

/** 还原流程的上下文：临时目录与仓库宿主目录都落在测试的临时根目录下。 */
export function restoreContext(root: string, overrides: Partial<SyncContext> = {}): SyncContext {
  return stageContext({
    restoreTarget: {
      hash: 'a'.repeat(40),
      shortHash: 'abcdefg',
      committedAt: '2026-08-20T10:00:00.000Z',
      subject: '第一次 备份：初始配置',
      tags: [],
    },
    paths: {
      temporaryRoot: path.join(root, 'tmp'),
      localHostRoot: path.join(root, 'tmp', 'vscode'),
      repositoryHostRoot: path.join(root, 'repository', 'vscode'),
    },
    ...overrides,
  });
}

export async function writeHistorySnapshot(
  targetRoot: string,
  profiles: Array<{ id: string; name: string; isDefault: boolean }>,
  files: Record<string, string>,
): Promise<void> {
  await mkdir(targetRoot, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    host: 'vscode',
    createdAt: '2026-08-20T10:00:00.000Z',
    profiles,
    files: Object.fromEntries(Object.keys(files).map((relative) => [relative, 'hash'])),
  };
  await writeFile(path.join(targetRoot, 'manifest.json'), JSON.stringify(manifest));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(targetRoot, ...relative.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

export function testManifest(files: Record<string, string>): SnapshotManifest {
  return {
    schemaVersion: 1,
    host: 'vscode',
    createdAt: '',
    profiles: [{ id: 'default', name: '默认', isDefault: true }],
    profileMetadata: [{ location: 'a', name: 'A' }],
    files,
  };
}

/** 构造一轮「本机与云端都已就位」的择一场景：本机快照在临时目录，云端快照在仓库目录。 */
export async function chooseContext(
  root: string,
  localManifest: SnapshotManifest,
  cloudManifest: SnapshotManifest,
  baseline: SyncBaseline,
  resolution?: 'local' | 'cloud',
  options: { state?: Partial<RuntimeStateRecord>; dependencies?: Partial<SyncDependencies> } = {},
): Promise<{ context: SyncContext; conflictBackupRoot: string; updates: Array<Partial<RuntimeStateRecord>> }> {
  const localHostRoot = path.join(root, 'tmp', 'vscode');
  const repositoryHostRoot = path.join(root, 'repository', 'vscode');
  const conflictBackupRoot = path.join(root, 'conflict-backups');
  await mkdir(localHostRoot, { recursive: true });
  await mkdir(repositoryHostRoot, { recursive: true });
  await writeFile(path.join(localHostRoot, 'manifest.json'), JSON.stringify(localManifest));
  await writeFile(path.join(repositoryHostRoot, 'manifest.json'), JSON.stringify(cloudManifest));
  const updates: Array<Partial<RuntimeStateRecord>> = [];
  const context = stageContext({
    artifacts: { strategy: 'merge', remoteExists: true, localManifest },
    ...(resolution ? { resolution } : {}),
    paths: { temporaryRoot: path.join(root, 'tmp'), localHostRoot, repositoryHostRoot },
    dependencies: stageDependencies({
      conflictBackupRoot,
      runtimeState: {
        get: () => ({ ...DEFAULT_RUNTIME_STATE, baseline, ...options.state }),
        update: async (patch: Partial<RuntimeStateRecord>) => { updates.push(patch); },
      } as unknown as RuntimeStateStore,
      ...options.dependencies,
    }),
  });
  return { context, conflictBackupRoot, updates };
}

/** 带命名 Profile 的测试清单；命名 Profile 的 id 只是测试里的占位，真实 id 由名称派生。 */
export function profileManifest(names: string[], files: Record<string, string> = {}): SnapshotManifest {
  return {
    schemaVersion: 2,
    host: 'vscode',
    createdAt: '',
    profiles: [
      { id: 'default', name: '默认', isDefault: true },
      ...names.map((name) => ({ id: `named-${name}`, name, isDefault: false })),
    ],
    files,
  };
}

export function leaderMachine(): SchedulerMachine {
  return { ...createMachine({ enabled: true, configured: true, link: 'no-repository' }), isLeader: true };
}

export function stageDependencies(overrides: Partial<SyncDependencies> = {}): SyncDependencies {
  return {
    environment: { kind: 'vscode', userDataPath: '/user-data', runtimePath: '/runtime', platform: 'win32' },
    adapter: {} as unknown as ProfileAdapter,
    git: fakeGit({}),
    ai: {} as unknown as AiService,
    runtimeState: {
      get: () => ({ ...DEFAULT_RUNTIME_STATE }),
      update: async () => undefined,
    } as unknown as RuntimeStateStore,
    windowSafety: async () => ({ activeWindows: 1, dirtyWindows: 0, unreadableWindows: 0 }),
    isCancellationRequested: () => false,
    updateStatus: () => undefined,
    conflictBackupRoot: '/runtime/conflict-backups',
    deviceName: 'test-device',
    ...overrides,
  };
}

export function stageContext(overrides: Partial<SyncContext> = {}): SyncContext {
  return {
    dependencies: stageDependencies(),
    configuration: { ...DEFAULT_CONFIGURATION, repositoryUrl: 'git@example.com:user/settings.git', mode: 'sync' },
    adoptCloud: false,
    paths: {
      temporaryRoot: path.join(tmpdir(), 'profile-git-sync-absent', 'tmp'),
      localHostRoot: path.join(tmpdir(), 'profile-git-sync-absent', 'tmp', 'vscode'),
      repositoryHostRoot: path.join(tmpdir(), 'profile-git-sync-absent', 'repository'),
    },
    report: createSyncReport('sync'),
    artifacts: {},
    ...overrides,
  };
}

export function fakeGit(overrides: Partial<ConfigurationRepositoryGitService>): ConfigurationRepositoryGitService {
  return { repositoryPath: '/runtime/repository', ...overrides } as unknown as ConfigurationRepositoryGitService;
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('等待条件超时。');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function fakeExtensionContext(globalValues: Map<string, unknown>): vscode.ExtensionContext {
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
