import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AiService } from './ai';
import { ConfigurationStore } from './configuration';
import { MultiWindowCoordinator, WindowSafetySnapshot } from './coordinator';
import { GitService } from './git-service';
import { detectHost } from './host';
import { ProfileAdapter } from './profile-adapter';
import { SidebarProvider } from './sidebar';
import { SyncEngine } from './sync-engine';
import { RuntimeStatus, SyncOutcome } from './types';

let coordinator: MultiWindowCoordinator | undefined;
let localTimer: NodeJS.Timeout | undefined;
let remoteTimer: NodeJS.Timeout | undefined;
let startupTimer: NodeJS.Timeout | undefined;
let retryTimer: NodeJS.Timeout | undefined;
const LAST_SYNC_KEY = 'profileGitSync.lastSyncAt';
const OPERATION_RETRY_MS = 5_000;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const environment = detectHost(context);
  await fs.mkdir(environment.runtimePath, { recursive: true });
  const configurationStore = new ConfigurationStore(context);
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
  const git = new GitService(path.join(environment.runtimePath, 'repository'));
  const ai = new AiService();
  let localFingerprint: string | undefined;
  let sidebar: SidebarProvider;
  let activeProgress: vscode.Progress<{ message?: string }> | undefined;
  let syncRunning = false;
  let pendingSync = false;
  let pendingAllowStructural = false;
  let retryWhenSafe = false;
  let scheduleGeneration = 0;
  let leaderSchedulesReady = false;
  let localCheckRunning = false;
  let dirtyDocumentCount = countDirtyDocuments(environment.userDataPath);

  const applyStatus = (patch: Partial<RuntimeStatus>, publish: boolean) => {
    Object.assign(status, patch);
    if (patch.lastSyncAt) void context.globalState.update(LAST_SYNC_KEY, patch.lastSyncAt);
    if (activeProgress && (patch.phase || patch.message)) {
      activeProgress.report({ message: patch.message ?? patch.phase });
    }
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
    git,
    ai,
    configurationStore,
    updateStatus,
    () => coordinator!.windowSafety(),
  );

  const reloadAfterSync = async (outcome: SyncOutcome | undefined) => {
    if (!outcome?.ok || status.phase === '失败') return;
    if (outcome.extensionsPending?.length) {
      const answer = await vscode.window.showWarningMessage(
        `部分扩展尚未安装完成：${outcome.extensionsPending.join('、')}。是否仍重载窗口？`,
        { modal: true },
        '仍要重载',
      );
      if (answer !== '仍要重载') return;
    }
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  };

  const scheduleOperationRetry = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void synchronize();
    }, OPERATION_RETRY_MS);
  };

  const synchronize = async (allowStructural = false): Promise<SyncOutcome | undefined> => {
    if (!coordinator!.isLeader) {
      await coordinator!.requestSync(allowStructural);
      applyStatus({ role: 'follower', message: '同步请求已发送给 leader 窗口。' }, false);
      return undefined;
    }
    if (syncRunning) {
      pendingSync = true;
      pendingAllowStructural ||= allowStructural;
      return undefined;
    }

    syncRunning = true;
    let finalOutcome: SyncOutcome | undefined;
    let completed = false;
    try {
      do {
        const cycleAllowStructural = allowStructural || pendingAllowStructural;
        pendingSync = false;
        pendingAllowStructural = false;
        completed = false;
        let acquired = false;
        let outcome: SyncOutcome | undefined;
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'My Setting Sync',
            cancellable: false,
          },
          async (progress) => {
            activeProgress = progress;
            progress.report({ message: status.phase });
            try {
              acquired = await coordinator!.runExclusive(async () => {
                outcome = await engine.synchronize(cycleAllowStructural);
                localFingerprint = await adapter.fingerprint();
              });
            } finally {
              activeProgress = undefined;
            }
          },
        );
        if (!acquired) {
          applyStatus({ message: '另一窗口正在执行同步，稍后将自动重试。' }, false);
          scheduleOperationRetry();
          break;
        }
        finalOutcome = outcome;
        if (outcome?.retry) {
          retryWhenSafe = true;
          break;
        }
        retryWhenSafe = false;
        completed = outcome !== undefined;
      } while (pendingSync && coordinator!.isLeader);

      if (completed && !pendingSync && !retryWhenSafe) await coordinator!.completeSyncRequests();
      return finalOutcome;
    } finally {
      syncRunning = false;
      if (pendingSync && coordinator!.isLeader && !retryWhenSafe) void synchronize(pendingAllowStructural);
      if (coordinator!.isLeader && !leaderSchedulesReady) void startLeaderSchedules();
    }
  };

  const clearLeaderSchedules = () => {
    scheduleGeneration += 1;
    leaderSchedulesReady = false;
    if (localTimer) clearInterval(localTimer);
    if (remoteTimer) clearInterval(remoteTimer);
    if (startupTimer) clearTimeout(startupTimer);
    localTimer = undefined;
    remoteTimer = undefined;
    startupTimer = undefined;
  };

  const startLeaderSchedules = async () => {
    clearLeaderSchedules();
    if (!coordinator!.isLeader) return;
    const generation = scheduleGeneration;
    localFingerprint = await adapter.fingerprint();
    if (!coordinator!.isLeader || generation !== scheduleGeneration) return;
    leaderSchedulesReady = true;
    const settings = vscode.workspace.getConfiguration('profileGitSync');
    if (!settings.get<boolean>('autoSync', true)) return;
    const debounceMs = settings.get<number>('debounceSeconds', 60) * 1_000;
    const pollMs = settings.get<number>('pollIntervalSeconds', 600) * 1_000;
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
    await sidebar?.pushState();
    if (coordinator!.isLeader) await startLeaderSchedules();
  };

  sidebar = new SidebarProvider(
    configurationStore,
    () => status,
    async () => { await synchronize(); },
    async () => {
      if ((await coordinator!.activeWindowCount()) > 1) {
        updateStatus({ phase: '等待其他窗口关闭', message: '请关闭其他 IDE 窗口后再安全应用。' });
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        '安全应用可能新增或删除本机 Profile，并会先创建备份。是否继续？',
        { modal: true },
        '继续应用',
      );
      if (answer !== '继续应用') return;
      const outcome = await synchronize(true);
      await reloadAfterSync(outcome);
    },
    async () => coordinator!.notifyConfigurationChanged(),
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
    vscode.window.registerWebviewViewProvider('profileGitSync.sidebar', sidebar),
    vscode.commands.registerCommand('profileGitSync.syncNow', synchronize),
    vscode.commands.registerCommand('profileGitSync.openSettings', () => vscode.commands.executeCommand('workbench.view.extension.profileGitSync')),
    vscode.commands.registerCommand('profileGitSync.applyPending', async () => {
      if ((await coordinator!.activeWindowCount()) > 1) {
        void vscode.window.showWarningMessage('请先关闭其他 IDE 窗口，再应用 Profile 结构变化。');
        return;
      }
      const answer = await vscode.window.showWarningMessage('是否应用待处理的 Profile 结构变化？', { modal: true }, '应用');
      if (answer === '应用') {
        const outcome = await synchronize(true);
        await reloadAfterSync(outcome);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('profileGitSync')) return;
      void sidebar.pushState();
      if (coordinator!.isLeader) void startLeaderSchedules();
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
  const onSyncRequested = (allowStructural = false) => void synchronize(allowStructural);
  const onStatusChanged = (patch: Partial<RuntimeStatus>) => applyStatus(patch, false);
  const onConfigurationChanged = () => void refreshConfiguration();
  const onWindowsChanged = (safety: WindowSafetySnapshot) => {
    applyStatus({ activeWindows: safety.activeWindows }, coordinator!.isLeader);
    if (safety.dirtyWindows === 0 && safety.unreadableWindows === 0 && retryWhenSafe && coordinator!.isLeader) {
      void synchronize();
    }
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
}

export async function deactivate(): Promise<void> {
  if (localTimer) clearInterval(localTimer);
  if (remoteTimer) clearInterval(remoteTimer);
  if (startupTimer) clearTimeout(startupTimer);
  if (retryTimer) clearTimeout(retryTimer);
  localTimer = undefined;
  remoteTimer = undefined;
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
