import * as vscode from 'vscode';
import { ConfigurationStore } from './configuration';
import { isValidTagName } from './configuration-record';
import { MultiWindowCoordinator } from './coordinator';
import { ConfigurationRepositoryGitService, RepositoryCommit } from './git-service';
import { SidebarProvider } from './sidebar';
import { HISTORY_PAGE_SIZE, HistoryEntry } from './sidebar-messages';
import { HostKind } from './types';

/**
 * 历史页面此刻在做什么。整份加载、追加一页、还原与标签操作都要抢同一把独占锁，
 * 交叉执行会互相失败，刷新回来的整份列表还会覆盖刚追加的那一页，因此任何时候只允许一种在进行。
 */
type HistoryActivity = 'idle' | 'loading' | 'loading-more' | 'operating';

export interface HistoryControllerOptions {
  coordinator: MultiWindowCoordinator;
  repository: ConfigurationRepositoryGitService;
  configurationStore: ConfigurationStore;
  sidebar: SidebarProvider;
  hostKind: HostKind;
  isEnabled: () => boolean;
  /** 历史页面之外的提示（例如尚未配置仓库）显示在主页面的状态区。 */
  reportStatus: (message: string) => void;
  /** 还原会写回本机并改变同步状态，执行与结果处理留在装配层。 */
  restore: (target: RepositoryCommit) => Promise<void>;
}

/** 云端提交历史页面：列表的加载与分页、标签增删、发起还原。Webview 只回传标识，提交实体与分页状态都留在这里。 */
export class HistoryController {
  private commits: RepositoryCommit[] = [];
  private limit = HISTORY_PAGE_SIZE;
  private activity: HistoryActivity = 'idle';

  public constructor(private readonly options: HistoryControllerOptions) {}

  public async open(): Promise<void> {
    const configuration = this.options.configurationStore.get();
    if (!configuration.repositoryUrl) {
      this.options.reportStatus('请填写 Git 仓库地址。');
      return;
    }
    // 同步关闭时不再拒绝：用户主动查看历史就是要访问仓库。但没有本地缓存意味着要先建仓库，应由用户先开启同步。
    if (
      !this.options.isEnabled()
      && (await this.options.repository.listCachedCommits(configuration, this.options.hostKind, 1)) === undefined
    ) {
      void vscode.window.showInformationMessage('本机还没有云端记录的缓存，请先开启同步后再查看历史。');
      return;
    }
    // 页面打开后由侧边栏发起首次加载：面板从未打开过时视图还要先解析，加载时机只能由那边决定。
    await this.options.sidebar.openHistoryPage();
  }

  /** 整份加载：用于初次打开与刷新，起点固定是 offset 0。 */
  public async load(limit: number, refresh: boolean): Promise<void> {
    // 上一轮整份加载还没结束（刷新要走一次网络往返），列表稍后就到，重复进入只会互相抢锁失败。
    if (this.activity === 'loading') return;
    if (this.activity !== 'idle') {
      await this.options.sidebar.postHistoryError('上一个操作尚未完成，请稍后刷新。');
      return;
    }
    this.activity = 'loading';
    try {
      await this.reload(limit, refresh);
    } finally {
      this.activity = 'idle';
    }
  }

  /**
   * 「加载更多」：只按当前已加载的条数作为 offset 向本地仓库要新的一页，不联网、也不重新遍历前面已经取过的提交。
   * offset 以这边的条数为准，不信任 Webview 传来的数字。
   */
  public async loadMore(): Promise<void> {
    const { sidebar, repository, configurationStore, hostKind } = this.options;
    // Webview 一点下按钮就把它禁用了，这里放弃这次追加时必须回一条状态，否则按钮再也恢复不了。
    if (this.activity !== 'idle') {
      await sidebar.postHistoryBusy(this.activity === 'operating');
      return;
    }
    this.activity = 'loading-more';
    try {
      // 只读本地缓存，不占独占锁：同步进行中也能继续翻页。
      const added = await repository.listCachedCommits(configurationStore.get(), hostKind, HISTORY_PAGE_SIZE, this.commits.length) ?? [];
      this.commits = this.commits.concat(added);
      this.limit = this.commits.length;
      await sidebar.postHistoryList(
        added.map(toHistoryEntry),
        { refreshing: false, hasMore: added.length >= HISTORY_PAGE_SIZE, append: true },
      );
    } catch (error) {
      await sidebar.postHistoryError(error instanceof Error ? error.message : String(error));
    } finally {
      this.activity = 'idle';
    }
  }

