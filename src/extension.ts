import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AiService } from './ai';
import { ConfigurationStore } from './configuration';
import { MultiWindowCoordinator, WindowSafetySnapshot } from './coordinator';
import { ConfigurationRepositoryGitService, RepositoryCommit } from './git-service';
import { detectHost } from './host';
import { ProfileAdapter } from './profile-adapter';
import { RuntimeStateStore } from './runtime-state';
import {
  createMachine,
  reduce,
  SchedulerCommand,
  SchedulerEvent,
  SchedulerMachine,
} from './scheduler';
import { SidebarProvider } from './sidebar';
import { displayIcon, displayPhase, formatRelativeSyncTime, stageLabel } from './sidebar-status';
import { SyncEngine } from './sync-engine';
import { RuntimeStatus, SyncOutcome } from './types';

let coordinator: MultiWindowCoordinator | undefined;
let localTimer: NodeJS.Timeout | undefined;
let remoteTimer: NodeJS.Timeout | undefined;
let startupTimer: NodeJS.Timeout | undefined;
let retryTimer: NodeJS.Timeout | undefined;
let configurationTimer: NodeJS.Timeout | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const environment = detectHost(context);
  await fs.mkdir(environment.runtimePath, { recursive: true });
  const configurationStore = new ConfigurationStore(context, environment.runtimePath);
  await configurationStore.initialize();
  const runtimeState = new RuntimeStateStore(environment.runtimePath);
  await runtimeState.initialize({
    enabled: vscode.workspace.getConfiguration('profileGitSync').get<boolean>('enabled', false),
  });
  const adapter = new ProfileAdapter(environment);
  const profiles = await adapter.listProfiles();

  const persisted = runtimeState.get();
  // 共享文件是权威来源，启动时把它镜像回宿主设置，避免多个 Profile 显示的开关不一致。
  const enabledSetting = vscode.workspace.getConfiguration('profileGitSync');
  if (enabledSetting.get<boolean>('enabled') !== persisted.enabled) {
    await enabledSetting.update('enabled', persisted.enabled, vscode.ConfigurationTarget.Global);
  }
  let machine = createMachine({
    enabled: persisted.enabled,
    configured: Boolean(configurationStore.get().repositoryUrl),
    link: persisted.link,
  });
  const status: RuntimeStatus = {
    sync: machine.sync,
    link: machine.link,
    role: 'stopped',
    activeWindows: 1,
    profiles: profiles.map((profile) => profile.name),
    pendingChanges: 0,
    ...(persisted.lastSyncAt ? { lastSyncAt: persisted.lastSyncAt } : {}),
  };

  coordinator = new MultiWindowCoordinator(path.join(environment.runtimePath, 'coordination'));
  const configurationRepository = new ConfigurationRepositoryGitService(environment.runtimePath);
  const ai = new AiService();
  let localFingerprint: string | undefined;
  let sidebar: SidebarProvider;
  let localCheckRunning = false;
  let scheduleGeneration = 0;
  let schedulesReady = false;
  let dirtyDocumentCount = countDirtyDocuments(environment.userDataPath);
  let lastRepositoryUrl = configurationStore.get().repositoryUrl;
  let lastBranch = configurationStore.get().branch;

  // 同步全过程不弹通知，状态只落在状态栏和侧边栏，避免打断用户。
  const statusBar = vscode.window.createStatusBarItem('profileGitSync.status', vscode.StatusBarAlignment.Right, 100);
  statusBar.name = 'My Setting Sync';
  statusBar.command = 'profileGitSync.openSettings';
  const renderStatusBar = () => {
    const phase = displayPhase(status.sync, status.link);
    const detail = statusDetail(status);
    statusBar.text = `${displayIcon(status.sync, status.link)} 配置同步`;
    statusBar.tooltip = detail ? `配置同步：${phase}\n${detail}` : `配置同步：${phase}`;
    statusBar.backgroundColor = status.sync.kind === 'failed'
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
    statusBar.show();
  };

  const applyStatus = (patch: Partial<RuntimeStatus>, publish: boolean) => {
    Object.assign(status, patch);
    // 用 in 判断而不是取值判断，删除仓库时要能把 lastSyncAt 显式清成 undefined。
    if ('lastSyncAt' in patch) {
      void runtimeState.update({ lastSyncAt: patch.lastSyncAt }).catch(reportRuntimeStateError);
    }
    renderStatusBar();
    void sidebar?.pushState();
    if (publish && coordinator?.isLeader) {
      void coordinator.publishStatus(status).catch((error: unknown) => {
        applyStatus({ message: coordinationErrorMessage(error) }, false);
      });
    }
  };

  const reportRuntimeStateError = (error: unknown) => {
    applyStatus({ message: `同步状态保存失败：${error instanceof Error ? error.message : String(error)}` }, false);
  };

  /** 调度状态是唯一的真相来源，写入 status 后再渲染与广播。 */
  const dispatch = (event: SchedulerEvent) => {
    const previous = machine;
    const { next, commands } = reduce(machine, event);
    machine = next;
    if (previous.sync !== next.sync || previous.link !== next.link) {
      applyStatus({ sync: next.sync, link: next.link }, coordinator?.isLeader === true);
      if (previous.link !== next.link) void runtimeState.update({ link: next.link }).catch(reportRuntimeStateError);
    }
    for (const command of commands) void execute(command);
  };

  const engine = new SyncEngine(
    environment,
    adapter,
    configurationRepository,
    ai,
    configurationStore,
    runtimeState,
    (patch) => {
      // 流程只报告进度与说明；阶段之外的状态一律由调度层决定。
      if (patch.sync?.kind === 'running') dispatch({ type: 'sync-progress', stage: patch.sync.stage });
      const { sync: _sync, link: _link, ...rest } = patch;
      if (Object.keys(rest).length) applyStatus(rest, coordinator?.isLeader === true);
    },
    () => coordinator!.windowSafety(),
  );

  const runSync = async (adoptCloud: boolean) => {
    let outcome: SyncOutcome | undefined;
    const acquired = await coordinator!.runExclusive(async () => {
      outcome = await engine.synchronize(adoptCloud ? { adoptCloud } : {});
      localFingerprint = await adapter.fingerprint();
    });
    if (!acquired) {
      applyStatus({ message: '另一窗口正在执行同步，稍后将自动重试。' }, false);
      dispatch({ type: 'sync-lock-busy' });
      return;
    }
    dispatch({ type: 'sync-finished', outcome });
  };

  const execute = async (command: SchedulerCommand): Promise<void> => {
    switch (command.type) {
      case 'start-sync':
        await runSync(command.adoptCloud);
        return;
      case 'forward-sync-request':
        await coordinator!.requestSync();
        applyStatus({ role: 'follower', message: '同步请求已发送给 leader 窗口。' }, false);
        return;
      case 'schedule-retry':
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          dispatch({ type: 'sync-requested', source: 'timer' });
        }, command.delayMs);
        return;
      case 'cancel-retry':
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = undefined;
        return;
      case 'prompt-cloud-adopt':
        await promptCloudAdopt();
        return;
      case 'start-schedules':
        await startSchedules();
        return;
      case 'stop-schedules':
        clearSchedules();
        return;
      case 'complete-sync-requests':
        await coordinator!.completeSyncRequests();
        return;
      case 'reload-window':
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
        return;
    }
  };

  const setEnabled = async (enabled: boolean) => {
    if (machine.enabled === enabled) return;
    await runtimeState.update({ enabled });
    // 必须先落到调度状态：写宿主设置会触发配置变更事件，此时 machine 若还是旧值就会再次调用本函数。
    dispatch({ type: 'enabled-changed', enabled });
    const settings = vscode.workspace.getConfiguration('profileGitSync');
    if (settings.get<boolean>('enabled') !== enabled) {
      await settings.update('enabled', enabled, vscode.ConfigurationTarget.Global);
    }
    await coordinator!.notifyConfigurationChanged();
  };

  const promptCloudAdopt = async () => {
    // 备份模式永不写回本机，重新克隆后仍是把本机配置推上去，确认文案必须如实说明方向。
    const backupOnly = configurationStore.get().mode === 'backup';
    const confirmed = await vscode.window.showWarningMessage(
      '本地配置仓库与远端不同源',
      {
        modal: true,
        detail: backupOnly
          ? '将删除扩展内的本地仓库缓存并重新从远端克隆，随后继续把本机配置备份到云端，覆盖云端已有的本宿主快照。本机配置不会被改写。'
          : '将删除扩展内的本地仓库缓存并重新从远端克隆，随后以云端配置覆盖本机，本轮不会把本机配置推到云端。本机原配置会备份到扩展运行目录；云端没有的扩展会被卸载。',
      },
      '废弃并覆盖',
    );
    if (confirmed !== '废弃并覆盖') {
      dispatch({ type: 'cloud-adopt-declined' });
      return;
    }
    const acquired = await coordinator!.runExclusive(async () => {
      await engine.beginCloudAdopt();
      await configurationRepository.removeRepository();
    });
    if (!acquired) {
      applyStatus({ message: '另一窗口正在执行同步，请稍后重试重建。' }, false);
      return;
    }
    applyStatus({
      lastSyncAt: undefined,
      message: backupOnly ? '本地仓库已删除，正在重新克隆并备份本机配置。' : '本地仓库已删除，正在按云端配置覆盖本机。',
    }, false);
    dispatch({ type: 'repository-removed' });
    dispatch({ type: 'sync-requested', source: 'user', adoptCloud: true });
  };

  const showHistory = async () => {
    if (!machine.enabled) {
      void vscode.window.showInformationMessage('配置同步已关闭，请先在侧边栏开启同步。');
      return;
    }
    const configuration = configurationStore.get();
    if (!configuration.repositoryUrl) {
      applyStatus({ message: '请填写 Git 仓库地址。' }, false);
      return;
    }

    try {
      let commits: RepositoryCommit[] = [];
      // 取历史要动本地仓库并联网，与同步互斥。
      const listed = await coordinator!.runExclusive(async () => {
        await configurationRepository.prepare(configuration);
        commits = await configurationRepository.listCommits(configuration, environment.kind);
      });
      if (!listed) {
        applyStatus({ message: '另一窗口正在执行同步，请稍后重试查看历史。' }, false);
        return;
      }
      if (!commits.length) {
        void vscode.window.showInformationMessage('云端还没有本宿主的配置提交。');
        return;
      }

      const picked = await vscode.window.showQuickPick(
        commits.map((commit) => ({
          label: commit.subject || '（无提交说明）',
          description: formatRelativeSyncTime(commit.committedAt),
          detail: `${commit.shortHash} · ${new Date(commit.committedAt).toLocaleString()}`,
          commit,
        })),
        { title: '云端提交历史', placeHolder: '选择要还原到的提交' },
      );
      if (!picked) return;

      const backupOnly = configuration.mode === 'backup';
      const confirmed = await vscode.window.showWarningMessage(
        `是否还原到 ${picked.commit.shortHash}？`,
        {
          modal: true,
          detail: [
            '将以该提交的配置覆盖本机，本机原配置会先备份到扩展运行目录；该提交清单里没有的扩展会在本机卸载。',
            '随后在远端追加一条新的还原提交，远端已有历史不会被改写。',
            ...(backupOnly ? ['当前是备份模式，平时不会写回本机，但还原会直接覆盖本机配置与扩展。'] : []),
          ].join('\n'),
        },
        '还原',
      );
      if (confirmed !== '还原') return;

      let outcome: SyncOutcome | undefined;
      const acquired = await coordinator!.runExclusive(async () => {
        outcome = await engine.restoreCommit(picked.commit);
        // 写回后必须刷新指纹，否则本机改动检测会把还原结果当成新改动，再空跑一轮同步。
        localFingerprint = await adapter.fingerprint();
      });
      if (!acquired) {
        applyStatus({ message: '另一窗口正在执行同步，请稍后重试还原。' }, false);
        return;
      }
      dispatch({ type: 'sync-finished', outcome });
      if (outcome?.ok) {
        applyStatus({ message: `已还原到 ${picked.commit.shortHash} 并推送新提交。` }, coordinator!.isLeader);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      applyStatus({ message }, false);
      dispatch({ type: 'sync-failed', message });
    }
  };

  const rebuildRepository = async () => {
    const confirmed = await vscode.window.showWarningMessage(
      '是否删除本机配置同步目录中的 .git？',
      { modal: true, detail: '只会去掉本机这份 Git 仓库身份，不会推送到远端，也不会改写本机配置或当前项目。' },
      '确定',
    );
    if (confirmed !== '确定') return;
    try {
      const acquired = await coordinator!.runExclusive(async () => {
        await configurationRepository.removeGitDirectory();
      });
      if (!acquired) {
        applyStatus({ message: '另一窗口正在执行同步，请稍后重试删除。' }, false);
        return;
      }
      applyStatus({
        lastSyncAt: undefined,
        message: '本机配置同步仓库的 .git 已删除，下次同步将按云端配置覆盖本机，本机原配置会先备份。',
      }, false);
      dispatch({ type: 'repository-removed' });
    } catch (error) {
      applyStatus({ message: error instanceof Error ? error.message : String(error) }, false);
      dispatch({ type: 'sync-failed', message: error instanceof Error ? error.message : String(error) });
    }
  };

  const clearSchedules = () => {
    scheduleGeneration += 1;
    schedulesReady = false;
    if (localTimer) clearInterval(localTimer);
    if (remoteTimer) clearInterval(remoteTimer);
    if (startupTimer) clearTimeout(startupTimer);
    localTimer = undefined;
    remoteTimer = undefined;
    startupTimer = undefined;
  };

  const startSchedules = async () => {
    clearSchedules();
    if (!coordinator!.isLeader || !machine.enabled) return;
    const generation = scheduleGeneration;
    localFingerprint = await adapter.fingerprint();
    if (!coordinator!.isLeader || generation !== scheduleGeneration) return;
    schedulesReady = true;

    const configuration = configurationStore.get();
    localTimer = setInterval(() => {
      if (localCheckRunning || !coordinator!.isLeader) return;
      localCheckRunning = true;
      void (async () => {
        try {
          const current = await adapter.fingerprint();
          if (current !== localFingerprint) {
            localFingerprint = current;
            dispatch({ type: 'sync-requested', source: 'timer' });
          }
        } finally {
          localCheckRunning = false;
        }
      })();
    }, configuration.debounceSeconds * 1_000);
    // 备份模式不写回本机，远端轮询拉不出任何要应用的变化，只会空转并占用独占锁。
    if (configuration.mode === 'sync') {
      remoteTimer = setInterval(() => dispatch({ type: 'sync-requested', source: 'timer' }), configuration.pollIntervalSeconds * 1_000);
    }
    startupTimer = setTimeout(() => {
      startupTimer = undefined;
      dispatch({ type: 'sync-requested', source: 'startup' });
    }, 1_500);
  };

  const updateWindowState = async () => {
    const safety = await coordinator!.windowSafety();
    applyStatus({
      role: coordinator!.isLeader ? 'leader' : 'follower',
      leaderId: coordinator!.isLeader ? coordinator!.instanceId : undefined,
      activeWindows: safety.activeWindows,
    }, coordinator!.isLeader);
  };

  const refreshConfiguration = async () => {
    await configurationStore.reload();
    const changedRuntimeState = await runtimeState.reload();
    const current = configurationStore.get();
    const repositoryChanged = current.repositoryUrl !== lastRepositoryUrl || current.branch !== lastBranch;
    lastRepositoryUrl = current.repositoryUrl;
    lastBranch = current.branch;

    if (changedRuntimeState && runtimeState.get().enabled !== machine.enabled) {
      dispatch({ type: 'enabled-changed', enabled: runtimeState.get().enabled });
    }
    dispatch({ type: 'configuration-changed', configured: Boolean(current.repositoryUrl), repositoryChanged });
    await sidebar?.pushState();
    // 轮询间隔可能变了，需要按新配置重建定时器。
    if (coordinator!.isLeader && machine.enabled) await startSchedules();
  };

  sidebar = new SidebarProvider(
    configurationStore,
    () => status,
    async () => coordinator!.notifyConfigurationChanged(),
    () => machine.enabled,
    setEnabled,
  );

  const refreshDirtyDocuments = async () => {
    const current = countDirtyDocuments(environment.userDataPath);
    if (current === dirtyDocumentCount) return;
    dirtyDocumentCount = current;
    await coordinator!.setDirtyDocuments(current);
    dispatch({ type: 'windows-changed', safety: await coordinator!.windowSafety() });
  };

  context.subscriptions.push(
    statusBar,
    vscode.window.registerWebviewViewProvider('profileGitSync.sidebar', sidebar),
    vscode.commands.registerCommand('profileGitSync.syncNow', () => {
      if (!machine.enabled) {
        void vscode.window.showInformationMessage('配置同步已关闭，请先在侧边栏开启同步。');
        return;
      }
      dispatch({ type: 'sync-requested', source: 'user' });
    }),
    vscode.commands.registerCommand('profileGitSync.toggleEnabled', () => void setEnabled(!machine.enabled)),
    vscode.commands.registerCommand('profileGitSync.showHistory', () => void showHistory()),
    vscode.commands.registerCommand('profileGitSync.rebuildRepository', () => void rebuildRepository()),
    vscode.commands.registerCommand('profileGitSync.openSettings', () => vscode.commands.executeCommand('workbench.view.extension.profileGitSync')),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('profileGitSync')) return;
      const settingEnabled = vscode.workspace.getConfiguration('profileGitSync').get<boolean>('enabled', machine.enabled);
      if (settingEnabled !== machine.enabled) {
        void setEnabled(settingEnabled).catch((error: unknown) => reportRuntimeStateError(error));
        return;
      }
      void configurationStore.saveApplicationSettings().then(async (changed) => {
        if (changed) await coordinator!.notifyConfigurationChanged();
        else await sidebar.pushState();
      }).catch((error: unknown) => {
        applyStatus({ message: coordinationErrorMessage(error) }, false);
      });
    }),
    vscode.workspace.onDidOpenTextDocument(() => void refreshDirtyDocuments()),
    vscode.workspace.onDidChangeTextDocument(() => void refreshDirtyDocuments()),
    vscode.workspace.onDidSaveTextDocument(() => void refreshDirtyDocuments()),
    vscode.workspace.onDidCloseTextDocument(() => void refreshDirtyDocuments()),
  );

  const onBecameLeader = () => {
    void updateWindowState();
    dispatch({ type: 'leadership-changed', isLeader: true });
  };
  const onBecameFollower = () => {
    dispatch({ type: 'leadership-changed', isLeader: false });
    void updateWindowState();
  };
  const onSyncRequested = () => dispatch({ type: 'sync-requested', source: 'peer' });
  const onStatusChanged = (patch: Partial<RuntimeStatus>) => applyStatus(patch, false);
  const onConfigurationChanged = () => void refreshConfiguration();
  const onWindowsChanged = (safety: WindowSafetySnapshot) => {
    applyStatus({ activeWindows: safety.activeWindows }, coordinator!.isLeader);
    dispatch({ type: 'windows-changed', safety });
  };
  const onCoordinationError = (error: Error) => applyStatus({ message: coordinationErrorMessage(error) }, false);

  coordinator.on('becameLeader', onBecameLeader);
  coordinator.on('becameFollower', onBecameFollower);
  coordinator.on('syncRequested', onSyncRequested);
  coordinator.on('statusChanged', onStatusChanged);
  coordinator.on('configurationChanged', onConfigurationChanged);
  coordinator.on('windowsChanged', onWindowsChanged);
  coordinator.on('coordinationError', onCoordinationError);
  context.subscriptions.push({
    dispose: () => {
      coordinator?.off('becameLeader', onBecameLeader);
      coordinator?.off('becameFollower', onBecameFollower);
      coordinator?.off('syncRequested', onSyncRequested);
      coordinator?.off('statusChanged', onStatusChanged);
      coordinator?.off('configurationChanged', onConfigurationChanged);
      coordinator?.off('windowsChanged', onWindowsChanged);
      coordinator?.off('coordinationError', onCoordinationError);
    },
  });

  // 配置轮询独立于同步开关：关闭状态下仍要能感知其他窗口重新开启同步。
  // 开关状态每个窗口都要跟进，因此这一段不限于 leader。
  configurationTimer = setInterval(() => {
    void runtimeState.reload().then((changed) => {
      if (changed && runtimeState.get().enabled !== machine.enabled) {
        dispatch({ type: 'enabled-changed', enabled: runtimeState.get().enabled });
      }
    }).catch(reportRuntimeStateError);
    if (!coordinator!.isLeader) return;
    void configurationStore.reload().then(async (changed) => {
      if (changed) await coordinator!.notifyConfigurationChanged();
    }).catch((error: unknown) => applyStatus({ message: coordinationErrorMessage(error) }, false));
  }, 5_000);

  await coordinator.setDirtyDocuments(dirtyDocumentCount);
  await coordinator.start();
  await updateWindowState();
  // leadership-changed 已经会按需发出 start-schedules，这里不再重复启动。
  dispatch({ type: 'leadership-changed', isLeader: coordinator.isLeader });
  renderStatusBar();
}

