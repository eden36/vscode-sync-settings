import assert from 'node:assert/strict';
import test from 'node:test';
import { displayPhase } from '../src/sidebar-status';
import { reduce, SchedulerEvent, SchedulerMachine } from '../src/scheduler';
import { SyncState } from '../src/types';
import { leaderMachine } from './helpers';

test('关闭同步开关后不再发起任何同步', () => {
  const machine = { ...leaderMachine(), enabled: false, sync: { kind: 'disabled' } as SyncState };
  for (const event of [
    { type: 'sync-requested', source: 'user' },
    { type: 'sync-requested', source: 'timer' },
    { type: 'sync-requested', source: 'startup' },
  ] as SchedulerEvent[]) {
    const { next, commands } = reduce(machine, event);
    assert.deepEqual(commands, []);
    assert.deepEqual(next.sync, { kind: 'disabled' });
  }
});

test('同步进行中关闭开关后等待当前安全操作完成再停止', () => {
  const running: SchedulerMachine = { ...leaderMachine(), sync: { kind: 'running', stage: 'push' } };
  const closed = reduce(running, { type: 'enabled-changed', enabled: false });
  // 仍在 running：已经提交但未推送的安全操作不能被切断。
  assert.deepEqual(closed.next.sync, { kind: 'running', stage: 'push' });
  assert.deepEqual(closed.commands.map((command) => command.type), ['stop-schedules', 'cancel-retry']);

  const finished = reduce(closed.next, { type: 'sync-finished', outcome: { ok: true } });
  assert.deepEqual(finished.next.sync, { kind: 'disabled' });
});

test('取消后重新开启不算失败，并且补跑一轮', () => {
  const running: SchedulerMachine = { ...leaderMachine(), sync: { kind: 'running', stage: 'push' } };
  const closed = reduce(running, { type: 'enabled-changed', enabled: false });
  const reopened = reduce(closed.next, { type: 'enabled-changed', enabled: true });
  const finished = reduce(reopened.next, { type: 'sync-finished', outcome: { ok: false, cancelled: true } });
  assert.deepEqual(finished.next.sync, { kind: 'running', stage: 'snapshot' });
  assert.equal(finished.next.retryAttempt, 0);
  assert.deepEqual(finished.commands, [{ type: 'cancel-retry' }, { type: 'start-sync', adoptCloud: false }]);
});

test('取消的一轮结束时开关仍关着则停在关闭状态', () => {
  const running: SchedulerMachine = { ...leaderMachine(), sync: { kind: 'running', stage: 'push' } };
  const closed = reduce(running, { type: 'enabled-changed', enabled: false });
  const finished = reduce(closed.next, { type: 'sync-finished', outcome: { ok: false, cancelled: true } });
  assert.deepEqual(finished.next.sync, { kind: 'disabled' });
  assert.deepEqual(finished.commands, [{ type: 'stop-schedules' }]);
});

test('follower 上取消的一轮不会自行补跑', () => {
  const running: SchedulerMachine = { ...leaderMachine(), isLeader: false, sync: { kind: 'running', stage: 'push' } };
  const finished = reduce(running, { type: 'sync-finished', outcome: { ok: false, cancelled: true } });
  assert.deepEqual(finished.next.sync, { kind: 'idle' });
  assert.deepEqual(finished.commands, [{ type: 'cancel-retry' }]);
});

test('开启开关后立即同步一次并启动定时器', () => {
  const disabled: SchedulerMachine = { ...leaderMachine(), enabled: false, sync: { kind: 'disabled' } };
  const { next, commands } = reduce(disabled, { type: 'enabled-changed', enabled: true });
  assert.deepEqual(next.sync, { kind: 'idle' });
  assert.deepEqual(commands, [{ type: 'start-schedules' }, { type: 'start-sync', adoptCloud: false }]);
});

test('同步期间的请求排队，结束后再跑一轮', () => {
  const running: SchedulerMachine = { ...leaderMachine(), sync: { kind: 'running', stage: 'choose' } };
  const queued = reduce(running, { type: 'sync-requested', source: 'timer' });
  assert.equal(queued.next.pending, true);
  assert.deepEqual(queued.commands, []);

  const finished = reduce(queued.next, { type: 'sync-finished', outcome: { ok: true } });
  assert.deepEqual(finished.next.sync, { kind: 'running', stage: 'snapshot' });
  assert.deepEqual(finished.commands, [{ type: 'start-sync', adoptCloud: false }]);
});

test('本机变化导致阻塞时自动重试，不依赖已被检测器消费的变化请求', () => {
  for (const pending of [false, true]) {
    const running: SchedulerMachine = { ...leaderMachine(), pending, sync: { kind: 'running', stage: 'apply' } };
    const blocked = reduce(running, { type: 'sync-finished', outcome: { ok: false, retry: true, blockReason: 'local-changed' } });
    assert.deepEqual(blocked.next.sync, { kind: 'blocked', reason: 'local-changed' });
    assert.deepEqual(blocked.commands, [{ type: 'schedule-retry', delayMs: 5_000 }]);
    const retried = reduce(blocked.next, { type: 'sync-requested', source: 'timer' });
    assert.deepEqual(retried.commands, [{ type: 'start-sync', adoptCloud: false }]);
    const finished = reduce(retried.next, { type: 'sync-finished', outcome: { ok: true } });
    assert.deepEqual(finished.commands, [{ type: 'cancel-retry' }, { type: 'complete-sync-requests' }]);
  }
});

