import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { parseUtilityModelSetting } from '../src/ai-model';
import { hostLabel, isHostKind, resolveHostKind, resolveHostStoragePaths } from '../src/host-paths';

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

test('User Data 布局对不上时不解析存储路径', () => {
  const root = path.join(tmpdir(), 'profile-git-sync-bad-storage');
  const extensionId = 'saltcoreyan.my-setting-sync';
  assert.equal(resolveHostStoragePaths(path.join(root, 'Data', 'globalStorage', extensionId)), undefined);
  assert.equal(resolveHostStoragePaths(path.join(root, 'User', 'storage', extensionId)), undefined);
  assert.equal(resolveHostStoragePaths(''), undefined);
});

test('已上线宿主识别保持原样，Cursor Nightly 仍归入 cursor', () => {
  assert.equal(resolveHostKind('Visual Studio Code'), 'vscode');
  assert.equal(resolveHostKind('Visual Studio Code - Insiders'), 'vscode-insiders');
  assert.equal(resolveHostKind('Cursor'), 'cursor');
  assert.equal(resolveHostKind('Cursor Nightly'), 'cursor');
  assert.equal(resolveHostKind('VSCodium'), 'vscodium');
  assert.equal(resolveHostKind('Windsurf'), 'windsurf');
});

test('未点名的 VS Code 兼容 IDE 按别名或 slug 生成独立宿主，不归入 VS Code', () => {
  assert.equal(resolveHostKind('Antigravity'), 'antigravity');
  assert.equal(resolveHostKind('Antigravity IDE'), 'antigravity');
  assert.equal(resolveHostKind('Google Antigravity'), 'antigravity');
  assert.equal(resolveHostKind('Antigravity IDE - Insider'), 'antigravity-insiders');
  assert.equal(resolveHostKind('Visual Studio Code - Exploration'), 'vscode-exploration');
  assert.equal(resolveHostKind('Trae'), 'trae');
  assert.equal(resolveHostKind('Trae CN'), 'trae-cn');
  assert.equal(resolveHostKind('Positron'), 'positron');
  assert.equal(resolveHostKind('Trae - Insiders'), 'trae-insiders');
  assert.equal(resolveHostKind('A'.repeat(70)), undefined);
  // 原型链键名不能被当成别名命中。
  assert.equal(resolveHostKind('Constructor'), 'constructor');
  assert.equal(resolveHostKind('__proto__'), 'proto');
  assert.equal(resolveHostKind(''), undefined);
  assert.equal(resolveHostKind('   '), undefined);
  assert.equal(resolveHostKind('123'), undefined);
  assert.equal(resolveHostKind('???'), undefined);
});

test('宿主 id 只接受合法 slug', () => {
  assert.equal(isHostKind('vscode'), true);
  assert.equal(isHostKind('trae-cn'), true);
  assert.equal(isHostKind('sublime'), true);
  assert.equal(isHostKind(''), false);
  assert.equal(isHostKind('Sublime'), false);
  assert.equal(isHostKind('-trae'), false);
  assert.equal(isHostKind('trae-'), false);
  assert.equal(isHostKind('trae--cn'), false);
});

test('已知宿主用固定名称，其余优先用应用名原文', () => {
  assert.equal(hostLabel('vscode'), 'VS Code');
  assert.equal(hostLabel('antigravity'), 'Antigravity');
  assert.equal(hostLabel('trae', 'Trae'), 'Trae');
  assert.equal(hostLabel('trae'), 'trae');
  assert.equal(hostLabel('constructor', 'Constructor'), 'Constructor');
  assert.equal(hostLabel(resolveHostKind('Visual Studio Code - Exploration') ?? ''), 'VS Code Exploration');
  assert.equal(hostLabel(resolveHostKind('Antigravity IDE - Insider') ?? ''), 'Antigravity Insiders');
});

test('解析 chat.utilitySmallModel 的 vendor/id 设置', () => {
  assert.deepEqual(parseUtilityModelSetting('copilot/gpt-4o-mini'), {
    vendor: 'copilot',
    id: 'gpt-4o-mini'
  });
  assert.equal(parseUtilityModelSetting(''), undefined);
  assert.equal(parseUtilityModelSetting('invalid'), undefined);
});
