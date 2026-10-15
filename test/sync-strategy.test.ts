import assert from 'node:assert/strict';
import test from 'node:test';
import { fallbackCommitMessage } from '../src/sync-fallback';
import { finalSyncMessage } from '../src/sync-message';
import { decideCloudAdopt, decideSnapshotChoice } from '../src/sync-strategy';
import { createSyncReport } from '../src/types';

test('强制采用云端时缺快照不得回退为本机推送', () => {
  assert.equal(decideCloudAdopt('sync', true, 'synced', true), 'adopt');
  assert.equal(decideCloudAdopt('sync', true, 'cloned', false), 'missing-cloud');
  assert.equal(decideCloudAdopt('sync', false, 'cloned', true), 'adopt');
  assert.equal(decideCloudAdopt('sync', false, 'cloned', false), 'seed-local');
  assert.equal(decideCloudAdopt('sync', false, 'synced', true), 'merge');
});

test('备份模式任何情况下都不采用云端', () => {
  assert.equal(decideCloudAdopt('backup', true, 'synced', true), 'backup');
  assert.equal(decideCloudAdopt('backup', false, 'cloned', true), 'backup');
  assert.equal(decideCloudAdopt('backup', false, 'synced', false), 'backup');
});

test('AI 不可用时仍可生成稳定的提交信息', () => {
  assert.equal(fallbackCommitMessage('vscode'), 'chore(sync): 同步 VS Code 配置');
  assert.equal(fallbackCommitMessage('cursor'), 'chore(sync): 同步 Cursor 配置');
  assert.equal(fallbackCommitMessage('vscode-insiders'), 'chore(sync): 同步 VS Code Insiders 配置');
});

test('首次接入的状态文案说明已按云端覆盖并提示备份', () => {
  assert.equal(
    finalSyncMessage({ ...createSyncReport('sync'), adoptedCloud: true }),
    '同步完成（已按云端配置覆盖本机；本机原配置已备份到扩展运行目录）。',
  );
  assert.equal(
    finalSyncMessage({
      ...createSyncReport('sync'),
      adoptedCloud: true,
      profileMessage: '云端有本机没有的 Profile：工作，在本机新建同名 Profile 后会自动套用云端配置',
    }),
    '同步完成（已按云端配置覆盖本机；本机原配置已备份到扩展运行目录；云端有本机没有的 Profile：工作，在本机新建同名 Profile 后会自动套用云端配置）。',
  );
});

test('装不上的扩展与推迟的扩展同步写进状态文案', () => {
  assert.equal(
    finalSyncMessage({ ...createSyncReport('sync'), extensionsFailed: ['gone.one'] }),
    '同步完成（部分扩展无法安装或卸载，已跳过：gone.one）。',
  );
  assert.equal(
    finalSyncMessage({ ...createSyncReport('sync'), extensionsDeferred: true }),
    '同步完成（当前窗口不在默认 Profile，扩展将在默认 Profile 的窗口中同步）。',
  );
});

test('备份模式状态文案使用备份完成前缀', () => {
  assert.equal(
    finalSyncMessage({ ...createSyncReport('backup'), changedFileCount: 1, usedAiFallback: true }),
    '备份完成（AI 不可用或结果无效，已使用兜底策略）。',
  );
  assert.equal(finalSyncMessage({ ...createSyncReport('backup'), changedFileCount: 1 }), '备份完成。');
});

test('择一判定只看两侧相对基准有没有改动', () => {
  const baseline = { localSnapshot: 'L', localExtensions: 'LE', cloudSnapshot: 'C', cloudExtensions: 'CE' };
  const digest = (snapshot: string, extensions: string) => ({ snapshot, extensions });
  assert.equal(decideSnapshotChoice(baseline, digest('L', 'LE'), digest('C', 'CE'), { ignoreExtensions: false }), 'none');
  assert.equal(decideSnapshotChoice(baseline, digest('L', 'LE'), digest('C2', 'CE'), { ignoreExtensions: false }), 'cloud');
  assert.equal(decideSnapshotChoice(baseline, digest('L2', 'LE'), digest('C', 'CE'), { ignoreExtensions: false }), 'local');
  assert.equal(decideSnapshotChoice(baseline, digest('L2', 'LE'), digest('C2', 'CE'), { ignoreExtensions: false }), 'conflict');
  // 用户已经选定一方时直接落地，不再询问。
  assert.equal(
    decideSnapshotChoice(baseline, digest('L2', 'LE'), digest('C2', 'CE'), { ignoreExtensions: false, resolution: 'cloud' }),
    'cloud',
  );
  // 扩展还在装卸时，清单变化不算这一侧改过。
  assert.equal(decideSnapshotChoice(baseline, digest('L', 'LE2'), digest('C', 'CE'), { ignoreExtensions: false }), 'local');
  assert.equal(decideSnapshotChoice(baseline, digest('L', 'LE2'), digest('C', 'CE'), { ignoreExtensions: true }), 'none');
  // 没有基准时两侧一致就直接立基准，不一致只能交给用户。
  assert.equal(decideSnapshotChoice(undefined, digest('S', 'E'), digest('S', 'E'), { ignoreExtensions: false }), 'none');
  assert.equal(decideSnapshotChoice(undefined, digest('S', 'E'), digest('S2', 'E'), { ignoreExtensions: false }), 'conflict');
  // 两侧都偏离基准但彼此一致（例如推送后还没记下基准进程就退出了）：没有可选的，不打扰用户。
  assert.equal(decideSnapshotChoice(baseline, digest('S', 'E'), digest('S', 'E'), { ignoreExtensions: false }), 'none');
  assert.equal(decideSnapshotChoice(baseline, digest('S', 'E'), digest('S', 'E2'), { ignoreExtensions: false }), 'conflict');
  assert.equal(decideSnapshotChoice(baseline, digest('S', 'E'), digest('S', 'E2'), { ignoreExtensions: true }), 'none');
});

test('按用户选择处理后的文案说明方向并提示备份', () => {
  assert.equal(
    finalSyncMessage({ ...createSyncReport('sync'), changedFileCount: 1, resolvedConflict: true, snapshotChoice: 'local' }),
    '同步完成（已按你的选择用本机配置覆盖云端；另一份配置已备份到扩展运行目录）。',
  );
  assert.equal(
    finalSyncMessage({ ...createSyncReport('sync'), snapshotChoice: 'cloud' }),
    '同步完成（已按云端配置覆盖本机）。',
  );
  assert.equal(finalSyncMessage({ ...createSyncReport('sync'), snapshotChoice: 'none' }), '配置已是最新。');
});