  public async restore(hash: string): Promise<void> {
    if (this.activity === 'operating') return;
    const { sidebar, configurationStore } = this.options;
    const target = this.commits.find((commit) => commit.hash === hash);
    if (!target) {
      await sidebar.postHistoryError('该提交已不在当前列表中，请刷新后重试。');
      return;
    }
    const backupOnly = configurationStore.get().mode === 'backup';
    const confirmed = await vscode.window.showWarningMessage(
      `是否还原到 ${target.shortHash}？`,
      {
        modal: true,
        detail: [
          '将以该提交的配置覆盖本机，本机原配置会先备份到扩展运行目录；该提交清单里没有的扩展会在本机卸载。',
          '随后在远端追加一条新的还原提交，远端已有历史不会被改写。',
          ...(backupOnly ? ['当前是备份模式，平时不会写回本机，但还原会直接覆盖本机配置与扩展。'] : []),
          ...(this.options.isEnabled() ? [] : ['当前同步已关闭，还原仍会覆盖本机配置并推送新提交。']),
        ].join('\n'),
      },
      '还原',
    );
    if (confirmed !== '还原') return;

    if (!(await this.beginOperation())) return;
    try {
      // 还原的进度与结果显示在主页面的状态区，先切回去用户才看得到。
      await sidebar.closeHistoryPage();
      await this.options.restore(target);
    } finally {
      await this.endOperation();
    }
  }

  public async createTag(hash: string): Promise<void> {
    if (this.activity === 'operating') return;
    const { sidebar, repository, configurationStore } = this.options;
    const target = this.commits.find((commit) => commit.hash === hash);
    if (!target) {
      await sidebar.postHistoryError('该提交已不在当前列表中，请刷新后重试。');
      return;
    }
    const existing = new Set(this.commits.flatMap((commit) => commit.tags));
    const input = await vscode.window.showInputBox({
      title: `为 ${target.shortHash} 新增标签`,
      prompt: '标签会推送到远端仓库，其他机器刷新历史后也能看到。',
      validateInput: (value) => {
        const name = value.trim();
        if (!name) return '请输入标签名称。';
        if (!isValidTagName(name)) return '标签名称只能包含字母、数字与 . _ / -，且不能以 - 或 . 开头。';
        if (existing.has(name)) return '该标签已存在。';
        return undefined;
      },
    });
    const name = input?.trim();
    if (!name) return;
    await this.runTagOperation(
      async () => repository.createTag(configurationStore.get(), name, target.hash),
      '另一窗口正在执行同步，请稍后重试新增标签。',
    );
  }

  public async deleteTag(tag: string): Promise<void> {
    if (this.activity === 'operating') return;
    const { repository, configurationStore } = this.options;
    const confirmed = await vscode.window.showWarningMessage(
      `是否删除标签 ${tag}？`,
      {
        modal: true,
        detail: '会同时删除远端仓库中的该标签，其他机器刷新历史后也会消失。提交本身与配置内容不受影响。',
      },
      '删除',
    );
    if (confirmed !== '删除') return;
    await this.runTagOperation(
      async () => repository.deleteTag(configurationStore.get(), tag),
      '另一窗口正在执行同步，请稍后重试删除标签。',
    );
  }

