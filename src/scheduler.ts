import { WindowSafetySnapshot } from './coordinator';
import { BlockReason, LinkState, StageName, SyncOutcome, SyncState } from './types';

const OPERATION_RETRY_MS = 5_000;
const MAX_OPERATION_RETRY_MS = 60_000;

/**
 * 调度层的全部状态。除此之外不允许再有描述「该不该同步」的布尔量，
 * 否则重试与阻塞的规则又会散开。
 */
export interface SchedulerMachine {
  sync: SyncState;
  link: LinkState;
  enabled: boolean;
  configured: boolean;
  isLeader: boolean;
  /** 同步进行中又收到请求，跑完后需要再来一轮。 */
  pending: boolean;
  /** 独占锁连续抢占失败的次数，用于指数退避。 */
  retryAttempt: number;
  /** 本轮不同源只询问一次，用户拒绝后不再反复弹窗。 */
  cloudAdoptPrompted: boolean;
  /** 「两边都改了」同样只问一次；用户不选就一直暂停，不写任何一侧。 */
  choicePrompted: boolean;
}

export type SchedulerEvent =
  | { type: 'enabled-changed'; enabled: boolean }
  | { type: 'configuration-changed'; configured: boolean; repositoryChanged: boolean }
  | { type: 'leadership-changed'; isLeader: boolean }
  | { type: 'sync-requested'; source: 'user' | 'peer' | 'timer' | 'startup'; adoptCloud?: boolean; resolved?: boolean }
  | { type: 'sync-progress'; stage: StageName }
  | { type: 'sync-finished'; outcome: SyncOutcome | undefined }
  | { type: 'sync-lock-busy' }
  | { type: 'sync-failed'; message: string }
  | { type: 'windows-changed'; safety: WindowSafetySnapshot }
  | { type: 'cloud-adopt-declined' }
  | { type: 'repository-removed' };

export type SchedulerCommand =
  | { type: 'start-sync'; adoptCloud: boolean }
  | { type: 'forward-sync-request' }
  | { type: 'schedule-retry'; delayMs: number }
  | { type: 'cancel-retry' }
  | { type: 'prompt-cloud-adopt' }
  | { type: 'prompt-version-choice' }
  | { type: 'start-schedules' }
  | { type: 'stop-schedules' }
  | { type: 'complete-sync-requests' }
  | { type: 'reload-window' };

export interface SchedulerTransition {
  next: SchedulerMachine;
  commands: SchedulerCommand[];
}

export function createMachine(options: {
  enabled: boolean;
  configured: boolean;
  link: LinkState;
}): SchedulerMachine {
  return {
    sync: resolveIdleState(options.enabled, options.configured),
    link: options.link,
    enabled: options.enabled,
    configured: options.configured,
    isLeader: false,
    pending: false,
    retryAttempt: 0,
    cloudAdoptPrompted: false,
    choicePrompted: false,
  };
}

/**
 * 调度层唯一的决策函数：给定当前状态与一个事件，得出新状态和要执行的副作用。
 * 不读时钟、不碰磁盘、不引用 vscode，因此可以穷举测试。
 */
