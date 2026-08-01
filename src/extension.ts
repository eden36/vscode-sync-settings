import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AiService } from './ai';
import { ConfigurationStore } from './configuration';
import { MultiWindowCoordinator } from './coordinator';
import { GitService } from './git-service';
import { detectHost } from './host';
import { ProfileAdapter } from './profile-adapter';
import { SidebarProvider } from './sidebar';
import { SyncEngine } from './sync-engine';
import { RuntimeStatus, SyncOutcome } from './types';

let coordinator: MultiWindowCoordinator | undefined;
let localTimer: NodeJS.Timeout | undefined;
let remoteTimer: NodeJS.Timeout | undefined;
const LAST_SYNC_KEY = 'profileGitSync.lastSyncAt';

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
    lastSyncAt: context.globalState.get<string>(LAST_SYNC_KEY)
  };

  coordinator = new MultiWindowCoordinator(path.join(environment.runtimePath, 'coordination'));
  const git = new GitService(path.join(environment.runtimePath, 'repository'));
  const ai = new AiService();
  let localFingerprint = await adapter.fingerprint();
  let sidebar: SidebarProvider;
  let activeProgress: vscode.Progress<{ message?: string }> | undefined;
  const updateStatus = (patch: Partial<RuntimeStatus>) => {
    Object.assign(status, patch);
    if (patch.lastSyncAt) void context.globalState.update(LAST_SYNC_KEY, patch.lastSyncAt);
    if (activeProgress && (patch.phase || patch.message)) {
      activeProgress.report({ message: patch.message ?? patch.phase });
    }
    void sidebar?.pushState();
  };
  const engine = new SyncEngine(
    environment,
    adapter,
    git,
    ai,
    configurationStore,
    updateStatus,
    () => coordinator!.activeWindowCount()
  );

  const reloadAfterSync = async (outcome: SyncOutcome | undefined) => {
    if (!outcome?.ok || status.phase === '失败') return;
    if (outcome.extensionsPending?.length) {
      const answer = await vscode.window.showWarningMessage(
        `部分扩展尚未安装完成：${outcome.extensionsPending.join('、')}。是否仍重载窗口？`,
        { modal: true },
        '仍要重载'
      );
      if (answer !== '仍要重载') return;
    }
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  };

  const synchronize = async (allowStructural = false): Promise<SyncOutcome | undefined> => {
    if (!coordinator!.isLeader) {
      await coordinator!.requestSync();
      updateStatus({ role: 'follower', message: '同步请求已发送给 leader 窗口。' });
      return undefined;
    }
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Profile Git Sync',
        cancellable: false
      },
      async (progress) => {
        activeProgress = progress;
        progress.report({ message: status.phase });
        let outcome: SyncOutcome | undefined;
        try {
          const acquired = await coordinator!.runExclusive(async () => {
            outcome = await engine.synchronize(allowStructural);
            localFingerprint = await adapter.fingerprint();
          });
          if (!acquired) updateStatus({ message: '另一窗口正在执行同步，本次请求已合并。' });
        } finally {
          activeProgress = undefined;
        }
        return outcome;
      }
    );
  };
  const updateWindowState = async () => {
    updateStatus({
      role: coordinator!.isLeader ? 'leader' : 'follower',
      leaderId: coordinator!.isLeader ? coordinator!.instanceId : undefined,
      activeWindows: await coordinator!.activeWindowCount()
    });
  };
  const startLeaderSchedules = () => {
    if (!coordinator!.isLeader) return;
    if (localTimer) clearInterval(localTimer);
    if (remoteTimer) clearInterval(remoteTimer);
    const settings = vscode.workspace.getConfiguration('profileGitSync');
    if (!settings.get<boolean>('autoSync', true)) return;
    const debounceMs = settings.get<number>('debounceSeconds', 60) * 1_000;
    const pollMs = settings.get<number>('pollIntervalSeconds', 600) * 1_000;
    localTimer = setInterval(() => void (async () => {
      const current = await adapter.fingerprint();
      if (current !== localFingerprint) {
        localFingerprint = current;
        await synchronize();
      }
    })(), debounceMs);
    remoteTimer = setInterval(() => void synchronize(), pollMs);
    setTimeout(() => void synchronize(), 1_500);
  };

  sidebar = new SidebarProvider(configurationStore, () => status, async () => { await synchronize(); }, async () => {
    if ((await coordinator!.activeWindowCount()) > 1) {
      updateStatus({ phase: '等待其他窗口关闭', message: '请关闭其他 IDE 窗口后再安全应用。' });
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      '安全应用可能新增或删除本机 Profile，并会先创建备份。是否继续？',
      { modal: true },
      '继续应用'
    );
    if (answer !== '继续应用') return;
    const outcome = await synchronize(true);
    await reloadAfterSync(outcome);
  });
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
      if (event.affectsConfiguration('profileGitSync') && coordinator!.isLeader) startLeaderSchedules();
    })
  );

  const onBecameLeader = () => {
    void updateWindowState();
    startLeaderSchedules();
  };
  const onBecameFollower = () => {
    if (localTimer) clearInterval(localTimer);
    if (remoteTimer) clearInterval(remoteTimer);
    void updateWindowState();
  };
  const onSyncRequested = () => void synchronize();

  coordinator.on('becameLeader', onBecameLeader);
  coordinator.on('becameFollower', onBecameFollower);
  coordinator.on('syncRequested', onSyncRequested);
  context.subscriptions.push({
    dispose: () => {
      coordinator?.off('becameLeader', onBecameLeader);
      coordinator?.off('becameFollower', onBecameFollower);
      coordinator?.off('syncRequested', onSyncRequested);
    }
  });
  await coordinator.start();
  await updateWindowState();
  if (coordinator.isLeader) startLeaderSchedules();
}

export async function deactivate(): Promise<void> {
  if (localTimer) clearInterval(localTimer);
  if (remoteTimer) clearInterval(remoteTimer);
  await coordinator?.dispose();
}
