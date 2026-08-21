import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isValidTagName } from './configuration-record';
import { runProcess, runProcessBinary } from './process';
import { HostKind, SyncConfiguration } from './types';

/** cloned：本地没有历史，已直接检出远端；unrelated：与远端没有共同祖先；synced：与远端同源。 */
export type PullState = 'cloned' | 'unrelated' | 'synced';

/** 提交说明可能包含空格与换行，字段之间用不会出现在文本里的分隔符，避免解析歧义。 */
const COMMIT_FIELD_SEPARATOR = '\x1f';
export const MAX_COMMIT_LIST = 100;

/** 云端历史中的一条提交，只用于展示和选择还原目标。 */
export interface RepositoryCommit {
  hash: string;
  shortHash: string;
  committedAt: string;
  subject: string;
  tags: string[];
}

/** 一次 ls-remote 同时得到的远端分支 tip 与标签集合。 */
interface RemoteRefs {
  branchTips: Map<string, string>;
  tags: Set<string>;
}

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
    await this.ensureOrigin(configuration);
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

  /**
   * 只读本地 origin 跟踪分支上的历史，不发起任何网络调用。
   * 本地还没有该跟踪分支时返回 undefined，与「有分支但没有本宿主提交」的空数组区分开：
   * 前者要让界面显示加载中，后者要显示「云端还没有提交」。
   */
  public async listCachedCommits(
    configuration: SyncConfiguration,
    host: HostKind,
    limit = 30,
  ): Promise<RepositoryCommit[] | undefined> {
    await this.ensureOrigin(configuration);
    const localTip = await this.git(['rev-parse', '--verify', `origin/${configuration.branch}`], true);
    if (localTip.exitCode !== 0) return undefined;
    return this.readCommits(configuration, host, limit);
  }

  /**
   * 刷新并列出远端分支上动过本宿主目录的提交，最新的在前。
   * 只看本宿主目录：另一台宿主的提交里没有本机可还原的内容，列出来只会误导。
   * 一次 ls-remote 同时取回分支 tip 与全部标签，两者都与本地一致时跳过 fetch，省掉一次完整传输。
   */
  public async refreshCommits(
    configuration: SyncConfiguration,
    host: HostKind,
    limit = 30,
  ): Promise<RepositoryCommit[]> {
    await this.ensureOrigin(configuration);
    const listed = await this.git(['ls-remote', '--heads', '--tags', 'origin'], true);
    // 认证失败与「分支不存在」必须区分开，否则用户会以为云端没有历史。
    if (listed.exitCode !== 0) throw new Error(formatRemoteError(listed.stderr, configuration.repositoryUrl));
    const remote = parseRemoteRefs(listed.stdout);
    if (!remote.branchTips.has(configuration.branch)) return [];

    const localTip = await this.git(['rev-parse', '--verify', `origin/${configuration.branch}`], true);
    const localTags = await this.git(['tag', '--list'], true);
    const needed = needsFetch(
      remote,
      configuration.branch,
      localTip.exitCode === 0 ? localTip.stdout : undefined,
      new Set(localTags.stdout.split(/\r?\n/).filter(Boolean)),
    );
    // 显式给出标签 refspec 才能让远端删掉的标签在本机同步消失：给了分支 refspec 后 --prune-tags 不再生效。
    // 本地不会有未推送的标签，createTag 推送失败会回滚，因此按远端整份对齐是安全的。
    if (needed) await this.git(['fetch', '--prune', 'origin', configuration.branch, '+refs/tags/*:refs/tags/*']);
    return this.readCommits(configuration, host, limit);
  }

  /** 给指定提交打标签并推到远端。标签是共享的，只存在本机没有意义。 */
  public async createTag(configuration: SyncConfiguration, name: string, hash: string): Promise<void> {
    // 名称与提交来自 Webview，越过信任边界后必须重新校验，不能只依赖发送方。
    if (!isValidTagName(name)) throw new Error('标签名称不符合 Git 的命名规则。');
    if (!/^[0-9a-f]{40}$/.test(hash)) throw new Error('提交标识无效，无法新增标签。');
    await this.ensureOrigin(configuration);
    const created = await this.git(['tag', name, hash], true);
    if (created.exitCode !== 0) {
      throw new Error(`新增标签失败：${redact(created.stderr || created.stdout, configuration.repositoryUrl)}`);
    }
    const pushed = await this.git(['push', 'origin', `refs/tags/${name}`], true, 120_000);
    if (pushed.exitCode !== 0) {
      // 推送失败必须回滚本地标签，否则它会在下次 --prune-tags 时被静默删掉，用户却以为已经打上。
      await this.git(['tag', '--delete', name], true);
      throw new Error(`标签推送失败：${redact(pushed.stderr, configuration.repositoryUrl)}`);
    }
  }

  /** 删除远端与本地的标签。删除引用不是 force push，也不改写任何提交历史。 */
  public async deleteTag(configuration: SyncConfiguration, name: string): Promise<void> {
    if (!isValidTagName(name)) throw new Error('标签名称不符合 Git 的命名规则。');
    await this.ensureOrigin(configuration);
    // 远端已经没有这个标签时不算失败：本地那份仍要删掉，否则界面上一直显示。
    const pushed = await this.git(['push', 'origin', '--delete', `refs/tags/${name}`], true, 120_000);
    if (pushed.exitCode !== 0 && !/remote ref does not exist|unable to delete/i.test(pushed.stderr)) {
      throw new Error(`删除远端标签失败：${redact(pushed.stderr, configuration.repositoryUrl)}`);
    }
    await this.git(['tag', '--delete', name], true);
  }

  /** 本地仓库只是缓存，真实配置在本机磁盘和远端仓库中，删除后会按首次接入重新克隆。 */
  public async removeRepository(): Promise<void> {
    await fs.rm(this.repositoryPath, { recursive: true, force: true });
  }

  /** 只去掉本机配置同步目录的 .git，不推远端、不改工作区文件。 */
  public async removeGitDirectory(): Promise<void> {
    await fs.rm(path.join(this.repositoryPath, '.git'), { recursive: true, force: true });
  }

  /** 把指定提交里的宿主目录导出到独立目录，用于还原历史配置。 */
  public async exportHostTree(commit: string, host: string, targetRoot: string): Promise<boolean> {
    const prefix = `.profile-git-sync/hosts/${host}`;
    const listed = await this.git(['ls-tree', '-r', '-z', '--name-only', commit, '--', prefix], true);
    if (listed.exitCode !== 0) return false;
    const files = listed.stdout.split('\0').filter(Boolean);
    if (!files.length) return false;
    const resolvedRoot = path.resolve(targetRoot);
    await fs.mkdir(resolvedRoot, { recursive: true });
    for (const file of files) {
      const relative = file.slice(prefix.length + 1);
      const target = path.resolve(resolvedRoot, ...relative.split('/'));
      if (!relative || !target.startsWith(`${resolvedRoot}${path.sep}`)) return false;
      const blob = await runProcessBinary('git', ['show', `${commit}:${file}`], this.repositoryPath);
      if (blob.exitCode !== 0) return false;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, blob.stdout);
    }
    return true;
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

  /** 从本地 origin 跟踪分支读取历史，%D 带出指向各提交的标签。 */
  private async readCommits(configuration: SyncConfiguration, host: HostKind, limit: number): Promise<RepositoryCommit[]> {
    const count = Math.min(Math.max(Math.trunc(limit), 1), MAX_COMMIT_LIST);
    const log = await this.git([
      'log',
      `--max-count=${count}`,
      '--no-color',
      '--decorate=full',
      '-z',
      `--format=%H${COMMIT_FIELD_SEPARATOR}%cI${COMMIT_FIELD_SEPARATOR}%D${COMMIT_FIELD_SEPARATOR}%s`,
      `origin/${configuration.branch}`,
      '--',
      `.profile-git-sync/hosts/${host}`,
    ], true);
    if (log.exitCode !== 0) return [];

    const commits: RepositoryCommit[] = [];
    for (const record of log.stdout.split('\0')) {
      const fields = record.split(COMMIT_FIELD_SEPARATOR);
      const [hash, committedAt, decoration, subject] = fields;
      // 输出格式不符只跳过该条，不影响其余历史的展示。
      if (fields.length !== 4 || !hash || !committedAt) continue;
      if (!/^[0-9a-f]{40}$/.test(hash) || Number.isNaN(Date.parse(committedAt))) continue;
      commits.push({
        hash,
        shortHash: hash.slice(0, 7),
        committedAt,
        subject: subject ?? '',
        tags: parseDecoratedTags(decoration ?? ''),
      });
    }
    return commits;
  }

  /** 列出历史与同步都只需保证本地仓库存在且 origin 指向当前地址，不必每次走完整 prepare。 */
  private async ensureOrigin(configuration: SyncConfiguration): Promise<void> {
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

/** ls-remote 的每行是「<hash>\t<ref>」；带 ^{} 的是 annotated 标签的 peeled 行，与标签本身重复。 */
function parseRemoteRefs(stdout: string): RemoteRefs {
  const branchTips = new Map<string, string>();
  const tags = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const [hash, reference] = line.split('\t');
    if (!hash || !reference || reference.endsWith('^{}')) continue;
    if (reference.startsWith('refs/heads/')) branchTips.set(reference.slice('refs/heads/'.length), hash);
    else if (reference.startsWith('refs/tags/')) tags.add(reference.slice('refs/tags/'.length));
  }
  return { branchTips, tags };
}