export function reduce(machine: SchedulerMachine, event: SchedulerEvent): SchedulerTransition {
  switch (event.type) {
    case 'enabled-changed': {
      if (machine.enabled === event.enabled) return unchanged(machine);
      if (!event.enabled) {
        // 同步中途关闭不打断当前这一轮，否则可能停在已提交未推送的中间态。
        const next = { ...machine, enabled: false, pending: false, cloudAdoptPrompted: false, choicePrompted: false };
        if (machine.sync.kind === 'running') return { next, commands: [{ type: 'stop-schedules' }, { type: 'cancel-retry' }] };
        return {
          next: { ...next, sync: { kind: 'disabled' }, retryAttempt: 0 },
          commands: [{ type: 'stop-schedules' }, { type: 'cancel-retry' }],
        };
      }
      const next: SchedulerMachine = {
        ...machine,
        enabled: true,
        sync: resolveIdleState(true, machine.configured),
        retryAttempt: 0,
        cloudAdoptPrompted: false,
        choicePrompted: false,
      };
      const commands: SchedulerCommand[] = [{ type: 'start-schedules' }];
      if (machine.configured && machine.isLeader) commands.push({ type: 'start-sync', adoptCloud: false });
      return { next, commands };
    }

    case 'configuration-changed': {
      const next: SchedulerMachine = {
        ...machine,
        configured: event.configured,
        // 换了仓库或分支，之前的不同源与择一判断都不再适用，允许重新询问。
        cloudAdoptPrompted: event.repositoryChanged ? false : machine.cloudAdoptPrompted,
        choicePrompted: event.repositoryChanged ? false : machine.choicePrompted,
      };
      if (machine.sync.kind === 'running') return { next, commands: [] };
      if (event.repositoryChanged && machine.sync.kind === 'blocked' && machine.sync.reason === 'unrelated') {
        return { next: { ...next, sync: resolveIdleState(next.enabled, next.configured) }, commands: [] };
      }
      if (machine.sync.kind === 'blocked' || machine.sync.kind === 'failed') return { next, commands: [] };
      return { next: { ...next, sync: resolveIdleState(next.enabled, next.configured) }, commands: [] };
    }

    case 'leadership-changed': {
      if (machine.isLeader === event.isLeader) return unchanged(machine);
      const next = { ...machine, isLeader: event.isLeader };
      if (!event.isLeader) {
        return { next: { ...next, pending: false }, commands: [{ type: 'stop-schedules' }, { type: 'cancel-retry' }] };
      }
      return { next, commands: machine.enabled ? [{ type: 'start-schedules' }] : [] };
    }

    case 'sync-requested': {
      if (!machine.enabled) return unchanged(machine);
      if (!machine.configured) {
        return { next: { ...machine, sync: { kind: 'unconfigured' } }, commands: [] };
      }
      if (!machine.isLeader) return { next: machine, commands: [{ type: 'forward-sync-request' }] };
      if (machine.sync.kind === 'running') return { next: { ...machine, pending: true }, commands: [] };

      // 不同源必须先由用户决定是否重建，重试本身无法解决。
      if (machine.sync.kind === 'blocked' && machine.sync.reason === 'unrelated' && !event.adoptCloud) {
        if (machine.cloudAdoptPrompted) return unchanged(machine);
        return { next: { ...machine, cloudAdoptPrompted: true }, commands: [{ type: 'prompt-cloud-adopt' }] };
      }

      // 两边都改过时不选定一方就重跑，只会又跑到同一个冲突上并反复备份，白占独占锁。
      if (machine.sync.kind === 'blocked' && machine.sync.reason === 'both-changed' && !event.resolved) {
        if (machine.choicePrompted) return unchanged(machine);
        return { next: { ...machine, choicePrompted: true }, commands: [{ type: 'prompt-version-choice' }] };
      }
      return {
        next: { ...machine, sync: { kind: 'running', stage: 'snapshot' }, pending: false },
        commands: [{ type: 'start-sync', adoptCloud: event.adoptCloud === true }],
      };
    }

    case 'sync-progress': {
      if (machine.sync.kind !== 'running') return unchanged(machine);
      return { next: { ...machine, sync: { kind: 'running', stage: event.stage } }, commands: [] };
    }

    case 'sync-lock-busy': {
      const attempt = machine.retryAttempt + 1;
      return {
        next: { ...machine, sync: { kind: 'blocked', reason: 'exclusive-lock' }, retryAttempt: attempt, pending: false },
        commands: [{ type: 'schedule-retry', delayMs: retryDelayMs(attempt) }],
      };
    }

    case 'sync-failed': {
      return { next: { ...machine, sync: { kind: 'failed' }, pending: false }, commands: [] };
    }

    case 'sync-finished': {
      return finishSync(machine, event.outcome);
    }

    case 'windows-changed': {
      if (machine.sync.kind !== 'blocked' || !machine.isLeader || !machine.enabled) return unchanged(machine);
      if (!isResolvedBlock(machine.sync.reason, event.safety)) return unchanged(machine);
      return {
        next: { ...machine, sync: { kind: 'running', stage: 'snapshot' } },
        commands: [{ type: 'start-sync', adoptCloud: false }],
      };
    }

    case 'cloud-adopt-declined': {
      return {
        next: { ...machine, sync: { kind: 'blocked', reason: 'unrelated' }, link: 'unrelated', cloudAdoptPrompted: true },
        commands: [],
      };
    }

    case 'repository-removed': {
      return {
        next: {
          ...machine,
          link: 'no-repository',
          cloudAdoptPrompted: false,
          choicePrompted: false,
          sync: resolveIdleState(machine.enabled, machine.configured),
        },
        commands: [],
      };
    }
  }
}

