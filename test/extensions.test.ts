import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseExtensionIds,
  planExtensionSync,
  selectMissingExtensionIds,
  selectRemovableExtensionIds,
} from '../src/extension-manifest';
import { requestExtensionChanges, testing as extensionWaitTesting } from '../src/extension-wait';
import {
  resetExtensionStub,
  markExtensionInstallFailed,
  markExtensionUninstallFailed,
  holdExtensionInstall,
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

test('扩展标识比较不区分大小写，写法不同不会卸了再装', () => {
  assert.deepEqual(selectMissingExtensionIds(['GitHub.Copilot'], ['github.copilot']), []);
  assert.deepEqual(selectRemovableExtensionIds(['github.copilot', 'drop.one'], ['GitHub.Copilot']), ['drop.one']);
});

test('云端没有扩展信息时不清空本机扩展', () => {
  assert.deepEqual(selectRemovableExtensionIds(['a.one', 'b.two'], []), []);
  assert.deepEqual(selectRemovableExtensionIds(['a.one', 'b.two'], ['a.one']), ['b.two']);
});

test('本机新装与卸载的扩展合并进云端清单', () => {
  const plan = planExtensionSync(['keep.one', 'new.two'], ['keep.one', 'drop.three', 'other.four'], ['keep.one', 'drop.three']);
  assert.deepEqual(plan.merged, ['keep.one', 'new.two', 'other.four']);
  assert.deepEqual(plan.install, ['other.four']);
  assert.deepEqual(plan.uninstall, []);
});

test('别的机器删掉的扩展在本机卸载', () => {
  const plan = planExtensionSync(['keep.one', 'gone.two'], ['keep.one'], ['keep.one', 'gone.two']);
  assert.deepEqual(plan.merged, ['keep.one']);
  assert.deepEqual(plan.uninstall, ['gone.two']);
});

test('本机从没装上的扩展保留在云端，不当成本机删除', () => {
  // 装失败、还在装、市场里没有，都不能让云端丢掉它，否则其他机器会跟着卸载。
  const plan = planExtensionSync(['keep.one'], ['keep.one', 'slow.two'], ['keep.one']);
  assert.deepEqual(plan.merged, ['keep.one', 'slow.two']);
  assert.deepEqual(plan.install, ['slow.two']);
  assert.deepEqual(plan.uninstall, []);
});

test('首次同步没有上次记录时两侧取并集，只装不卸', () => {
  const plan = planExtensionSync(['local.one'], ['cloud.two'], undefined);
  assert.deepEqual(plan.merged, ['cloud.two', 'local.one']);
  assert.deepEqual(plan.install, ['cloud.two']);
  assert.deepEqual(plan.uninstall, []);
});

test('合并结果为空时不卸载本机扩展', () => {
  const plan = planExtensionSync(['a.one'], [], ['a.one']);
  assert.deepEqual(plan.merged, []);
  assert.deepEqual(plan.uninstall, []);
});

test('扩展合并不区分大小写', () => {
  const plan = planExtensionSync(['GitHub.Copilot'], ['github.copilot', 'x.removed'], ['github.copilot', 'X.Removed']);
  assert.deepEqual(plan.merged, ['github.copilot']);
  assert.deepEqual(plan.install, []);
  assert.deepEqual(plan.uninstall, []);
});

test('装卸只发命令不等结果，跳过本插件自身', () => {
  resetExtensionStub();
  extensionWaitTesting.reset();
  const release = holdExtensionInstall('slow.one');
  const result = requestExtensionChanges(['slow.one', 'saltcoreyan.my-setting-sync'], ['drop.two']);
  assert.deepEqual(result, { installing: ['slow.one'], uninstalling: ['drop.two'], failed: [] });
  assert.deepEqual(installCommandCalls, ['slow.one']);
  assert.deepEqual(uninstallCommandCalls, ['drop.two']);
  release();
});

test('命令还没返回时下一轮不重发', () => {
  resetExtensionStub();
  extensionWaitTesting.reset();
  const release = holdExtensionInstall('slow.one');
  requestExtensionChanges(['slow.one'], []);
  const again = requestExtensionChanges(['slow.one'], []);
  assert.deepEqual(again.installing, ['slow.one']);
  assert.deepEqual(installCommandCalls, ['slow.one']);
  release();
});

test('装卸失败的扩展本进程内不再重发，只报告失败', async () => {
  resetExtensionStub();
  extensionWaitTesting.reset();
  markExtensionInstallFailed('missing.one');
  markExtensionUninstallFailed('stuck.two');
  requestExtensionChanges(['missing.one'], ['stuck.two']);
  await new Promise((resolve) => setImmediate(resolve));

  const retry = requestExtensionChanges(['missing.one'], ['stuck.two']);
  assert.deepEqual(retry, { installing: [], uninstalling: [], failed: ['stuck.two', 'missing.one'] });
  assert.deepEqual(installCommandCalls, ['missing.one']);
  assert.deepEqual(uninstallCommandCalls, ['stuck.two']);
});

test('装卸命令异步失败时通知调用方，且每个失败的扩展只通知一次', async () => {
  resetExtensionStub();
  extensionWaitTesting.reset();
  markExtensionInstallFailed('missing.one');
  let notified = 0;
  const first = requestExtensionChanges(['missing.one', 'fine.two'], [], () => { notified += 1; });
  // 命令尚未返回时还看不到失败，本轮报告里是空的：只能靠回调让状态层补一轮。
  assert.deepEqual(first.failed, []);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notified, 1);

  // 失败的扩展不再重发，也就不会再次通知，补出来的那一轮不会循环下去。
  const retry = requestExtensionChanges(['missing.one', 'fine.two'], [], () => { notified += 1; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(retry.failed, ['missing.one']);
  assert.equal(notified, 1);
});
