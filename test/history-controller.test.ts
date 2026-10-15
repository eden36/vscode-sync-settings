import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigurationStore } from '../src/configuration';
import { MultiWindowCoordinator } from '../src/coordinator';
import { ConfigurationRepositoryGitService, RepositoryCommit } from '../src/git-service';
import { HistoryController } from '../src/history-controller';
import { SidebarProvider } from '../src/sidebar';
import { HistoryEntry } from '../src/sidebar-messages';
import { DEFAULT_CONFIGURATION } from '../src/types';
import { informationMessages, resetWindowStub } from './vscode-stub';

const COMMIT: RepositoryCommit = {
  hash: 'a'.repeat(40),
  shortHash: 'aaaaaaa',
  committedAt: '2026-08-20T10:00:00.000Z',
  subject: '第一次 备份：初始配置',
  tags: [],
};

/** 假的侧边栏、协调器与仓库：只记录调用，不触碰磁盘、网络与 vscode。 */
function harness(options: {
  enabled: boolean;
  repositoryUrl?: string;
  cached: RepositoryCommit[] | undefined;
  lockAvailable?: boolean;
}) {
  const calls = {
    opened: 0,
    lists: [] as HistoryEntry[][],
    errors: [] as string[],
    status: [] as string[],
    locks: 0,
    refreshed: 0,
  };
  const sidebar = {
    openHistoryPage: async () => { calls.opened += 1; },
    postHistoryList: async (entries: HistoryEntry[]) => { calls.lists.push(entries); },
    postHistoryError: async (message: string) => { calls.errors.push(message); },
    postHistoryBusy: async () => undefined,
    closeHistoryPage: async () => undefined,
  } as unknown as SidebarProvider;
  const coordinator = {
    runExclusive: async (action: () => Promise<void>) => {
      calls.locks += 1;
      if (options.lockAvailable === false) return false;
      await action();
      return true;
    },
  } as unknown as MultiWindowCoordinator;
  const repository = {
    listCachedCommits: async () => options.cached,
    refreshCommits: async () => {
      calls.refreshed += 1;
      return options.cached ?? [];
    },
  } as unknown as ConfigurationRepositoryGitService;
  const controller = new HistoryController({
    coordinator,
    repository,
    configurationStore: {
      get: () => ({ ...DEFAULT_CONFIGURATION, repositoryUrl: options.repositoryUrl ?? 'git@example.com:user/settings.git' }),
    } as unknown as ConfigurationStore,
    sidebar,
    hostKind: 'vscode',
    isEnabled: () => options.enabled,
    reportStatus: (message) => { calls.status.push(message); },
    restore: async () => undefined,
  });
  return { controller, calls };
}

test('同步关闭但本机已有云端缓存时允许打开历史页面', async () => {
  resetWindowStub();
  const { controller, calls } = harness({ enabled: false, cached: [COMMIT] });
  await controller.open();
  assert.equal(calls.opened, 1);
  assert.deepEqual(informationMessages, []);
});

test('同步关闭且本机没有云端缓存时提示先开启同步，不打开页面', async () => {
  resetWindowStub();
  const { controller, calls } = harness({ enabled: false, cached: undefined });
  await controller.open();
  assert.equal(calls.opened, 0);
  assert.equal(informationMessages.length, 1);
  assert.match(informationMessages[0]!, /先开启同步/);
});

test('同步开启时即使没有本地缓存也允许打开，由页面联网获取', async () => {
  resetWindowStub();
  const { controller, calls } = harness({ enabled: true, cached: undefined });
  await controller.open();
  assert.equal(calls.opened, 1);
});

test('没有填写仓库地址时不打开页面并提示填写', async () => {
  resetWindowStub();
  const { controller, calls } = harness({ enabled: true, repositoryUrl: '', cached: [COMMIT] });
  await controller.open();
  assert.equal(calls.opened, 0);
  assert.deepEqual(calls.status, ['请填写 Git 仓库地址。']);
});

test('读取本地缓存列表不占独占锁，其他窗口正在同步时也能看到列表', async () => {
  const { controller, calls } = harness({ enabled: true, cached: [COMMIT], lockAvailable: false });
  await controller.load(30, false);
  assert.equal(calls.locks, 0);
  assert.equal(calls.lists.length, 1);
  assert.equal(calls.lists[0]![0]!.hash, COMMIT.hash);
  assert.deepEqual(calls.errors, []);
});

test('联网刷新抢不到独占锁时保留已显示的缓存列表并提示暂未刷新', async () => {
  const { controller, calls } = harness({ enabled: true, cached: [COMMIT], lockAvailable: false });
  await controller.load(30, true);
  assert.equal(calls.lists.length, 1);
  assert.equal(calls.refreshed, 0);
  assert.equal(calls.errors.length, 1);
  assert.match(calls.errors[0]!, /暂未刷新/);
});

test('同步关闭时联网刷新照常执行', async () => {
  const { controller, calls } = harness({ enabled: false, cached: [COMMIT] });
  await controller.load(30, true);
  assert.equal(calls.refreshed, 1);
  assert.equal(calls.lists.length, 2);
});