  /** 先出本地缓存再后台刷新：本地已有跟踪分支时用户不必等一次完整网络往返。调用方负责占住 activity。 */
  private async reload(limit: number, refresh: boolean): Promise<void> {
    const { sidebar, coordinator, repository, configurationStore, hostKind } = this.options;
    const configuration = configurationStore.get();
    if (!configuration.repositoryUrl) {
      await sidebar.postHistoryError('请填写 Git 仓库地址。');
      return;
    }
    try {
      // 缓存只读本地引用、不占独占锁：别的窗口正在同步时也能先看到列表，只有联网刷新才需要排队。
      const cached = await repository.listCachedCommits(configuration, hostKind, limit);
      // 没有本地缓存时不推列表，页面停在加载中，避免先闪一次「云端还没有提交」。
      if (cached) await this.publish(cached, limit, refresh);
      if (!refresh) {
        if (!cached) await sidebar.postHistoryError('本地还没有云端记录的缓存，请点刷新重新获取。');
        return;
      }

      // 进来时列表可能已经被「加载更多」追加过若干页，按已加载的条数刷新，避免整份替换把这些页截掉。
      const refreshLimit = Math.max(limit, this.commits.length);
      let refreshed: RepositoryCommit[] = [];
      const refreshedLock = await coordinator.runExclusive(async () => {
        refreshed = await repository.refreshCommits(configuration, hostKind, refreshLimit);
      });
      if (!refreshedLock) {
        await sidebar.postHistoryError('另一窗口正在执行同步，云端记录暂未刷新。');
        return;
      }
      await this.publish(refreshed, refreshLimit, false);
    } catch (error) {
      // 查看历史失败不影响同步本身，不升级为同步失败状态。
      await sidebar.postHistoryError(error instanceof Error ? error.message : String(error));
    }
  }

  /** 整份替换列表。 */
  private async publish(commits: RepositoryCommit[], limit: number, refreshing: boolean): Promise<void> {
    this.commits = commits;
    this.limit = limit;
    await this.options.sidebar.postHistoryList(
      commits.map(toHistoryEntry),
      // 取满了才可能还有更早的提交；不设固定封顶，一直点「加载更多」直到某次取到的条数不足 limit 为止。
      { refreshing, hasMore: commits.length >= limit, append: false },
    );
  }

  /** 标签操作共用：占住独占锁执行，成功后只读本地重渲染列表，不再联网。 */
  private async runTagOperation(operation: () => Promise<void>, lockBusyMessage: string): Promise<void> {
    const { sidebar, coordinator } = this.options;
    if (!(await this.beginOperation())) return;
    try {
      const acquired = await coordinator.runExclusive(operation);
      if (!acquired) {
        await sidebar.postHistoryError(lockBusyMessage);
        return;
      }
      await this.reload(this.limit, false);
    } catch (error) {
      await sidebar.postHistoryError(error instanceof Error ? error.message : String(error));
    } finally {
      await this.endOperation();
    }
  }

  /** 弹窗等待期间列表可能开始了加载或别的操作，它们要抢同一把锁，此时再开始只会互相失败。 */
  private async beginOperation(): Promise<boolean> {
    if (this.activity !== 'idle') {
      await this.options.sidebar.postHistoryError('上一个操作尚未完成，请稍后重试。');
      return false;
    }
    this.activity = 'operating';
    // 还原与标签操作期间禁用页面按钮，避免同一条提交被连点两次。
    await this.options.sidebar.postHistoryBusy(true);
    return true;
  }

  private async endOperation(): Promise<void> {
    this.activity = 'idle';
    await this.options.sidebar.postHistoryBusy(false);
  }
}

function toHistoryEntry(commit: RepositoryCommit): HistoryEntry {
  return {
    hash: commit.hash,
    shortHash: commit.shortHash,
    subject: commit.subject || '（无提交说明）',
    committedAt: commit.committedAt,
    tags: commit.tags,
  };
}
