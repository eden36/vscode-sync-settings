import assert from 'node:assert/strict';
import test from 'node:test';
import { parseExtensionIds, selectMissingExtensionIds, selectRemovableExtensionIds } from '../src/extension-manifest';
import {
  installAndWaitForExtensions,
  testing as extensionWaitTesting,
  uninstallRemovedExtensions,
} from '../src/extension-wait';
import {
  resetExtensionStub,
  markExtensionInstalled,
  markExtensionInstallFailed,
  markExtensionUninstallFailed,
  installCommandCalls,
  uninstallCommandCalls,
} from './vscode-stub';

test('解析 extensions.json 中的扩展标识', () => {
  assert.deepEqual(parseExtensionIds('[]'), []);
  assert.deepEqual(parseExtensionIds('not-json'), []);
  assert.deepEqual(parseExtensionIds(JSON.stringify([
    { identifier: { id: 'ms-python.python', uuid: 'abc' }, version: '1.0.0' },
    { identifier: { id: 'vscodevim.vim' }, version: '2.0.0' },
    { identifier: {} }
  ])), ['ms-python.python', 'vscodevim.vim']);
});

test('筛选待安装扩展时跳过已安装、需跳过和重复项', () => {
  assert.deepEqual(selectMissingExtensionIds(
    ['ms-python.python', 'vscodevim.vim', 'ms-python.python', 'saltcoreyan.my-setting-sync', ''],
    ['ms-python.python'],
    ['saltcoreyan.my-setting-sync'],
  ), ['vscodevim.vim']);
  assert.deepEqual(selectMissingExtensionIds(['a.b'], ['a.b']), []);
  assert.deepEqual(selectMissingExtensionIds([], ['a.b']), []);
});

test('同步后会调用 IDE 安装尚未存在的扩展', async () => {
  resetExtensionStub();
  extensionWaitTesting.resetSkippedInstallIds();
  markExtensionInstalled('already.present');
  const result = await installAndWaitForExtensions(
    ['already.present', 'ms-python.python', 'saltcoreyan.my-setting-sync'],
    { timeoutMs: 1_000 },
  );
  assert.equal(result.converged, true);
  assert.deepEqual(result.pending, []);
  assert.deepEqual(installCommandCalls, ['ms-python.python']);
});

test('扩展安装失败时不中断同步并记录未完成项', async () => {
  resetExtensionStub();
  extensionWaitTesting.resetSkippedInstallIds();
  markExtensionInstallFailed('missing.one');
  const result = await installAndWaitForExtensions(['missing.one', 'ok.two'], { timeoutMs: 1_000 });
  assert.equal(result.converged, false);
  assert.deepEqual(result.pending, ['missing.one']);
  assert.deepEqual(installCommandCalls, ['missing.one', 'ok.two']);
  installCommandCalls.length = 0;
  const retry = await installAndWaitForExtensions(['missing.one', 'ok.two'], { timeoutMs: 1_000 });
  assert.deepEqual(retry.pending, ['missing.one']);
  assert.deepEqual(installCommandCalls, []);
});

test('云端移除的扩展会在本机卸载', async () => {
  resetExtensionStub();
  extensionWaitTesting.resetSkippedInstallIds();
  const failed = await uninstallRemovedExtensions(
    ['keep.one'],
    ['keep.one', 'drop.two', 'drop.three'],
    { timeoutMs: 1_000 },
  );
  assert.deepEqual(failed, []);
  assert.deepEqual(uninstallCommandCalls, ['drop.two', 'drop.three']);
});

test('卸载不会波及本插件自身和内置扩展', async () => {
  resetExtensionStub();
  extensionWaitTesting.resetSkippedInstallIds();
  // installedIds 只来自扩展清单文件，内置扩展本就不在其中；本插件即使在清单里也必须跳过。
  await uninstallRemovedExtensions(['keep.one'], ['keep.one', 'saltcoreyan.my-setting-sync'], { timeoutMs: 1_000 });
  assert.deepEqual(uninstallCommandCalls, []);
});

test('云端没有扩展信息时不清空本机扩展', () => {
  assert.deepEqual(selectRemovableExtensionIds(['a.one', 'b.two'], []), []);
  assert.deepEqual(selectRemovableExtensionIds(['a.one', 'b.two'], ['a.one']), ['b.two']);
});

test('扩展卸载失败时记录未完成项且本进程不再重试', async () => {
  resetExtensionStub();
  extensionWaitTesting.resetSkippedInstallIds();
  markExtensionUninstallFailed('stuck.one');
  const failed = await uninstallRemovedExtensions(['keep.one'], ['stuck.one', 'drop.two'], { timeoutMs: 1_000 });
  assert.deepEqual(failed, ['stuck.one']);
  assert.deepEqual(uninstallCommandCalls, ['stuck.one', 'drop.two']);

  uninstallCommandCalls.length = 0;
  const retry = await uninstallRemovedExtensions(['keep.one'], ['stuck.one'], { timeoutMs: 1_000 });
  assert.deepEqual(retry, []);
  assert.deepEqual(uninstallCommandCalls, []);
});