test('本机变化阻塞时已关闭、未配置或失去 leader 的窗口不排重试', () => {
  for (const patch of [{ enabled: false }, { configured: false }, { isLeader: false }]) {
    const result = reduce({ ...leaderMachine(), ...patch }, {
      type: 'sync-finished', outcome: { ok: false, retry: true, blockReason: 'local-changed' },
    });
    assert.ok(!result.commands.some((command) => command.type === 'schedule-retry'));
  }
});

test('阻塞是否可自动恢复取决于原因', () => {
  const safe = { activeWindows: 1, dirtyWindows: 0, unreadableWindows: 0 };
  const resolvable: Array<[SchedulerMachine['sync'], boolean]> = [
    [{ kind: 'blocked', reason: 'dirty-windows' }, true],
    [{ kind: 'blocked', reason: 'unreadable-windows' }, true],
    [{ kind: 'blocked', reason: 'profiles-mismatch' }, false],
    [{ kind: 'blocked', reason: 'unrelated' }, false],
    [{ kind: 'blocked', reason: 'exclusive-lock' }, false],
  ];
  for (const [sync, shouldResume] of resolvable) {
    const { commands } = reduce({ ...leaderMachine(), sync }, { type: 'windows-changed', safety: safe });
    assert.deepEqual(commands, shouldResume ? [{ type: 'start-sync', adoptCloud: false }] : []);
  }
});

test('未保存文档仍在时阻塞不解除', () => {
  const blocked: SchedulerMachine = { ...leaderMachine(), sync: { kind: 'blocked', reason: 'dirty-windows' } };
  const { commands } = reduce(blocked, {
    type: 'windows-changed',
    safety: { activeWindows: 2, dirtyWindows: 1, unreadableWindows: 0 },
  });
  assert.deepEqual(commands, []);
});

test('不同源只询问一次，用户拒绝后不再弹窗', () => {
  const first = reduce(leaderMachine(), { type: 'sync-finished', outcome: { ok: false, unrelated: true } });
  assert.deepEqual(first.next.sync, { kind: 'blocked', reason: 'unrelated' });
  assert.equal(first.next.link, 'unrelated');
  assert.deepEqual(first.commands, [{ type: 'prompt-cloud-adopt' }]);

  const declined = reduce(first.next, { type: 'cloud-adopt-declined' });
  assert.deepEqual(reduce(declined.next, { type: 'sync-requested', source: 'timer' }).commands, []);

  // 换了仓库地址后重新允许询问。
  const reconfigured = reduce(declined.next, { type: 'configuration-changed', configured: true, repositoryChanged: true });
  assert.deepEqual(reconfigured.next.sync, { kind: 'idle' });
  assert.equal(reconfigured.next.cloudAdoptPrompted, false);
});

test('用户确认重建时绕过不同源阻塞直接同步', () => {
  const blocked: SchedulerMachine = {
    ...leaderMachine(),
    sync: { kind: 'blocked', reason: 'unrelated' },
    link: 'unrelated',
    cloudAdoptPrompted: true,
  };
  const { next, commands } = reduce(blocked, { type: 'sync-requested', source: 'user', adoptCloud: true });
  assert.deepEqual(next.sync, { kind: 'running', stage: 'snapshot' });
  assert.deepEqual(commands, [{ type: 'start-sync', adoptCloud: true }]);
});

test('抢不到独占锁时按指数退避重试', () => {
  let machine = leaderMachine();
  const delays: number[] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { next, commands } = reduce(machine, { type: 'sync-lock-busy' });
    machine = next;
    const retry = commands.find((command) => command.type === 'schedule-retry');
    if (retry?.type === 'schedule-retry') delays.push(retry.delayMs);
  }
  assert.deepEqual(delays, [5_000, 10_000, 20_000, 40_000, 60_000]);
  assert.deepEqual(machine.sync, { kind: 'blocked', reason: 'exclusive-lock' });

  // 成功一轮后退避重新归零。
  const recovered = reduce(machine, { type: 'sync-finished', outcome: { ok: true } });
  assert.equal(recovered.next.retryAttempt, 0);
  assert.deepEqual(recovered.next.sync, { kind: 'idle' });
});

