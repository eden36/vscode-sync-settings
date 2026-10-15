import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { parseRuntimeState, RuntimeStateStore } from '../src/runtime-state';

test('运行状态解析拒绝结构不符的记录', () => {
  const valid = { schemaVersion: 1, enabled: true, link: 'in-sync', cloudAdoptPending: false };
  assert.deepEqual(parseRuntimeState(valid), valid);
  assert.deepEqual(parseRuntimeState({ ...valid, lastSyncAt: '2026-08-09T04:44:35.000Z' }), {
    ...valid,
    lastSyncAt: '2026-08-09T04:44:35.000Z',
  });
  assert.equal(parseRuntimeState({ ...valid, schemaVersion: 2 }), undefined);
  assert.equal(parseRuntimeState({ ...valid, link: '已同步' }), undefined);
  assert.equal(parseRuntimeState({ ...valid, enabled: 'true' }), undefined);
  assert.equal(parseRuntimeState({ ...valid, lastSyncAt: 12 }), undefined);
  assert.equal(parseRuntimeState(undefined), undefined);
});

test('运行状态在多个窗口之间共享且互不覆盖其他字段', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-runtime-state-'));
  try {
    const first = new RuntimeStateStore(root);
    const second = new RuntimeStateStore(root);
    await first.initialize();
    await second.initialize();

    await first.update({ link: 'in-sync', lastSyncAt: '2026-08-09T04:44:35.000Z' });
    // 第二个窗口在自己的缓存上只改另一个字段，不应把第一个窗口写入的值退回默认。
    await second.update({ cloudAdoptPending: true });

    const third = new RuntimeStateStore(root);
    await third.initialize();
    assert.equal(third.get().link, 'in-sync');
    assert.equal(third.get().lastSyncAt, '2026-08-09T04:44:35.000Z');
    assert.equal(third.get().cloudAdoptPending, true);

    assert.equal(await first.reload(), true);
    assert.equal(first.get().cloudAdoptPending, true);
    assert.equal(await first.reload(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('删除本地仓库后清空上次同步时间', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-runtime-clear-'));
  try {
    const store = new RuntimeStateStore(root);
    await store.initialize();
    await store.update({ link: 'in-sync', lastSyncAt: '2026-08-09T04:44:35.000Z' });
    await store.update({ link: 'no-repository', lastSyncAt: undefined });

    const reopened = new RuntimeStateStore(root);
    await reopened.initialize();
    assert.equal(reopened.get().link, 'no-repository');
    assert.equal(reopened.get().lastSyncAt, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('运行状态保存基准、上次同步的扩展与用户选择', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-baseline-'));
  try {
    const store = new RuntimeStateStore(root);
    await store.initialize();
    const baseline = { localSnapshot: 'l', cloudSnapshot: 'c' };
    await store.update({ baseline, syncedExtensions: ['a.b'], pendingResolution: 'local' });

    const reloaded = new RuntimeStateStore(root);
    await reloaded.initialize();
    assert.deepEqual(reloaded.get().baseline, baseline);
    assert.deepEqual(reloaded.get().syncedExtensions, ['a.b']);
    assert.equal(reloaded.get().pendingResolution, 'local');

    // 显式传 undefined 表示删除，否则用户的选择会一直粘着，下一轮又按它执行一次。
    await store.update({ pendingResolution: undefined, syncedExtensions: ['a.b', 'c.d'] });
    await reloaded.reload();
    assert.equal(reloaded.get().pendingResolution, undefined);
    assert.deepEqual(reloaded.get().syncedExtensions, ['a.b', 'c.d']);
    assert.deepEqual(reloaded.get().baseline, baseline);

    // 残缺的基准与非法的选择一律拒绝，避免据此误判两侧改没改。
    const valid = { schemaVersion: 1, enabled: true, link: 'in-sync', cloudAdoptPending: false };
    assert.ok(parseRuntimeState(valid));
    assert.equal(parseRuntimeState({ ...valid, baseline: { localSnapshot: 'l' } }), undefined);
    assert.equal(parseRuntimeState({ ...valid, pendingResolution: 'both' }), undefined);
    assert.equal(parseRuntimeState({ ...valid, syncedExtensions: [1] }), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('运行状态保存基准里的 Profile 名单与待处理的 Profile 差异', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-profiles-state-'));
  try {
    const store = new RuntimeStateStore(root);
    await store.initialize();
    const baseline = {
      localSnapshot: 'l', cloudSnapshot: 'c', localProfiles: ['开发'], cloudProfiles: ['开发', '工作'],
    };
    const mismatch = { kind: 'cloud-only' as const, names: ['工作'] };
    await store.update({ baseline, profileMismatch: mismatch, profileResolution: mismatch });

    const reloaded = new RuntimeStateStore(root);
    await reloaded.initialize();
    assert.deepEqual(reloaded.get().baseline, baseline);
    assert.deepEqual(reloaded.get().profileMismatch, mismatch);

    // 只有名单不同也要算作变化，否则其他窗口读不到新的基准。
    await store.update({ baseline: { ...baseline, cloudProfiles: ['开发'] }, profileResolution: undefined });
    assert.equal(await reloaded.reload(), true);
    assert.deepEqual(reloaded.get().baseline?.cloudProfiles, ['开发']);
    assert.equal(reloaded.get().profileResolution, undefined);

    const valid = { schemaVersion: 1, enabled: true, link: 'in-sync', cloudAdoptPending: false };
    assert.equal(parseRuntimeState({ ...valid, profileMismatch: { kind: 'other', names: [] } }), undefined);
    assert.equal(parseRuntimeState({ ...valid, profileMismatch: { kind: 'cloud-only', names: [1] } }), undefined);
    assert.equal(parseRuntimeState({ ...valid, baseline: { ...baseline, localProfiles: 'x' } }), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