function finishSync(machine: SchedulerMachine, outcome: SyncOutcome | undefined): SchedulerTransition {
  // 同步期间用户关掉了开关：这一轮已经跑完，此时才真正停下。
  if (!machine.enabled) {
    return { next: { ...machine, sync: { kind: 'disabled' }, pending: false, retryAttempt: 0 }, commands: [{ type: 'stop-schedules' }] };
  }
  if (!outcome) {
    return { next: { ...machine, sync: resolveIdleState(machine.enabled, machine.configured), pending: false }, commands: [] };
  }

  // 用户主动停止后又重新开启：这一轮是被取消而不是失败，不能落到 failed 让状态卡住。
  if (outcome.cancelled) {
    const next: SchedulerMachine = {
      ...machine,
      sync: resolveIdleState(machine.enabled, machine.configured),
      pending: false,
      retryAttempt: 0,
    };
    // 开关又开着说明用户要的是继续同步。被取消的这一轮什么都没做完，且期间排下的退避重试会被 cancel-retry 清掉，
    // 此处不补一轮就要等到下次远程轮询或本机指纹变化，备份模式没有远程轮询，可能长时间不同步。
    if (machine.enabled && machine.configured && machine.isLeader) {
      return {
        next: { ...next, sync: { kind: 'running', stage: 'snapshot' } },
        commands: [{ type: 'cancel-retry' }, { type: 'start-sync', adoptCloud: false }],
      };
    }
    return { next, commands: [{ type: 'cancel-retry' }] };
  }

  if (outcome.bothChanged) {
    const next: SchedulerMachine = {
      ...machine,
      sync: { kind: 'blocked', reason: 'both-changed' },
      pending: false,
      retryAttempt: 0,
    };
    if (machine.choicePrompted) return { next, commands: [] };
    return { next: { ...next, choicePrompted: true }, commands: [{ type: 'prompt-version-choice' }] };
  }

  if (outcome.unrelated) {
    const next: SchedulerMachine = {
      ...machine,
      sync: { kind: 'blocked', reason: 'unrelated' },
      link: 'unrelated',
      pending: false,
      retryAttempt: 0,
    };
    if (machine.cloudAdoptPrompted) return { next, commands: [] };
    return { next: { ...next, cloudAdoptPrompted: true }, commands: [{ type: 'prompt-cloud-adopt' }] };
  }

  if (outcome.retry) {
    return {
      next: {
        ...machine,
        sync: { kind: 'blocked', reason: outcome.blockReason ?? 'dirty-windows' },
        pending: false,
        retryAttempt: 0,
      },
      commands: [],
    };
  }

  if (!outcome.ok) {
    return { next: { ...machine, sync: { kind: 'failed' }, pending: false, retryAttempt: 0 }, commands: [] };
  }

  const next: SchedulerMachine = {
    ...machine,
    sync: outcome.waitingForWindows ? { kind: 'blocked', reason: 'other-windows' } : { kind: 'idle' },
    link: 'in-sync',
    pending: false,
    retryAttempt: 0,
    cloudAdoptPrompted: false,
    choicePrompted: false,
  };
  // 窗口即将重载，此时再开一轮同步会被中途掐断，可能留下已提交未推送的中间态。
  // 排队中的请求不在这里消费，重载后由 leader 重新认领并触发启动同步。
  if (outcome.structuralApplied) {
    return { next: { ...next, pending: false }, commands: [{ type: 'reload-window' }] };
  }
  if (machine.pending && machine.isLeader) {
    return {
      next: { ...next, sync: { kind: 'running', stage: 'snapshot' } },
      commands: [{ type: 'start-sync', adoptCloud: false }],
    };
  }
  return { next, commands: [{ type: 'complete-sync-requests' }] };
}

/** 阻塞原因决定了它能否被窗口状态变化解除；退避重试和用户决策不在此列。 */
function isResolvedBlock(reason: BlockReason, safety: WindowSafetySnapshot): boolean {
  switch (reason) {
    case 'dirty-windows': return safety.dirtyWindows === 0;
    case 'unreadable-windows': return safety.unreadableWindows === 0;
    case 'other-windows': return safety.activeWindows <= 1;
    case 'unrelated':
    case 'both-changed':
    // 本机在同步期间被改动：本机检测的下一拍会重新发起，窗口状态变化与它无关。
    case 'local-changed':
    case 'exclusive-lock':
      return false;
  }
}

function retryDelayMs(attempt: number): number {
  return Math.min(OPERATION_RETRY_MS * 2 ** (attempt - 1), MAX_OPERATION_RETRY_MS);
}

function resolveIdleState(enabled: boolean, configured: boolean): SyncState {
  if (!enabled) return { kind: 'disabled' };
  return configured ? { kind: 'idle' } : { kind: 'unconfigured' };
}

function unchanged(machine: SchedulerMachine): SchedulerTransition {
  return { next: machine, commands: [] };
}
