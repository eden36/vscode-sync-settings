import assert from 'node:assert/strict';
import test from 'node:test';
import { SyncSchedules } from '../src/sync-schedules';
import { DEFAULT_CONFIGURATION } from '../src/types';

test('备份收尾只接受已处理的指纹，期间的新改动仍会触发同步', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let local = '已上传';
  const requests: string[] = [];
  const schedules = new SyncSchedules({
    fingerprint: async () => local,
    remoteChanged: async () => assert.fail('备份模式不轮询远端'),
    isLeader: () => true,
    isEnabled: () => true,
    configuration: () => ({ ...DEFAULT_CONFIGURATION, mode: 'backup', debounceSeconds: 5 }),
    requestSync: (source) => { requests.push(source); },
    reportError: (message) => assert.fail(message),
  });
  try {
    await schedules.start();
    local = '推送期间保存的新内容';
    schedules.acceptFingerprint('已上传');
    context.mock.timers.tick(5_000);
    await Promise.resolve();
    assert.deepEqual(requests.filter((source) => source === 'timer'), ['timer']);
    schedules.acceptFingerprint(local);
    context.mock.timers.tick(5_000);
    await Promise.resolve();
    assert.deepEqual(requests.filter((source) => source === 'timer'), ['timer']);
  } finally {
    schedules.dispose();
  }
});

test('写回结果的指纹不触发空跑，之后的用户改动仍会触发', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let local = '写回前';
  const requests: string[] = [];
  const schedules = new SyncSchedules({
    fingerprint: async () => local,
    remoteChanged: async () => false,
    isLeader: () => true,
    isEnabled: () => true,
    configuration: () => ({ ...DEFAULT_CONFIGURATION, mode: 'sync', debounceSeconds: 5 }),
    requestSync: (source) => { requests.push(source); },
    reportError: (message) => assert.fail(message),
  });
  try {
    await schedules.start();
    local = '云端写回结果';
    schedules.acceptFingerprint(local);
    context.mock.timers.tick(5_000);
    await Promise.resolve();
    assert.deepEqual(requests.filter((source) => source === 'timer'), []);
    local = '用户继续修改';
    context.mock.timers.tick(5_000);
    await Promise.resolve();
    assert.deepEqual(requests.filter((source) => source === 'timer'), ['timer']);
  } finally {
    schedules.dispose();
  }
});
