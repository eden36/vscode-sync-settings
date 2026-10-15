import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { isOtherPlatformFile, parseManifest, readManifest, snapshotDigest } from '../src/snapshot-conflict';
import { SnapshotManifest } from '../src/types';
import { testManifest } from './helpers';

test('快照清单不是 JSON 时给出中文错误', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-manifest-'));
  try {
    await writeFile(path.join(root, 'manifest.json'), '{ 不是 JSON');
    await assert.rejects(() => readManifest(root), /快照清单不是有效的 JSON/);
    await rm(path.join(root, 'manifest.json'));
    await assert.rejects(() => readManifest(root), /未找到快照清单/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('快照清单缺字段或类型不符时拒绝解析', () => {
  const valid = {
    schemaVersion: 1, host: 'vscode', createdAt: '', profiles: [{ id: 'default', name: '默认', isDefault: true }], files: {},
  };
  assert.equal(parseManifest(valid)?.host, 'vscode');
  assert.equal(parseManifest({ ...valid, schemaVersion: 2 })?.schemaVersion, 2);
  assert.equal(parseManifest({ ...valid, host: 'vscode-insiders' })?.host, 'vscode-insiders');
  assert.equal(parseManifest({ ...valid, schemaVersion: 3 }), undefined);
  assert.equal(parseManifest({ ...valid, host: 'sublime' }), undefined);
  assert.equal(parseManifest({ ...valid, profiles: [{ id: 'x' }] }), undefined);
  assert.equal(parseManifest({ ...valid, files: { 'a.json': 12 } }), undefined);
  assert.equal(parseManifest({ ...valid, files: null }), undefined);
  assert.equal(parseManifest(undefined), undefined);
});

test('快照清单丢弃工作区关联，指纹不受其影响', () => {
  const base = {
    schemaVersion: 1, host: 'vscode', createdAt: '', profiles: [{ id: 'default', name: '默认', isDefault: true }], files: {},
  };
  const local = parseManifest({ ...base, profileAssociations: { workspaces: { 'file:///d%3A/local': '__default__profile__' } } });
  const cloud = parseManifest({ ...base, profileAssociations: { emptyWindows: { '1787144855726': '__default__profile__' } } });
  if (!local || !cloud) throw new Error('清单应当解析成功');
  assert.equal('profileAssociations' in local, false);
  // 旧版本推上去的快照仍带这个字段，解析时丢弃即可，两侧指纹要相同。
  assert.equal(snapshotDigest(local, 'win32').snapshot, snapshotDigest(cloud, 'win32').snapshot);
});

test('快照指纹只比较本平台的快捷键', () => {
  const windows = testManifest({ 'profiles/default/keybindings.win32.json': 'w' });
  const both = testManifest({ 'profiles/default/keybindings.win32.json': 'w', 'profiles/default/keybindings.darwin.json': 'm' });
  // 本机既不写回也不采集其他平台的快捷键，算进来会让两侧永远不一致。
  assert.equal(snapshotDigest(windows, 'win32').snapshot, snapshotDigest(both, 'win32').snapshot);
  assert.notEqual(snapshotDigest(windows, 'darwin').snapshot, snapshotDigest(both, 'darwin').snapshot);
  assert.equal(isOtherPlatformFile('profiles/default/keybindings.darwin.json', 'win32'), true);
  assert.equal(isOtherPlatformFile('profiles/default/keybindings.win32.json', 'win32'), false);
  assert.equal(isOtherPlatformFile('profiles/default/keybindings.json', 'win32'), false);
  assert.equal(isOtherPlatformFile('profiles/default/snippets/keybindings.darwin.json', 'win32'), false);
});

test('快照指纹忽略键序与采集时间，扩展清单单独记录', () => {
  const left = testManifest({ 'profiles/default/settings.json': 'x', 'extensions.json': 'e1' });
  const right: SnapshotManifest = {
    ...left,
    createdAt: '2026-08-18T00:00:00.000Z',
    profileMetadata: [{ name: 'A', location: 'a' }],
    files: { 'extensions.json': 'e2', 'profiles/default/settings.json': 'x' },
  };
  // 两台机器写出的元数据键序可能不同，内容其实一样，不归一就会被判成改动。
  assert.equal(snapshotDigest(left, 'win32').snapshot, snapshotDigest(right, 'win32').snapshot);
  assert.equal(snapshotDigest(left, 'win32').extensions, 'e1');
  assert.equal(snapshotDigest(right, 'win32').extensions, 'e2');
  assert.notEqual(
    snapshotDigest(testManifest({ 'profiles/default/settings.json': 'y' }), 'win32').snapshot,
    snapshotDigest(left, 'win32').snapshot,
  );
});
