import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AiService } from './ai';
import { ConfigurationStore } from './configuration';
import { MultiWindowCoordinator, WindowSafetySnapshot } from './coordinator';
import { ConfigurationRepositoryGitService } from './git-service';
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
import { displayIcon, displayPhase, stageLabel } from './sidebar-status';
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
  const configurationStore = new ConfigurationStore(context, environment.runtimePath);
  const runtimeState = new RuntimeStateStore(environment.runtimePath);
  // 先按默认值占位，初始化完成后再换成真实状态；此前 sidebar 不推状态，只渲染静态骨架。
  let machine = createMachine({ enabled: false, configured: false, link: 'no-repository' });
  const status: RuntimeStatus = {
    sync: machine.sync,
    link: machine.link,
    role: 'stopped',
    activeWindows: 1,
    profiles: [],
    pendingChanges: 0,
  };
  const sidebar = new SidebarProvider(
    configurationStore,
    () => status,
    async () => coordinator!.notifyConfigurationChanged(),
    () => machine.enabled,
    async (enabled) => setEnabled(enabled),
  );
  // 视图必须在任何 IO 之前注册：初始化要抢跨窗口文件锁、写 SecretStorage 和宿主设置，
  // 多窗口同时启动时可能等上数秒，注册晚了这段时间里点开侧边栏只有一片空白。
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('profileGitSync.sidebar', sidebar, {
    // 面板隐藏后保留上下文，重新点开不必再建一遍 DOM 并等状态往返。
    webviewOptions: { retainContextWhenHidden: true },
  }));

  try {
    await fs.mkdir(environment.runtimePath, { recursive: true });
    // 两份共享状态各有各的锁，串行没有意义，最慢的一次决定用户等多久。
    await Promise.all([
      configurationStore.initialize(),
      runtimeState.initialize({
        enabled: vscode.workspace.getConfiguration('profileGitSync').get<boolean>('enabled', false),
      }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void sidebar.fail(`配置同步启动失败：${message}`);
    reportActivationFailure(context, error);
    return;
  }

  const adapter = new ProfileAdapter(environment);
  // Profile 枚举可能需要扫描多个目录，不能阻塞侧边栏首次渲染。
  const profilesTask = adapter.listProfiles();

  const persisted = runtimeState.get();
  machine = createMachine({
    enabled: persisted.enabled,
    configured: Boolean(configurationStore.get().repositoryUrl),
    link: persisted.link,
  });
  status.sync = machine.sync;
  status.link = machine.link;
  if (persisted.lastSyncAt) status.lastSyncAt = persisted.lastSyncAt;

  // 共享文件是权威来源，启动时把它镜像回宿主设置，避免多个 Profile 显示的开关不一致。
  const enabledSetting = vscode.workspace.getConfiguration('profileGitSync');
  if (enabledSetting.get<boolean>('enabled') !== persisted.enabled) {
    await enabledSetting.update('enabled', persisted.enabled, vscode.ConfigurationTarget.Global);
  }

  coordinator = new MultiWindowCoordinator(path.join(environment.runtimePath, 'coordination'));
  const configurationRepository = new ConfigurationRepositoryGitService(environment.runtimePath);
  const ai = new AiService();
  let localFingerprint: string | undefined;
  let localCheckRunning = false;
  let scheduleGeneration = 0;
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
    void sidebar.pushState();
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
    // 命令执行失败必须有归属：未处理的拒绝会让调度状态永远停在 running，只能靠重开开关或重载窗口恢复。
    for (const command of commands) {
      void execute(command).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        applyStatus({ message }, false);
        if (command.type === 'start-sync') dispatch({ type: 'sync-failed', message });
      });
    }
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
      if (!outcome?.cancelled) localFingerprint = await adapter.fingerprint();
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

  /**
   * 开关变化进入调度层的唯一入口。开关也可能由其他窗口改变并经共享文件传来，
   * 那些路径不走 setEnabled，停止意图必须在这里跟随每一次变化：
   * 漏掉 requestStop 会让本轮照常写回本机，漏掉 clearStop 会让本窗口之后每一轮都被取消。
   */
  const applyEnabledChange = (enabled: boolean) => {
    // 调度状态已是 running 但引擎可能还在抢锁，停止意图必须无条件登记。
    if (enabled) engine.clearStop();
    else engine.requestStop();
    dispatch({ type: 'enabled-changed', enabled });
  };

  const setEnabled = async (enabled: boolean) => {
    if (machine.enabled === enabled) return;
    await runtimeState.update({ enabled });
    const stopping = !enabled && machine.sync.kind === 'running';
    // 必须先落到调度状态：写宿主设置会触发配置变更事件，此时 machine 若还是旧值就会再次调用本函数。
    applyEnabledChange(enabled);
    if (stopping) applyStatus({ message: '正在停止同步，当前操作完成后将停止。' }, false);
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
      // 备份模式重建后仍然只上传本机配置，标记采用云端会在用户切到同步模式时覆盖本机。
      if (!backupOnly) await engine.beginCloudAdopt();
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
        } catch (error) {
          // 指纹读取失败不升级为同步失败：下个周期会重试，但要留下可见原因。
          applyStatus({ message: `本机配置检测失败：${error instanceof Error ? error.message : String(error)}` }, false);
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
      applyEnabledChange(runtimeState.get().enabled);
    }
    dispatch({ type: 'configuration-changed', configured: Boolean(current.repositoryUrl), repositoryChanged });
    await sidebar.pushState();
    // 轮询间隔可能变了，需要按新配置重建定时器。
    if (coordinator!.isLeader && machine.enabled) await startSchedules();
  };

  const refreshDirtyDocuments = async () => {
    const current = countDirtyDocuments(environment.userDataPath);
    if (current === dirtyDocumentCount) return;
    dirtyDocumentCount = current;
    await coordinator!.setDirtyDocuments(current);
    dispatch({ type: 'windows-changed', safety: await coordinator!.windowSafety() });
  };

  context.subscriptions.push(
    statusBar,
    vscode.commands.registerCommand('profileGitSync.syncNow', () => {
      if (!machine.enabled) {
        void vscode.window.showInformationMessage('配置同步已关闭，请先在侧边栏开启同步。');
        return;
      }
      dispatch({ type: 'sync-requested', source: 'user' });
    }),
    vscode.commands.registerCommand('profileGitSync.toggleEnabled', () => void setEnabled(!machine.enabled)),
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

  const profiles = await profilesTask;
  status.profiles = profiles.map((profile) => profile.name);
  sidebar.markReady();
  await sidebar.pushState();

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
        applyEnabledChange(runtimeState.get().enabled);
      }
    }).catch(reportRuntimeStateError);
    if (!coordinator!.isLeader) return;
    void configurationStore.reload().then(async (changed) => {
      if (changed) await coordinator!.notifyConfigurationChanged();
    }).catch((error: unknown) => applyStatus({ message: coordinationErrorMessage(error) }, false));
  }, 5_000);

  renderStatusBar();
  // 协调器启动要写 presence、抢租约、扫描全部窗口状态，全是磁盘往返，没必要占着激活路径；
  // 侧边栏与状态栏此时已经能显示，剩下的在后台补齐即可。
  void (async () => {
    try {
      await coordinator!.setDirtyDocuments(dirtyDocumentCount);
      await coordinator!.start();
      await updateWindowState();
      // leadership-changed 已经会按需发出 start-schedules，这里不再重复启动。
      dispatch({ type: 'leadership-changed', isLeader: coordinator!.isLeader });
    } catch (error) {
      applyStatus({ message: coordinationErrorMessage(error) }, false);
    }
  })();
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

/** 初始化失败后扩展无法工作，但仍要让用户看到原因和恢复方式。 */
function reportActivationFailure(context: vscode.ExtensionContext, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const statusBar = vscode.window.createStatusBarItem('profileGitSync.status', vscode.StatusBarAlignment.Right, 100);
  statusBar.name = 'My Setting Sync';
  statusBar.text = '$(error) 配置同步';
  statusBar.tooltip = `配置同步启动失败：${message}\n重载窗口后会重新尝试。`;
  statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  statusBar.show();
  context.subscriptions.push(statusBar);
  void vscode.window.showErrorMessage(`配置同步启动失败：${message}`);
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