export async function deactivate(): Promise<void> {
  if (localTimer) clearInterval(localTimer);
  if (remoteTimer) clearInterval(remoteTimer);
  if (configurationTimer) clearInterval(configurationTimer);
  if (startupTimer) clearTimeout(startupTimer);
  if (retryTimer) clearTimeout(retryTimer);
  localTimer = undefined;
  remoteTimer = undefined;
  configurationTimer = undefined;
  startupTimer = undefined;
  retryTimer = undefined;
  await coordinator?.dispose();
}

function countDirtyDocuments(userDataPath: string): number {
  return vscode.workspace.textDocuments.filter(
    (document) => document.isDirty
      && document.uri.scheme === 'file'
      && isInside(userDataPath, document.uri.fsPath),
  ).length;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function coordinationErrorMessage(error: unknown): string {
  return `多窗口协调失败：${error instanceof Error ? error.message : String(error)}`;
}

/** 状态栏与侧边栏共用的详情文案：进行中的步骤在前，具体说明在后。 */
function statusDetail(status: RuntimeStatus): string | undefined {
  const lines: string[] = [];
  if (status.sync.kind === 'running') lines.push(stageLabel(status.sync.stage));
  if (status.message) lines.push(status.message);
  return lines.length ? lines.join('\n') : undefined;
}
