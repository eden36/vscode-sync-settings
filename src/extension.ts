import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AiService } from './ai';
import { ConfigurationStore } from './configuration';
import { MultiWindowCoordinator, WindowSafetySnapshot } from './coordinator';
import { ConfigurationRepositoryGitService, RepositoryCommit } from './git-service';
import { HistoryController } from './history-controller';
import { detectHost } from './host';
import { ProfileAdapter } from './profile-adapter';
import { RuntimeStateStore } from './runtime-state';
import {
  createMachine,
  reduce,
  SchedulerCommand,
  SchedulerEvent,
} from './scheduler';
import { SidebarProvider } from './sidebar';
import { profileMismatchText } from './sidebar-status';
import { reportActivationFailure, SyncStatusBar } from './status-bar';
import { SyncEngine } from './sync-engine';
import { SyncSchedules } from './sync-schedules';
import { HOST_LABELS, RuntimeStatus, SyncOutcome } from './types';

const CONFIGURATION_POLL_MS = 5_000;
/** 通过「打开用户设置 (JSON)」等入口打开的配置文件使用这个协议，而不是 file。 */
const USER_DATA_SCHEME = 'vscode-userdata';

/** 初始化成功后才有值；激活失败时没有任何需要清理的定时器与协调器状态。 */
let shutdown: (() => Promise<void>) | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const environment = detectHost(context);
  if (!environment) {
    // 识别不了宿主就无法确定云端目录，归到别的宿主名下会与它互相覆盖快照、反复装卸扩展。纯内存判断，不涉及 IO。
    reportActivationFailure(context, new Error(`暂不支持 ${vscode.env.appName}，配置同步未启动。`));
    return;
  }
  const configurationStore = new ConfigurationStore(context, environment.runtimePath);
  const runtimeState = new RuntimeStateStore(environment.runtimePath);
  // 构造函数不做任何 IO，真正的磁盘往返在 start 里；提前建好，下面的闭包就不必处理「协调器还不存在」。
  const coordinator = new MultiWindowCoordinator(path.join(environment.runtimePath, 'coordination'));
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
  const sidebar = new SidebarProvider({
    extensionUri: context.extensionUri,
    configurationStore,
    status: () => status,
    onConfigurationSaved: async () => coordinator.notifyConfigurationChanged(),
    isEnabled: () => machine.enabled,
    setEnabled: async (enabled) => setEnabled(enabled),
    onResolveConflict: async (resolution) => applyResolution(resolution),
    profileMismatch: () => runtimeState.get().profileMismatch,
    onResolveProfiles: async () => promptProfileChoice(),
    history: {
      load: async (limit, refresh) => history.load(limit, refresh),
      loadMore: async () => history.loadMore(),
      restore: async (hash) => history.restore(hash),
      createTag: async (hash) => history.createTag(hash),
      deleteTag: async (_hash, tag) => history.deleteTag(tag),
    },
  });
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

  const configurationRepository = new ConfigurationRepositoryGitService(environment.runtimePath);
  const statusBar = new SyncStatusBar();
  let configurationTimer: NodeJS.Timeout | undefined;
  let dirtyDocumentCount = countDirtyDocuments(environment.userDataPath);
  let lastRepositoryUrl = configurationStore.get().repositoryUrl;
  let lastBranch = configurationStore.get().branch;

  const applyStatus = (patch: Partial<RuntimeStatus>, publish: boolean) => {
    Object.assign(status, patch);
    // 用 in 判断而不是取值判断，删除仓库时要能把 lastSyncAt 显式清成 undefined。
    if ('lastSyncAt' in patch) {
      void runtimeState.update({ lastSyncAt: patch.lastSyncAt }).catch(reportRuntimeStateError);
    }
    statusBar.render(status);
    void sidebar.pushState();
    if (publish && coordinator.isLeader) {
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
      applyStatus({ sync: next.sync, link: next.link }, coordinator.isLeader);
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

  /** 同步请求的统一入口：用户已经选定一方时必须带上标记，否则会停在等待选择的阻塞态。 */
  const requestSync = (source: 'user' | 'peer' | 'timer' | 'startup') => {
    dispatch({ type: 'sync-requested', source, resolved: runtimeState.get().pendingResolution !== undefined });
  };

  const engine = new SyncEngine(
    environment,
    adapter,
    configurationRepository,
    new AiService(),
    configurationStore,
    runtimeState,
    (patch) => {
      // 流程只报告进度与说明；阶段之外的状态一律由调度层决定。
      if (patch.sync?.kind === 'running') dispatch({ type: 'sync-progress', stage: patch.sync.stage });
      const { sync: _sync, link: _link, ...rest } = patch;
      if (Object.keys(rest).length) applyStatus(rest, coordinator.isLeader);
    },
    () => coordinator.windowSafety(),
    // 装卸命令异步失败不会改变清单，补一轮才能把失败原因显示出来；失败的扩展本进程内不再重发，不会循环。
    () => requestSync('timer'),
  );

  const schedules = new SyncSchedules({
    fingerprint: async () => adapter.fingerprint(),
    remoteChanged: async () => configurationRepository.remoteChanged(configurationStore.get()),
    isLeader: () => coordinator.isLeader,
    isEnabled: () => machine.enabled,
    configuration: () => configurationStore.get(),
    requestSync,
    reportError: (message) => applyStatus({ message }, false),
  });

  shutdown = async () => {
    schedules.dispose();
    if (configurationTimer) clearInterval(configurationTimer);
    configurationTimer = undefined;
    await coordinator.dispose();
  };

  const runSync = async (adoptCloud: boolean) => {
    let outcome: SyncOutcome | undefined;
    const acquired = await coordinator.runExclusive(async () => {
      outcome = await engine.synchronize(adoptCloud ? { adoptCloud } : {});
      // 本机在本轮期间被改动时保留旧指纹，让本机检测的下一拍立刻重跑，而不是干等远端轮询。
      if (!outcome?.cancelled && outcome?.blockReason !== 'local-changed') await schedules.refreshFingerprint();
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
        await coordinator.requestSync();
        applyStatus({ role: 'follower', message: '同步请求已发送给 leader 窗口。' }, false);
        return;
      case 'schedule-retry':
        schedules.scheduleRetry(command.delayMs);
        return;
      case 'cancel-retry':
        schedules.cancelRetry();
        return;
      case 'prompt-cloud-adopt':
        await promptCloudAdopt();
        return;
      case 'prompt-version-choice':
        await promptVersionChoice();
        return;
      case 'prompt-profile-choice':
        await promptProfileChoice();
        return;
      case 'start-schedules':
        await schedules.start();
        return;
      case 'stop-schedules':
        schedules.stop();
        return;
      case 'complete-sync-requests':
        await coordinator.completeSyncRequests();
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
    await coordinator.notifyConfigurationChanged();
  };

  /** 用户的选择写进共享状态，本窗口不是 leader 时由 leader 读出来执行。 */
  const applyResolution = async (resolution: 'local' | 'cloud') => {
    await runtimeState.update({ pendingResolution: resolution });
    applyStatus({
      message: resolution === 'local' ? '正在用本机配置覆盖云端。' : '正在用云端配置覆盖本机。',
    }, false);
    dispatch({ type: 'sync-requested', source: 'user', resolved: true });
  };

  const promptVersionChoice = async () => {
    const reason = status.message ? `${status.message}\n\n` : '';
    const choice = await vscode.window.showWarningMessage(
      '本机与云端都有改动',
      {
        modal: true,
        detail: `${reason}选择「以本机为准」会用本机配置整份覆盖云端；选择「以云端为准」会用云端配置整份覆盖本机，并按云端清单装卸扩展。另一份配置会先备份到扩展运行目录。不选择则一直暂停，两侧都不会被改写。`,
      },
      '以本机为准',
      '以云端为准',
    );
    if (choice !== '以本机为准' && choice !== '以云端为准') return;
    await applyResolution(choice === '以本机为准' ? 'local' : 'cloud');
  };

  /**
   * Profile 不一致时只有一种需要用户确认的处理（从云端删除或保留本机的）；另一种是用户自己去新建或删除 Profile，
   * 完成后指纹变化会自动继续同步。选择写进共享状态，本窗口不是 leader 时由 leader 读出来执行。
   */
  const promptProfileChoice = async () => {
    await runtimeState.reload();
    const mismatch = runtimeState.get().profileMismatch;
    if (!mismatch) return;
    const text = profileMismatchText(mismatch);
    const confirmed = await vscode.window.showWarningMessage(
      text.summary,
      { modal: true, detail: text.detail },
      text.action,
    );
    if (confirmed !== text.action) return;
    await runtimeState.update({ profileResolution: mismatch });
    applyStatus({ message: `已确认：${text.action}，正在继续同步。` }, false);
    dispatch({ type: 'sync-requested', source: 'user' });
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
    const acquired = await coordinator.runExclusive(async () => {
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

  /** 历史页面确认后的还原：写回本机并改变同步状态，因此与普通同步一样经调度层收尾。 */
  const runRestore = async (target: RepositoryCommit) => {
    try {
      let outcome: SyncOutcome | undefined;
      const acquired = await coordinator.runExclusive(async () => {
        outcome = await engine.restoreCommit(target);
        // 写回后必须刷新指纹，否则本机改动检测会把还原结果当成新改动，再空跑一轮同步；
        // 本机在还原期间被改过时保留旧指纹，让本机检测的下一拍立刻发现并同步那次改动。
        if (outcome?.blockReason !== 'local-changed') await schedules.refreshFingerprint();
      });
      if (!acquired) {
        applyStatus({ message: '另一窗口正在执行同步，请稍后重试还原。' }, false);
        return;
      }
      dispatch({ type: 'sync-finished', outcome });
      if (outcome?.ok) {
        applyStatus({ message: `已还原到 ${target.shortHash} 并推送新提交。` }, coordinator.isLeader);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      applyStatus({ message }, false);
      dispatch({ type: 'sync-failed', message });
    }
  };

  /**
   * 用户显式触发的「以本机覆盖云端」：只推送、不写回本机，同步开关关闭时也可用。
   * 在任意窗口执行，整段包在独占锁内；收尾与还原一样经调度层。
   */
  const overrideCloud = async () => {
    if (!configurationStore.get().repositoryUrl) {
      applyStatus({ message: '请填写 Git 仓库地址。' }, false);
      return;
    }
    const confirmed = await vscode.window.showWarningMessage(
      `是否以本机配置覆盖云端 ${HOST_LABELS[environment.kind]} 的配置？`,
      {
        modal: true,
        detail: [
          '将用本机当前的配置整份替换云端仓库中本宿主的快照，并追加一条新提交；远端已有历史不会被改写，之后仍可从云端提交历史还原。',
          '云端有、本机没有的 Profile 会从云端删除；扩展清单以本机为准，云端独有的扩展会被删除，其他机器下次同步时会卸载它们。',
          '云端其他平台的快捷键文件会保留，本机配置不会被改动。',
          ...(machine.enabled ? [] : ['当前同步已关闭，本次覆盖不会开启同步。']),
        ].join('\n'),
      },
      '覆盖云端',
    );
    if (confirmed !== '覆盖云端') return;
    try {
      let outcome: SyncOutcome | undefined;
      const acquired = await coordinator.runExclusive(async () => {
        outcome = await engine.overrideCloud();
      });
      if (!acquired) {
        applyStatus({ message: '另一窗口正在执行同步，请稍后重试覆盖云端。' }, false);
        return;
      }
      dispatch({ type: 'sync-finished', outcome });
      if (outcome?.ok) applyStatus({ message: '已以本机配置覆盖云端。' }, coordinator.isLeader);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      applyStatus({ message }, false);
      dispatch({ type: 'sync-failed', message });
    }
  };

  // 侧边栏的回调与这里互相引用，显式标注类型才能让推断收敛。
  const history: HistoryController = new HistoryController({
    coordinator,
    repository: configurationRepository,
    configurationStore,
    sidebar,
    hostKind: environment.kind,
    isEnabled: () => machine.enabled,
    reportStatus: (message) => applyStatus({ message }, false),
    restore: runRestore,
  });

  const rebuildRepository = async () => {
    const confirmed = await vscode.window.showWarningMessage(
      '是否删除本机配置同步目录中的 .git？',
      { modal: true, detail: '只会去掉本机这份 Git 仓库身份，不会推送到远端，也不会改写本机配置或当前项目。' },
      '确定',
    );
    if (confirmed !== '确定') return;
    try {
      const acquired = await coordinator.runExclusive(async () => {
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

  const updateWindowState = async () => {
    const safety = await coordinator.windowSafety();
    applyStatus({
      role: coordinator.isLeader ? 'leader' : 'follower',
      leaderId: coordinator.isLeader ? coordinator.instanceId : undefined,
      activeWindows: safety.activeWindows,
    }, coordinator.isLeader);
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
    if (coordinator.isLeader && machine.enabled) await schedules.start();
  };

  const refreshDirtyDocuments = async () => {
    const current = countDirtyDocuments(environment.userDataPath);
    if (current === dirtyDocumentCount) return;
    dirtyDocumentCount = current;
    await coordinator.setDirtyDocuments(current);
    dispatch({ type: 'windows-changed', safety: await coordinator.windowSafety() });
  };

  context.subscriptions.push(
    statusBar,
    vscode.commands.registerCommand('profileGitSync.syncNow', () => {
      if (!machine.enabled) {
        void vscode.window.showInformationMessage('配置同步已关闭，请先在侧边栏开启同步。');
        return;
      }
      requestSync('user');
    }),
    vscode.commands.registerCommand('profileGitSync.toggleEnabled', () => void setEnabled(!machine.enabled)),
    vscode.commands.registerCommand('profileGitSync.showHistory', () => void history.open()),
    vscode.commands.registerCommand('profileGitSync.overrideCloud', () => void overrideCloud()),
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
        if (changed) await coordinator.notifyConfigurationChanged();
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
  // 其他窗口可能刚写下用户的选择，必须先读共享状态再决定这一轮能不能开跑。
  const onSyncRequested = () => void runtimeState.reload()
    .then(() => requestSync('peer'))
    .catch(reportRuntimeStateError);
  const onStatusChanged = (patch: Partial<RuntimeStatus>) => applyStatus(patch, false);
  const onConfigurationChanged = () => void refreshConfiguration();
  const onWindowsChanged = (safety: WindowSafetySnapshot) => {
    applyStatus({ activeWindows: safety.activeWindows }, coordinator.isLeader);
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
      coordinator.off('becameLeader', onBecameLeader);
      coordinator.off('becameFollower', onBecameFollower);
      coordinator.off('syncRequested', onSyncRequested);
      coordinator.off('statusChanged', onStatusChanged);
      coordinator.off('configurationChanged', onConfigurationChanged);
      coordinator.off('windowsChanged', onWindowsChanged);
      coordinator.off('coordinationError', onCoordinationError);
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
    if (!coordinator.isLeader) return;
    void configurationStore.reload().then(async (changed) => {
      if (changed) await coordinator.notifyConfigurationChanged();
    }).catch((error: unknown) => applyStatus({ message: coordinationErrorMessage(error) }, false));
  }, CONFIGURATION_POLL_MS);

  statusBar.render(status);
  // 协调器启动要写 presence、抢租约、扫描全部窗口状态，全是磁盘往返，没必要占着激活路径；
  // 侧边栏与状态栏此时已经能显示，剩下的在后台补齐即可。
  void (async () => {
    try {
      await coordinator.setDirtyDocuments(dirtyDocumentCount);
      await coordinator.start();
      await updateWindowState();
      // leadership-changed 已经会按需发出 start-schedules，这里不再重复启动。
      dispatch({ type: 'leadership-changed', isLeader: coordinator.isLeader });
    } catch (error) {
      applyStatus({ message: coordinationErrorMessage(error) }, false);
    }
  })();
}

export async function deactivate(): Promise<void> {
  await shutdown?.();
  shutdown = undefined;
}

function countDirtyDocuments(userDataPath: string): number {
  return vscode.workspace.textDocuments.filter(
    (document) => document.isDirty
      && (document.uri.scheme === 'file' || document.uri.scheme === USER_DATA_SCHEME)
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
