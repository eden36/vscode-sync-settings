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
  installedExtensionIds,
  markExtensionInstalled,
  markExtensionInstallFailed,
  markExtensionUninstallFailed,
  installCommandCalls,
  uninstallCommandCalls,
} from './vscode-stub';

const options = { timeoutMs: 1_000, pollIntervalMs: 10, listInstalled: installedExtensionIds };

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

test('扩展标识比较不区分大小写，写法不同不会卸了再装', () => {
  assert.deepEqual(selectMissingExtensionIds(['GitHub.Copilot'], ['github.copilot']), []);
  assert.deepEqual(selectRemovableExtensionIds(['github.copilot', 'drop.one'], ['GitHub.Copilot']), ['drop.one']);
});

test('同步后会调用 IDE 安装尚未存在的扩展', async () => {
  resetExtensionStub();
  extensionWaitTesting.resetSkippedInstallIds();
  markExtensionInstalled('already.present');
  const result = await installAndWaitForExtensions(
    ['already.present', 'ms-python.python', 'saltcoreyan.my-setting-sync'],
    options,
  );
  assert.deepEqual(result, { pending: [], failed: [] });
  assert.deepEqual(installCommandCalls, ['ms-python.python']);
});

test('已在清单里的扩展即使被禁用也不再安装', async () => {
  resetExtensionStub();
  extensionWaitTesting.resetSkippedInstallIds();
  // 禁用的扩展在 vscode.extensions 里查不到，但仍在扩展清单文件中，按清单判断就不会反复安装并空等。
  const result = await installAndWaitForExtensions(['disabled.one'], { ...options, listInstalled: async () => ['disabled.one'] });
  assert.deepEqual(result, { pending: [], failed: [] });
  assert.deepEqual(installCommandCalls, []);
});

test('扩展安装失败时记为失败而不是待收敛，本进程内不再重试', async () => {
  resetExtensionStub();
  extensionWaitTesting.resetSkippedInstallIds();
  markExtensionInstallFailed('missing.one');
  const result = await installAndWaitForExtensions(['missing.one', 'ok.two'], options);
  // 装不上的扩展不能留在待收敛名单里，否则扩展清单会一直被排除在改动判定之外。
  assert.deepEqual(result, { pending: [], failed: ['missing.one'] });
  assert.deepEqual(installCommandCalls, ['missing.one', 'ok.two']);
  installCommandCalls.length = 0;
  const retry = await installAndWaitForExtensions(['missing.one', 'ok.two'], options);
  assert.deepEqual(retry, { pending: [], failed: ['missing.one'] });
  assert.deepEqual(installCommandCalls, []);
});

test('安装命令成功但清单里迟迟没有出现时记为待收敛', async () => {
  resetExtensionStub();
  extensionWaitTesting.resetSkippedInstallIds();
  const result = await installAndWaitForExtensions(['slow.one'], { ...options, timeoutMs: 50, listInstalled: async () => [] });
  assert.deepEqual(result, { pending: ['slow.one'], failed: [] });
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
