import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runProcess } from './process';
import { SyncConfiguration } from './types';

/** cloned：本地没有历史，已直接检出远端；unrelated：与远端没有共同祖先；synced：与远端同源。 */
export type PullState = 'cloned' | 'unrelated' | 'synced';

export interface PullResult {
  state: PullState;
  /** 丢弃了上次推送失败留下的本地提交，本轮改由本机快照重新生成。 */
  recoveredFromDivergence: boolean;
}

export class ConfigurationRepositoryGitService {
  public readonly repositoryPath: string;
  /** 供通用失败路径脱敏用：Git 常在 stderr 中回显完整远程地址。由 prepare 赋值，之前的调用不脱敏。 */
  private remoteUrl = '';

  public constructor(runtimePath: string) {
    this.repositoryPath = path.join(runtimePath, 'repository');
  }

  public async prepare(configuration: SyncConfiguration): Promise<void> {
    this.remoteUrl = configuration.repositoryUrl;
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
    // 仓库只是本机缓存，检出与提交都必须是原样字节；换行符转换会让同一份配置在两台机器上算出不同哈希。
    await this.git(['config', 'core.autocrlf', 'false']);

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

  public async pull(configuration: SyncConfiguration): Promise<PullResult> {
    const before = await this.head();
    const remote = await this.git(['ls-remote', '--exit-code', '--heads', 'origin', configuration.branch], true);
    if (remote.exitCode === 2) return { state: 'synced', recoveredFromDivergence: false };
    if (remote.exitCode !== 0) throw new Error(formatRemoteError(remote.stderr, configuration.repositoryUrl));
    await this.git(['fetch', '--prune', 'origin', configuration.branch]);
    if (!before) {
      await this.git(['switch', '-C', configuration.branch, `origin/${configuration.branch}`]);
      return { state: 'cloned', recoveredFromDivergence: false };
    }
    const base = await this.git(['merge-base', 'HEAD', `origin/${configuration.branch}`], true);
    // 没有共同祖先说明本地仓库和远端不是同一份历史，此时对齐远端会悄悄丢掉本地这份，只能中止并交给用户重建。
    if (base.exitCode !== 0 || !base.stdout) return { state: 'unrelated', recoveredFromDivergence: false };

    // 本地仓库只是缓存，配置的真身在本机磁盘和远端。直接对齐远端可以保证历史永远是一条线、不会分叉；
    // 上次推送失败留下的提交在本轮由「本机相对基准已变」重新生成，不会因此丢失改动。
    const ahead = await this.git(['rev-list', '--count', `origin/${configuration.branch}..HEAD`], true);
    const discarded = Number(ahead.stdout) > 0;
    if (discarded) await this.git(['reset', '--hard', `origin/${configuration.branch}`]);
    else await this.git(['merge', '--ff-only', `origin/${configuration.branch}`], true);
    return { state: 'synced', recoveredFromDivergence: discarded };
  }

  /** 本地仓库只是缓存，真实配置在本机磁盘和远端仓库中，删除后会按首次接入重新克隆。 */
  public async removeRepository(): Promise<void> {
    await fs.rm(this.repositoryPath, { recursive: true, force: true });
  }

  /** 只去掉本机配置同步目录的 .git，不推远端、不改工作区文件。 */
  public async removeGitDirectory(): Promise<void> {
    await fs.rm(path.join(this.repositoryPath, '.git'), { recursive: true, force: true });
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
    if (!allowFailure && result.exitCode !== 0) {
      throw new Error(`配置同步仓库 Git 操作失败：${redact(result.stderr || result.stdout, this.remoteUrl)}`);
    }
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
  // 地址为空时 replaceAll 会在每个字符之间插入替换文本，必须先判空。
  return repositoryUrl ? message.replaceAll(repositoryUrl, '<远程仓库>') : message;
}

function formatRemoteError(message: string, repositoryUrl: string): string {
  const detail = redact(message, repositoryUrl);
  if (/password|authentication|publickey|credential|interactiv/i.test(detail)) {
    return `Git 认证失败。插件已调用本机 SSH/Git Credential Manager，请先在终端完成一次该仓库的认证。详细信息：${detail}`;
  }
  return `无法访问远程仓库：${detail}`;
}

export const testing = { redact };