test('同步失败后按退避自动重试，成功后撤销排下的重试', () => {
  let machine = leaderMachine();
  const delays: number[] = [];
  // 流程报告失败与命令执行抛错两条路径都要排重试。
  const failures: SchedulerEvent[] = [
    { type: 'sync-finished', outcome: { ok: false } },
    { type: 'sync-failed', message: '推送失败' },
    { type: 'sync-finished', outcome: { ok: false } },
    { type: 'sync-finished', outcome: { ok: false } },
    { type: 'sync-finished', outcome: { ok: false } },
    { type: 'sync-finished', outcome: { ok: false } },
  ];
  for (const event of failures) {
    const { next, commands } = reduce(machine, event);
    machine = next;
    assert.deepEqual(machine.sync, { kind: 'failed' });
    assert.deepEqual(commands.map((command) => command.type), ['schedule-retry']);
    const retry = commands[0];
    if (retry?.type === 'schedule-retry') delays.push(retry.delayMs);
  }
  assert.deepEqual(delays, [30_000, 60_000, 120_000, 240_000, 480_000, 600_000]);

  // 重试到点时照常开跑，不会停在失败状态。
  const retried = reduce(machine, { type: 'sync-requested', source: 'timer' });
  assert.deepEqual(retried.commands, [{ type: 'start-sync', adoptCloud: false }]);

  const recovered = reduce(retried.next, { type: 'sync-finished', outcome: { ok: true } });
  assert.equal(recovered.next.retryAttempt, 0);
  assert.deepEqual(recovered.commands, [{ type: 'cancel-retry' }, { type: 'complete-sync-requests' }]);
});

test('无法自行同步的窗口失败后不排重试', () => {
  const unable: SchedulerMachine[] = [
    { ...leaderMachine(), isLeader: false },
    { ...leaderMachine(), enabled: false },
    { ...leaderMachine(), configured: false },
  ];
  for (const machine of unable) {
    assert.deepEqual(reduce(machine, { type: 'sync-failed', message: '失败' }).commands, []);
  }
});

test('follower 收到请求时转交给 leader 而不是自己执行', () => {
  const follower: SchedulerMachine = { ...leaderMachine(), isLeader: false };
  const { next, commands } = reduce(follower, { type: 'sync-requested', source: 'user' });
  assert.deepEqual(commands, [{ type: 'forward-sync-request' }]);
  assert.deepEqual(next.sync, { kind: 'idle' });
});

test('删除本地仓库后链路状态回到没有仓库', () => {
  const synced: SchedulerMachine = { ...leaderMachine(), link: 'in-sync' };
  const { next } = reduce(synced, { type: 'repository-removed' });
  assert.equal(next.link, 'no-repository');
  assert.deepEqual(next.sync, { kind: 'idle' });
  assert.equal(displayPhase(next.sync, next.link), '未同步');
});

test('Profile 不一致时暂停并只弹一次，之后的请求照常开跑以便检测用户是否已处理', () => {
  const blocked = reduce(leaderMachine(), {
    type: 'sync-finished',
    outcome: { ok: false, profilesMismatch: true, blockReason: 'profiles-mismatch' },
  });
  assert.deepEqual(blocked.next.sync, { kind: 'blocked', reason: 'profiles-mismatch' });
  assert.deepEqual(blocked.commands, [{ type: 'prompt-profile-choice' }]);

  // 用户新建或删除 Profile 后由指纹检测发起请求，必须能开跑，否则阻塞永远解不开。
  const again = reduce(blocked.next, { type: 'sync-requested', source: 'timer' });
  assert.deepEqual(again.commands, [{ type: 'start-sync', adoptCloud: false }]);
  const stillBlocked = reduce(again.next, {
    type: 'sync-finished',
    outcome: { ok: false, profilesMismatch: true, blockReason: 'profiles-mismatch' },
  });
  assert.deepEqual(stillBlocked.commands, []);

  // 窗口状态变化解不开这种阻塞。
  const windows = reduce(blocked.next, {
    type: 'windows-changed',
    safety: { activeWindows: 1, dirtyWindows: 0, unreadableWindows: 0 },
  });
  assert.deepEqual(windows.commands, []);

  // 成功一轮后允许下一次差异重新弹窗。
  const recovered = reduce(again.next, { type: 'sync-finished', outcome: { ok: true } });
  assert.equal(recovered.next.profilesPrompted, false);
});

test('两边都改时暂停并只询问一次，选定一方后才继续', () => {
  const blocked = reduce(leaderMachine(), {
    type: 'sync-finished',
    outcome: { ok: false, bothChanged: true, blockReason: 'both-changed' },
  });
  assert.deepEqual(blocked.next.sync, { kind: 'blocked', reason: 'both-changed' });
  assert.deepEqual(blocked.commands, [{ type: 'prompt-version-choice' }]);

  // 没选定一方就重跑只会又撞上同一个冲突，还会反复备份、白占独占锁。
  const again = reduce(blocked.next, { type: 'sync-requested', source: 'timer' });
  assert.deepEqual(again.next.sync, { kind: 'blocked', reason: 'both-changed' });
  assert.deepEqual(again.commands, []);

  const resolved = reduce(blocked.next, { type: 'sync-requested', source: 'user', resolved: true });
  assert.deepEqual(resolved.next.sync, { kind: 'running', stage: 'snapshot' });
  assert.deepEqual(resolved.commands, [{ type: 'start-sync', adoptCloud: false }]);

  // 关掉其他窗口或保存文档都解不开这种阻塞，只有用户选择才行。
  const windows = reduce(blocked.next, {
    type: 'windows-changed',
    safety: { activeWindows: 1, dirtyWindows: 0, unreadableWindows: 0 },
  });
  assert.deepEqual(windows.commands, []);
});
