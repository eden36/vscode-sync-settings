import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runProcess } from './process';
import { SyncConfiguration } from './types';

export class ConfigurationRepositoryGitService {
  public readonly repositoryPath: string;

  public constructor(runtimePath: string) {
    this.repositoryPath = path.join(runtimePath, 'repository');
  }

  public async prepare(configuration: SyncConfiguration): Promise<void> {
    await fs.mkdir(this.repositoryPath, { recursive: true });
    if (!(await exists(path.join(this.repositoryPath, '.git')))) {
      await this.git(['init']);
    }
    const remotes = await this.git(['remote'], true);
    if (remotes.stdout.split(/\r?\n/).includes('origin')) {
      await this.git(['remote', 'set-url', 'origin', configuration.repositoryUrl]);
    } else {
      await this.git(['remote', 'add', 'origin', configuration.repositoryUrl]);
    }
    if (configuration.gitUserName.trim()) await this.git(['config', 'user.name', configuration.gitUserName.trim()]);
    else await this.git(['config', '--unset', 'user.name'], true);
    if (configuration.gitUserEmail.trim()) await this.git(['config', 'user.email', configuration.gitUserEmail.trim()]);
    else await this.git(['config', '--unset', 'user.email'], true);
    await this.git(['config', 'core.hooksPath', process.platform === 'win32' ? 'NUL' : '/dev/null']);

    // 插件进程被强制关闭时，Git 可能残留未完成的操作；内部仓库可安全中止后重建快照。
    await this.git(['rebase', '--abort'], true);
    await this.git(['merge', '--abort'], true);
    await this.git(['cherry-pick', '--abort'], true);

    const branch = await this.git(['branch', '--show-current'], true);
    if (branch.stdout !== configuration.branch) {
      const localExists = await this.git(['show-ref', '--verify', `refs/heads/${configuration.branch}`], true);
      await this.git(localExists.exitCode === 0 ? ['switch', configuration.branch] : ['switch', '-c', configuration.branch]);
    }
  }

  public async pull(configuration: SyncConfiguration): Promise<{ before?: string; after?: string }> {
    const before = await this.head();
    const remote = await this.git(['ls-remote', '--exit-code', '--heads', 'origin', configuration.branch], true);
    if (remote.exitCode === 2) return { before, after: before };
    if (remote.exitCode !== 0) throw new Error(formatRemoteError(remote.stderr, configuration.repositoryUrl));
    await this.git(['fetch', '--prune', 'origin', configuration.branch]);
    if (!before) {
      await this.git(['switch', '-C', configuration.branch, `origin/${configuration.branch}`]);
    } else {
      const pull = await this.git(['rebase', `origin/${configuration.branch}`], true);
      if (pull.exitCode !== 0) {
        await this.git(['rebase', '--abort'], true);
        throw new Error(`远程更新无法快进合并：${pull.stderr}`);
      }
    }
    return { before, after: await this.head() };
  }

  public async discardPendingHostChanges(host: string): Promise<boolean> {
    const prefix = `.profile-git-sync/hosts/${host}`;
    const status = await this.git(['status', '--porcelain=v1', '--untracked-files=all', '--', prefix], true);
    if (!status.stdout) return false;

    const hostPath = path.join(this.repositoryPath, '.profile-git-sync', 'hosts', host);
    const head = await this.head();
    if (head) {
      await this.git(['restore', '--source=HEAD', '--staged', '--', prefix], true);
      await fs.rm(hostPath, { recursive: true, force: true });
      await this.git(['restore', '--source=HEAD', '--worktree', '--', prefix], true);
    } else {
      await this.git(['rm', '--cached', '-r', '--ignore-unmatch', '--', prefix], true);
      await fs.rm(hostPath, { recursive: true, force: true });
    }
    return true;
  }

  public async stageHost(host: string): Promise<string[]> {
    const prefix = `.profile-git-sync/hosts/${host}`;
    await this.git(['add', '-A', '--', prefix]);
    const result = await this.git(['diff', '--cached', '--name-only', '--', prefix], true);
    return result.stdout ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
  }

  public async commitAndPush(configuration: SyncConfiguration, message: string): Promise<void> {
    await this.git(['commit', '-m', message, '--no-verify']);
    await this.push(configuration);
  }

  public async pushIfAhead(configuration: SyncConfiguration): Promise<void> {
    const head = await this.head();
    if (!head) return;
    const remote = await this.git(['rev-parse', '--verify', `origin/${configuration.branch}`], true);
    if (remote.exitCode !== 0) {
      await this.push(configuration);
      return;
    }
    const ahead = await this.git(['rev-list', '--count', `origin/${configuration.branch}..HEAD`], true);
    if (Number(ahead.stdout) > 0) await this.push(configuration);
  }

  public async head(): Promise<string | undefined> {
    const result = await this.git(['rev-parse', 'HEAD'], true);
    return result.exitCode === 0 ? result.stdout : undefined;
  }

  private async git(args: string[], allowFailure = false, timeoutMs = 60_000) {
    const result = await runProcess('git', args, this.repositoryPath, timeoutMs);
    if (!allowFailure && result.exitCode !== 0) throw new Error(`配置同步仓库 Git 操作失败：${result.stderr || result.stdout}`);
    return result;
  }

  private async push(configuration: SyncConfiguration): Promise<void> {
    const push = await this.git(['push', '--set-upstream', 'origin', configuration.branch], true, 120_000);
    if (push.exitCode !== 0) throw new Error(`推送失败，稍后将重新拉取并重试：${redact(push.stderr, configuration.repositoryUrl)}`);
  }
}

async function exists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false);
}

function redact(message: string, repositoryUrl: string): string {
  return message.replaceAll(repositoryUrl, '<远程仓库>');
}

function formatRemoteError(message: string, repositoryUrl: string): string {
  const detail = redact(message, repositoryUrl);
  if (/password|authentication|publickey|credential|interactiv/i.test(detail)) {
    return `Git 认证失败。插件已调用本机 SSH/Git Credential Manager，请先在终端完成一次该仓库的认证。详细信息：${detail}`;
  }
  return `无法访问远程仓库：${detail}`;
}
