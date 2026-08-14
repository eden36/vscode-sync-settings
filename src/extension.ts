import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AiService } from './ai';
import { ConfigurationStore } from './configuration';
import { MultiWindowCoordinator, WindowSafetySnapshot } from './coordinator';
import { ConfigurationRepositoryGitService } from './git-service';
import { detectHost } from './host';
import { ProfileAdapter } from './profile-adapter';
import { SidebarProvider } from './sidebar';
import { displaySyncPhase, isBusyPhase } from './sidebar-status';
import { SyncEngine } from './sync-engine';
import { RuntimeStatus, SyncOutcome } from './types';

let coordinator: MultiWindowCoordinator | undefined;
let localTimer: NodeJS.Timeout | undefined;
let remoteTimer: NodeJS.Timeout | undefined;
let startupTimer: NodeJS.Timeout | undefined;
let retryTimer: NodeJS.Timeout | undefined;
let configurationTimer: NodeJS.Timeout | undefined;
const LAST_SYNC_KEY = 'profileGitSync.lastSyncAt';
const OPERATION_RETRY_MS = 5_000;
const MAX_OPERATION_RETRY_MS = 60_000;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const environment = detectHost(context);
  await fs.mkdir(environment.runtimePath, { recursive: true });
  const configurationStore = new ConfigurationStore(context, environment.runtimePath);
  await configurationStore.initialize();
  const adapter = new ProfileAdapter(environment);
  const profiles = await adapter.listProfiles();
  const status: RuntimeStatus = {
    phase: configurationStore.get().repositoryUrl ? '空闲' : '未配置',
    role: 'stopped',
    activeWindows: 1,
    profiles: profiles.map((profile) => profile.name),
    pendingChanges: 0,
    lastSyncAt: context.globalState.get<string>(LAST_SYNC_KEY),
  };

  coordinator = new MultiWindowCoordinator(path.join(environment.runtimePath, 'coordination'));
  const configurationRepository = new ConfigurationRepositoryGitService(environment.runtimePath);
  const ai = new AiService();
  let localFingerprint: string | undefined;
  let sidebar: SidebarProvider;
  let syncRunning = false;
  let pendingSync = false;
  let retryWhenSafe = false;
  let scheduleGeneration = 0;
  let leaderSchedulesReady = false;
  let localCheckRunning = false;
  let operationRetryDelayMs = OPERATION_RETRY_MS;
  let dirtyDocumentCount = countDirtyDocuments(environment.userDataPath);

  // 同步全过程不弹通知，状态只落在状态栏和侧边栏，避免打断用户。
  const statusBar = vscode.window.createStatusBarItem('profileGitSync.status', vscode.StatusBarAlignment.Right, 100);
  statusBar.name = 'My Setting Sync';
  statusBar.command = 'profileGitSync.openSettings';
  const renderStatusBar = () => {
    const phase = displaySyncPhase(status.phase, status.lastSyncAt);
    const icon = isBusyPhase(status.phase) ? '$(sync~spin)'
      : status.phase === '失败' ? '$(warning)'
      : status.phase === '未配置' ? '$(gear)'
      : status.phase === '等待其他窗口关闭' ? '$(clock)'
      : '$(check)';
    statusBar.text = `${icon} 配置同步`;
    statusBar.tooltip = status.message ? `配置同步：${phase}\n${status.message}` : `配置同步：${phase}`;
    statusBar.backgroundColor = status.phase === '失败'
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
    statusBar.show();
  };

  const applyStatus = (patch: Partial<RuntimeStatus>, publish: boolean) => {
    Object.assign(status, patch);
    if (patch.lastSyncAt) void context.globalState.update(LAST_SYNC_KEY, patch.lastSyncAt);
    renderStatusBar();
    void sidebar?.pushState();
    if (publish && coordinator?.isLeader) {
      void coordinator.publishStatus(status).catch((error: unknown) => {
        applyStatus({ phase: '失败', message: coordinationErrorMessage(error) }, false);
      });
    }
  };
  const updateStatus = (patch: Partial<RuntimeStatus>) => applyStatus(patch, true);
  const engine = new SyncEngine(
    environment,
    adapter,
    configurationRepository,
    ai,
    configurationStore,
    updateStatus,
    () => coordinator!.windowSafety(),
  );

  // Profile 增删只有重载后才会出现在 IDE 界面上；其余配置文件写盘即生效，不需要重载。
  const reloadAfterSync = async (outcome: SyncOutcome | undefined) => {
    if (!outcome?.ok || !outcome.structuralApplied || status.phase === '失败') return;
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  };

  const scheduleOperationRetry = () => {
    if (retryTimer) clearTimeout(retryTimer);
    // 另一窗口可能长时间持有独占锁，逐步退避避免空转重试。
    const delayMs = Math.min(operationRetryDelayMs, MAX_OPERATION_RETRY_MS);
    operationRetryDelayMs = Math.min(delayMs * 2, MAX_OPERATION_RETRY_MS);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void synchronize();
    }, delayMs);
  };

  const synchronize = async (options: { adoptCloud?: boolean } = {}): Promise<SyncOutcome | undefined> => {
    if (!coordinator!.isLeader) {
      await coordinator!.requestSync();
      applyStatus({ role: 'follower', message: '同步请求已发送给 leader 窗口。' }, false);
      return undefined;
    }
    if (syncRunning) {
      pendingSync = true;
      return undefined;
    }

    syncRunning = true;
    let finalOutcome: SyncOutcome | undefined;
    let completed = false;
    try {
      do {
        pendingSync = false;
        completed = false;
        let outcome: SyncOutcome | undefined;
        const acquired = await coordinator!.runExclusive(async () => {
          outcome = await engine.synchronize(options);
          localFingerprint = await adapter.fingerprint();
        });
        if (!acquired) {
          applyStatus({ message: '另一窗口正在执行同步，稍后将自动重试。' }, false);
          scheduleOperationRetry();
          break;
        }
        operationRetryDelayMs = OPERATION_RETRY_MS;
        finalOutcome = outcome;
        if (outcome?.retry) {
          retryWhenSafe = true;
          break;
        }
        retryWhenSafe = false;
        completed = outcome !== undefined;
        if (outcome?.structuralApplied) void reloadAfterSync(outcome);
      } while (pendingSync && coordinator!.isLeader);

      if (completed && !pendingSync && !retryWhenSafe) await coordinator!.completeSyncRequests();
      return finalOutcome;
    } finally {
      syncRunning = false;
      if (pendingSync && coordinator!.isLeader && !retryWhenSafe) void synchronize();
      if (coordinator!.isLeader && !leaderSchedulesReady) void startLeaderSchedules();
    }
  };

  // 本地仓库只是缓存；删除后带标记同步，强制按云端覆盖本机且本轮不推送。
  const rebuildRepository = async () => {
    if (!coordinator!.isLeader) {
      applyStatus({ role: 'follower', message: '请在 leader 窗口执行重建本地仓库。' }, false);
      return;
    }
    const confirmed = await vscode.window.showWarningMessage(
      '重建本地配置同步仓库？',
      { modal: true, detail: '将删除本地仓库缓存并重新从远端克隆，随后以云端配置覆盖本机，本轮不会把本机配置推到云端。本机原配置会备份到扩展运行目录。若存在 Profile 增删，需只剩一个窗口才能完整应用。' },
      '重建',
    );
    if (confirmed !== '重建') return;
    const acquired = await coordinator!.runExclusive(async () => {
      await engine.beginCloudAdopt();
      await configurationRepository.removeRepository();
    });
    if (!acquired) {
      applyStatus({ message: '另一窗口正在执行同步，请稍后重试重建。' }, false);
      return;
    }
    applyStatus({ phase: '空闲', message: '本地仓库已删除，正在按云端配置覆盖本机。' }, false);
    await synchronize({ adoptCloud: true });
  };

  const clearLeaderSchedules = () => {
    scheduleGeneration += 1;
    leaderSchedulesReady = false;
    if (localTimer) clearInterval(localTimer);
    if (remoteTimer) clearInterval(remoteTimer);
    if (configurationTimer) clearInterval(configurationTimer);
    if (startupTimer) clearTimeout(startupTimer);
    localTimer = undefined;
    remoteTimer = undefined;
    configurationTimer = undefined;
    startupTimer = undefined;
  };

  const startLeaderSchedules = async () => {
    clearLeaderSchedules();
    if (!coordinator!.isLeader) return;
    const generation = scheduleGeneration;
    localFingerprint = await adapter.fingerprint();
    if (!coordinator!.isLeader || generation !== scheduleGeneration) return;
    leaderSchedulesReady = true;
    configurationTimer = setInterval(() => {
      if (!coordinator!.isLeader) return;
      void configurationStore.reload().then(async (changed) => {
        if (changed) await coordinator!.notifyConfigurationChanged();
      }).catch((error: unknown) => applyStatus({ phase: '失败', message: coordinationErrorMessage(error) }, false));
    }, 5_000);
    const configuration = configurationStore.get();
    if (!configuration.autoSync) return;
    const debounceMs = configuration.debounceSeconds * 1_000;
    const pollMs = configuration.pollIntervalSeconds * 1_000;
    localTimer = setInterval(() => {
      if (localCheckRunning || !coordinator!.isLeader) return;
      localCheckRunning = true;
      void (async () => {
        try {
          const current = await adapter.fingerprint();
          if (current !== localFingerprint) {
            localFingerprint = current;
            await synchronize();
          }
        } finally {
          localCheckRunning = false;
        }
      })();
    }, debounceMs);
    remoteTimer = setInterval(() => void synchronize(), pollMs);
    startupTimer = setTimeout(() => {
      startupTimer = undefined;
      void synchronize();
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
    if (!syncRunning) applyStatus({
      phase: configurationStore.get().repositoryUrl ? '空闲' : '未配置',
      message: undefined,
    }, false);
    await sidebar?.pushState();
    if (coordinator!.isLeader) await startLeaderSchedules();
  };

  sidebar = new SidebarProvider(
    configurationStore,
    () => status,
    async () => { await synchronize(); },
    async () => coordinator!.notifyConfigurationChanged(),
    rebuildRepository,
  );

  const refreshDirtyDocuments = async () => {
    const previous = dirtyDocumentCount;
    const current = countDirtyDocuments(environment.userDataPath);
    if (current === previous) return;
    dirtyDocumentCount = current;
    await coordinator!.setDirtyDocuments(current);
    if (previous > 0 && current === 0 && retryWhenSafe && coordinator!.isLeader) void synchronize();
  };

  context.subscriptions.push(
    statusBar,
    vscode.window.registerWebviewViewProvider('profileGitSync.sidebar', sidebar),
    vscode.commands.registerCommand('profileGitSync.syncNow', () => void synchronize()),
    vscode.commands.registerCommand('profileGitSync.rebuildRepository', () => void rebuildRepository()),
    vscode.commands.registerCommand('profileGitSync.openSettings', () => vscode.commands.executeCommand('workbench.view.extension.profileGitSync')),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('profileGitSync')) return;
      void configurationStore.saveApplicationSettings().then(async (changed) => {
        if (changed) await coordinator!.notifyConfigurationChanged();
        else await sidebar.pushState();
      }).catch((error: unknown) => {
        applyStatus({ phase: '失败', message: coordinationErrorMessage(error) }, false);
      });
    }),
    vscode.workspace.onDidOpenTextDocument(() => void refreshDirtyDocuments()),
    vscode.workspace.onDidChangeTextDocument(() => void refreshDirtyDocuments()),
    vscode.workspace.onDidSaveTextDocument(() => void refreshDirtyDocuments()),
    vscode.workspace.onDidCloseTextDocument(() => void refreshDirtyDocuments()),
  );

  const onBecameLeader = () => {
    void updateWindowState();
    void startLeaderSchedules();
  };
  const onBecameFollower = () => {
    clearLeaderSchedules();
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
    void updateWindowState();
  };
  const onSyncRequested = () => void synchronize();
  const onStatusChanged = (patch: Partial<RuntimeStatus>) => applyStatus(patch, false);
  const onConfigurationChanged = () => void refreshConfiguration();
  const onWindowsChanged = (safety: WindowSafetySnapshot) => {
    applyStatus({ activeWindows: safety.activeWindows }, coordinator!.isLeader);
    if (!coordinator!.isLeader) return;
    if (safety.dirtyWindows === 0 && safety.unreadableWindows === 0 && retryWhenSafe) {
      void synchronize();
      return;
    }
    if (safety.activeWindows <= 1 && status.phase === '等待其他窗口关闭') void synchronize();
  };
  const onCoordinationError = (error: Error) => applyStatus({ phase: '失败', message: coordinationErrorMessage(error) }, false);

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

  await coordinator.setDirtyDocuments(dirtyDocumentCount);
  await coordinator.start();
  await updateWindowState();
  if (coordinator.isLeader) await startLeaderSchedules();
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
