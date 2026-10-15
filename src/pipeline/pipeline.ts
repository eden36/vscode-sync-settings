import { blockReasonLabel } from '../sidebar-status';
import { finalSyncMessage, transferResultOf } from '../sync-message';
import { SyncOutcome } from '../types';
import { Stage, SyncContext } from './types';

/**
 * 顺序执行 stage：进度上报与临时目录之外的细节都收在这里。
 * 只报告发生了什么，链路状态与最终阶段由调度层根据 SyncOutcome 决定。
 */
export async function runPipeline(context: SyncContext, stages: Stage[]): Promise<SyncOutcome> {
  const { isCancellationRequested, updateStatus } = context.dependencies;
  for (const stage of stages) {
    if (isCancellationRequested()) {
      updateStatus({ transferring: false, narrating: false, step: undefined });
      return { ok: false, cancelled: true };
    }
    updateStatus({
      sync: { kind: 'running', stage: stage.name },
      // 点下去的操作从第一步就亮同步标并换当前步骤；自动同步仍等到真正传配置。
      ...(context.narrateSteps ? { transferring: true, narrating: true, step: stage.name } : {}),
    });
    const outcome = await stage.run(context);
    if (isCancellationRequested()) {
      updateStatus({ transferring: false, narrating: false, step: undefined });
      return { ok: false, cancelled: true };
    }
    if (outcome.kind === 'continue') continue;

    updateStatus({ transferring: false, narrating: false, step: undefined, message: outcome.message ?? blockReasonLabel(outcome.reason) });
    // 不同源与「两边都改了」都无法靠重试解决，必须交回调度层询问用户，与其它可自动恢复的阻塞区分开。
    if (outcome.reason === 'unrelated') return { ok: false, unrelated: true, blockReason: 'unrelated' };
    if (outcome.reason === 'both-changed') return { ok: false, bothChanged: true, blockReason: 'both-changed' };
    if (outcome.reason === 'profiles-mismatch') return { ok: false, profilesMismatch: true, blockReason: 'profiles-mismatch' };
    return { ok: false, retry: true, blockReason: outcome.reason };
  }

  const report = context.report;
  const transferResult = transferResultOf(report);
  updateStatus({
    transferring: false,
    narrating: false,
    step: undefined,
    pendingChanges: 0,
    lastSyncAt: new Date().toISOString(),
    message: finalSyncMessage(report),
    ...(transferResult ? { transferResult } : {}),
    ...(report.activeWindows !== undefined ? { activeWindows: report.activeWindows } : {}),
  });
  return { ok: true };
}