/** 分支 tip 与标签集合任一与本地不同就必须 fetch；都相同则本地缓存已经是远端的样子。 */
function needsFetch(remote: RemoteRefs, branch: string, localTip: string | undefined, localTags: Set<string>): boolean {
  if (remote.branchTips.get(branch) !== localTip) return true;
  if (remote.tags.size !== localTags.size) return true;
  return [...remote.tags].some((tag) => !localTags.has(tag));
}

/** --decorate=full 下 %D 形如「HEAD -> refs/heads/main, tag: refs/tags/v1」，标签那项带 tag: 前缀。 */
function parseDecoratedTags(decoration: string): string[] {
  const tags: string[] = [];
  for (const entry of decoration.split(',')) {
    const reference = entry.trim().replace(/^tag:\s*/, '');
    if (reference.startsWith('refs/tags/')) tags.push(reference.slice('refs/tags/'.length));
  }
  return tags;
}

function formatRemoteError(message: string, repositoryUrl: string): string {
  const detail = redact(message, repositoryUrl);
  if (/password|authentication|publickey|credential|interactiv/i.test(detail)) {
    return `Git 认证失败。插件已调用本机 SSH/Git Credential Manager，请先在终端完成一次该仓库的认证。详细信息：${detail}`;
  }
  return `无法访问远程仓库：${detail}`;
}

export const testing = { redact, parseRemoteRefs, needsFetch, parseDecoratedTags };
