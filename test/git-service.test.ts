import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { ConfigurationRepositoryGitService, testing as gitTesting } from '../src/git-service';
import { runProcess } from '../src/process';
import { SyncConfiguration } from '../src/types';

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

test('远端探测只在远端分支前进时报告变化', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-remote-probe-'));
  const remote = path.join(root, 'remote.git');
  const configuration: SyncConfiguration = { repositoryUrl: remote, branch: 'main', gitUserName: '测试用户', gitUserEmail: 'test@example.com' };
  try {
    assert.equal((await runProcess('git', ['init', '--bare', remote])).exitCode, 0);
    const first = new ConfigurationRepositoryGitService(path.join(root, 'first'));
    const second = new ConfigurationRepositoryGitService(path.join(root, 'second'));
    // 还没有本地仓库时无从比较，交给完整的一轮。
    assert.equal(await second.remoteChanged(configuration), true);

    await first.prepare(configuration);
    const hostRoot = path.join(first.repositoryPath, '.profile-git-sync', 'hosts', 'vscode');
    await mkdir(hostRoot, { recursive: true });
    await writeFile(path.join(hostRoot, 'manifest.json'), '{"schemaVersion":1}');
    await first.stageHost('vscode');
    await first.commitAndPush(configuration, 'feat: 初始化');

    await second.prepare(configuration);
    await second.pull(configuration);
    assert.equal(await second.remoteChanged(configuration), false);

    await writeFile(path.join(hostRoot, 'manifest.json'), '{"schemaVersion":2}');
    await first.stageHost('vscode');
    await first.commitAndPush(configuration, 'feat: 更新');
    assert.equal(await second.remoteChanged(configuration), true);
    // 探测是只读的，不会顺手把本地跟踪分支拉到最新。
    assert.equal(await second.remoteChanged(configuration), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('准备仓库时清除上一次 Git 进程残留的索引锁', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-index-lock-'));
  const remote = path.join(root, 'remote.git');
  const configuration: SyncConfiguration = {
    repositoryUrl: remote,
    branch: 'main',
    gitUserName: '测试用户',
    gitUserEmail: 'test@example.com',
  };
  try {
    assert.equal((await runProcess('git', ['init', '--bare', remote])).exitCode, 0);
    const service = new ConfigurationRepositoryGitService(path.join(root, 'first'));
    await service.prepare(configuration);
    const lock = path.join(service.repositoryPath, '.git', 'index.lock');
    await writeFile(lock, '');

    await service.prepare(configuration);
    await assert.rejects(readFile(lock), /ENOENT/);
    // 锁清掉之后写索引的命令才能继续执行。
    const hostRoot = path.join(service.repositoryPath, '.profile-git-sync', 'hosts', 'vscode');
    await mkdir(hostRoot, { recursive: true });
    await writeFile(path.join(hostRoot, 'manifest.json'), '{"schemaVersion":1}');
    assert.equal((await service.stageHost('vscode')).length, 1);
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

test('Git 错误消息脱敏远程仓库地址且空地址不改写原文', () => {
  const url = 'git@github.com:user/settings.git';
  assert.equal(gitTesting.redact(`fatal: ${url} Permission denied`, url), 'fatal: <远程仓库> Permission denied');
  assert.equal(gitTesting.redact('fatal: Permission denied', ''), 'fatal: Permission denied');
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
    assert.equal(
      await readFile(path.join(second.repositoryPath, '.profile-git-sync', 'hosts', 'vscode', 'manifest.json'), 'utf8'),
      '{"schemaVersion":1,"files":{"a":"cloud"}}',
    );

    // 克隆完成后再次拉取即视为同源，从这一轮起才按基准比较两侧。
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

test('云端历史只列出动过本宿主目录的提交', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-history-'));
  const remote = path.join(root, 'remote.git');
  const configuration: SyncConfiguration = {
    repositoryUrl: remote,
    branch: 'main',
    gitUserName: '测试用户',
    gitUserEmail: 'test@example.com',
  };
  try {
    assert.equal((await runProcess('git', ['init', '--bare', remote])).exitCode, 0);
    const service = new ConfigurationRepositoryGitService(path.join(root, 'runtime'));
    await service.prepare(configuration);
    const hostRoot = path.join(service.repositoryPath, '.profile-git-sync', 'hosts', 'vscode');
    await mkdir(hostRoot, { recursive: true });
    await writeFile(path.join(hostRoot, 'manifest.json'), '{"schemaVersion":1}');
    await service.stageHost('vscode');
    await service.commitAndPush(configuration, '第一次 备份：初始配置');

    const otherHostRoot = path.join(service.repositoryPath, '.profile-git-sync', 'hosts', 'cursor');
    await mkdir(otherHostRoot, { recursive: true });
    await writeFile(path.join(otherHostRoot, 'manifest.json'), '{"schemaVersion":1}');
    await service.stageHost('cursor');
    await service.commitAndPush(configuration, 'Cursor 的提交');

    await writeFile(path.join(hostRoot, 'manifest.json'), '{"schemaVersion":2}');
    await service.stageHost('vscode');
    await service.commitAndPush(configuration, '第二次 备份：带空格 与中文标点，末尾');

    const commits = await service.refreshCommits(configuration, 'vscode');
    assert.deepEqual(commits.map((commit) => commit.subject), ['第二次 备份：带空格 与中文标点，末尾', '第一次 备份：初始配置']);
    assert.equal(/^[0-9a-f]{40}$/.test(commits[0]!.hash), true);
    assert.equal(commits[0]!.shortHash, commits[0]!.hash.slice(0, 7));
    assert.equal(Number.isNaN(Date.parse(commits[0]!.committedAt)), false);
    assert.deepEqual(commits[0]!.tags, []);
    assert.equal((await service.refreshCommits(configuration, 'vscode', 1)).length, 1);
    assert.deepEqual(await service.refreshCommits({ ...configuration, branch: 'missing' }, 'vscode'), []);

    // 本地已有 origin 跟踪分支时读缓存不联网，远端改成不可达也不影响列表。
    const offline = await service.listCachedCommits(
      { ...configuration, repositoryUrl: path.join(root, 'missing-remote.git') },
      'vscode',
    );
    assert.deepEqual(offline?.map((commit) => commit.subject), ['第二次 备份：带空格 与中文标点，末尾', '第一次 备份：初始配置']);
    // 没有本地跟踪分支时返回 undefined，界面据此显示加载中而不是「云端没有提交」。
    assert.equal(await service.listCachedCommits({ ...configuration, branch: 'missing' }, 'vscode'), undefined);

    // 「加载更多」用 offset 只取新的一页：跳过已经取过的第一条，正好读到第二条。
    const nextPage = await service.listCachedCommits(configuration, 'vscode', 1, 1);
    assert.deepEqual(nextPage?.map((commit) => commit.subject), ['第一次 备份：初始配置']);
    // offset 超过总数时返回空数组，界面据此隐藏「加载更多」，而不是报错。
    assert.deepEqual(await service.listCachedCommits(configuration, 'vscode', 30, 2), []);

    // 导出历史宿主树只取该提交里的内容，越界路径与其他宿主目录都不参与。
    const exported = path.join(root, 'exported');
    assert.equal(await service.exportHostTree(commits[1]!.hash, 'vscode', exported), true);
    assert.equal(await readFile(path.join(exported, 'manifest.json'), 'utf8'), '{"schemaVersion":1}');
    assert.deepEqual(await readdir(exported), ['manifest.json']);
    await assert.rejects(readdir(`${exported}.checkout`), /ENOENT/);
    // 导出借用的是临时工作区：仓库自己的工作区仍是最新提交的内容，索引里也没有任何暂存改动。
    assert.equal(await readFile(path.join(hostRoot, 'manifest.json'), 'utf8'), '{"schemaVersion":2}');
    assert.equal((await runProcess('git', ['-C', service.repositoryPath, 'status', '--porcelain=v1'])).stdout, '');
    assert.equal((await runProcess('git', ['-C', service.repositoryPath, 'diff', '--cached', '--name-only'])).stdout, '');
    // 提交标识不是完整 hash，或该提交里没有本宿主目录时都不导出。
    assert.equal(await service.exportHostTree('--help', 'vscode', path.join(root, 'rejected')), false);
    assert.equal(await service.exportHostTree(commits[1]!.hash, 'cursor', path.join(root, 'absent')), false);
    await assert.rejects(readdir(path.join(root, 'absent')), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('标签新增后推到远端，删除后本地与远端都消失', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-tag-'));
  const remote = path.join(root, 'remote.git');
  const configuration: SyncConfiguration = {
    repositoryUrl: remote,
    branch: 'main',
    gitUserName: '测试用户',
    gitUserEmail: 'test@example.com',
  };
  try {
    assert.equal((await runProcess('git', ['init', '--bare', remote])).exitCode, 0);
    const service = new ConfigurationRepositoryGitService(path.join(root, 'runtime'));
    await service.prepare(configuration);
    const hostRoot = path.join(service.repositoryPath, '.profile-git-sync', 'hosts', 'vscode');
    await mkdir(hostRoot, { recursive: true });
    await writeFile(path.join(hostRoot, 'manifest.json'), '{"schemaVersion":1}');
    await service.stageHost('vscode');
    await service.commitAndPush(configuration, '第一次 备份：初始配置');

    const commits = await service.refreshCommits(configuration, 'vscode');
    const target = commits[0]!;
    await service.createTag(configuration, 'v1.0-stable', target.hash);
    const listed = await runProcess('git', ['ls-remote', '--tags', remote]);
    assert.equal(listed.stdout.includes('refs/tags/v1.0-stable'), true);

    // 另一台机器的仓库缓存：标签必须能随刷新拉下来，否则打了标签别处看不到。
    const other = new ConfigurationRepositoryGitService(path.join(root, 'runtime-other'));
    assert.deepEqual((await other.refreshCommits(configuration, 'vscode'))[0]!.tags, ['v1.0-stable']);

    await service.deleteTag(configuration, 'v1.0-stable');
    assert.equal((await runProcess('git', ['ls-remote', '--tags', remote])).stdout.includes('refs/tags/'), false);
    assert.deepEqual((await service.refreshCommits(configuration, 'vscode'))[0]!.tags, []);
    // 远端删除后，别处的本地缓存也要在刷新时清掉那份标签。
    assert.deepEqual((await other.refreshCommits(configuration, 'vscode'))[0]!.tags, []);
    // 远端已经没有这个标签时删除不算失败，否则界面上会一直删不掉。
    await service.deleteTag(configuration, 'v1.0-stable');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('非法标签名被拒绝且不产生任何 Git 引用', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-tag-invalid-'));
  const remote = path.join(root, 'remote.git');
  const configuration: SyncConfiguration = {
    repositoryUrl: remote,
    branch: 'main',
    gitUserName: '测试用户',
    gitUserEmail: 'test@example.com',
  };
  try {
    assert.equal((await runProcess('git', ['init', '--bare', remote])).exitCode, 0);
    const service = new ConfigurationRepositoryGitService(path.join(root, 'runtime'));
    await service.prepare(configuration);
    const hostRoot = path.join(service.repositoryPath, '.profile-git-sync', 'hosts', 'vscode');
    await mkdir(hostRoot, { recursive: true });
    await writeFile(path.join(hostRoot, 'manifest.json'), '{"schemaVersion":1}');
    await service.stageHost('vscode');
    await service.commitAndPush(configuration, '第一次 备份：初始配置');
    const hash = (await service.refreshCommits(configuration, 'vscode'))[0]!.hash;

    for (const name of ['-x', 'a..b', 'v 1', '.hidden', 'v1.lock', 'v'.repeat(101), '']) {
      await assert.rejects(service.createTag(configuration, name, hash), /命名规则/);
    }
    await assert.rejects(service.createTag(configuration, 'v1', 'not-a-hash'), /提交标识无效/);
    assert.equal((await runProcess('git', ['tag', '--list'], service.repositoryPath)).stdout, '');
    // 合法名称必须放行，规则不能把正常标签一起拦掉。
    await service.createTag(configuration, 'v1.0_beta-2/rc', hash);
    assert.deepEqual((await service.refreshCommits(configuration, 'vscode'))[0]!.tags, ['v1.0_beta-2/rc']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('远端引用解析忽略 peeled 行，tip 与标签都没变才跳过 fetch', () => {
  const parsed = gitTesting.parseRemoteRefs([
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/main',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/heads/other',
    'cccccccccccccccccccccccccccccccccccccccc\trefs/tags/v1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/v1^{}',
    '',
  ].join('\n'));
  assert.equal(parsed.branchTips.get('main'), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(parsed.branchTips.size, 2);
  assert.deepEqual([...parsed.tags], ['v1']);

  const tip = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  assert.equal(gitTesting.needsFetch(parsed, 'main', tip, new Set(['v1'])), false);
  assert.equal(gitTesting.needsFetch(parsed, 'main', tip, new Set()), true);
  assert.equal(gitTesting.needsFetch(parsed, 'main', tip, new Set(['v2'])), true);
  assert.equal(gitTesting.needsFetch(parsed, 'main', 'd'.repeat(40), new Set(['v1'])), true);
  assert.equal(gitTesting.needsFetch(parsed, 'main', undefined, new Set(['v1'])), true);

  assert.deepEqual(
    gitTesting.parseDecoratedTags('HEAD -> refs/heads/main, tag: refs/tags/v1, refs/remotes/origin/main, tag: refs/tags/v2'),
    ['v1', 'v2'],
  );
  assert.deepEqual(gitTesting.parseDecoratedTags('HEAD -> refs/heads/main'), []);
  assert.deepEqual(gitTesting.parseDecoratedTags(''), []);
});

test('读取历史缓存时本地仓库不存在则返回 undefined，且不创建仓库', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-cache-absent-'));
  try {
    const service = new ConfigurationRepositoryGitService(path.join(root, 'runtime'));
    const configuration: SyncConfiguration = {
      repositoryUrl: path.join(root, 'remote.git'),
      branch: 'main',
      gitUserName: '',
      gitUserEmail: '',
    };
    assert.equal(await service.listCachedCommits(configuration, 'vscode'), undefined);
    // 读缓存可能发生在同步关闭、也可能与同步并发，不能顺手建仓库或改 origin。
    await assert.rejects(readdir(path.join(root, 'runtime')), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
