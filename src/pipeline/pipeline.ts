import { blockReasonLabel } from '../sidebar-status';
import { finalSyncMessage } from '../sync-message';
import { SyncOutcome } from '../types';
import { Stage, SyncContext } from './types';

/**
 * 顺序执行 stage：进度上报与临时目录之外的细节都收在这里。
 * 只报告发生了什么，链路状态与最终阶段由调度层根据 SyncOutcome 决定。
 */
export async function runPipeline(context: SyncContext, stages: Stage[]): Promise<SyncOutcome> {
  const { updateStatus } = context.dependencies;
  for (const stage of stages) {
    updateStatus({ sync: { kind: 'running', stage: stage.name } });
    const outcome = await stage.run(context);
    if (outcome.kind === 'continue') continue;

    updateStatus({ message: outcome.message ?? blockReasonLabel(outcome.reason) });
    return outcome.reason === 'unrelated'
      ? { ok: false, unrelated: true, blockReason: 'unrelated' }
      : { ok: false, retry: true, blockReason: outcome.reason };
  }

  const report = context.report;
  updateStatus({
    pendingChanges: 0,
    lastSyncAt: new Date().toISOString(),
    message: finalSyncMessage(report),
    ...(report.activeWindows !== undefined ? { activeWindows: report.activeWindows } : {}),
  });
  return {
    ok: true,
    structuralApplied: report.structuralApplied,
    waitingForWindows: report.waitingForWindows,
    ...(report.extensionsPending ? { extensionsPending: report.extensionsPending } : {}),
  };
}
