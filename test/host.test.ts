import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { parseUtilityModelSetting } from '../src/ai-model';
import { resolveHostKind, resolveHostStoragePaths } from '../src/host-paths';

test('默认与命名 Profile 解析到同一扩展运行目录，并区分当前窗口所在的 Profile', () => {
  const root = path.join(tmpdir(), 'profile-git-sync-storage');
  const extensionId = 'saltcoreyan.my-setting-sync';
  const expected = {
    userDataPath: path.join(root, 'User'),
    runtimePath: path.join(root, 'User', 'globalStorage', extensionId),
  };
  assert.deepEqual(resolveHostStoragePaths(path.join(root, 'User', 'globalStorage', extensionId)), { ...expected, inDefaultProfile: true });
  assert.deepEqual(
    resolveHostStoragePaths(path.join(root, 'User', 'profiles', 'abc123', 'globalStorage', extensionId)),
    { ...expected, inDefaultProfile: false },
  );
});

test('按应用名识别宿主，认不出的不归入 VS Code', () => {
  assert.equal(resolveHostKind('Visual Studio Code'), 'vscode');
  assert.equal(resolveHostKind('Visual Studio Code - Insiders'), 'vscode-insiders');
  assert.equal(resolveHostKind('Cursor'), 'cursor');
  assert.equal(resolveHostKind('VSCodium'), 'vscodium');
  assert.equal(resolveHostKind('Windsurf'), 'windsurf');
  // 各家扩展市场不同，归到 VS Code 名下会与它互相覆盖快照、反复装卸扩展。
  assert.equal(resolveHostKind('Trae'), undefined);
  assert.equal(resolveHostKind('Visual Studio Code - Exploration'), undefined);
});

test('解析 chat.utilitySmallModel 的 vendor/id 设置', () => {
  assert.deepEqual(parseUtilityModelSetting('copilot/gpt-4o-mini'), {
    vendor: 'copilot',
    id: 'gpt-4o-mini'
  });
  assert.equal(parseUtilityModelSetting(''), undefined);
  assert.equal(parseUtilityModelSetting('invalid'), undefined);
});
