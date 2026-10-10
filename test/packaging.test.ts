import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';

test('扩展在启动后激活并固定运行于 UI extension host', async () => {
  const manifest = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8')) as {
    name?: string;
    displayName?: string;
    activationEvents?: string[];
    extensionKind?: string[];
    contributes?: { configuration?: { properties?: Record<string, unknown> } };
  };
  assert.equal(manifest.name, 'my-setting-sync');
  assert.equal(manifest.displayName, 'My Setting Sync');
  assert.equal(manifest.activationEvents?.includes('onStartupFinished'), true);
  assert.equal(manifest.activationEvents?.includes('onView:profileGitSync.sidebar'), true);
  assert.deepEqual(manifest.extensionKind, ['ui']);
  assert.equal(manifest.contributes?.configuration?.properties?.['profileGitSync.includeProfileAssociations'], undefined);
});

test('扩展产物不包含 jsonc-parser 的未打包相对加载', async () => {
  const bundle = await readFile(path.join(process.cwd(), 'dist', 'extension.js'), 'utf8');
  assert.doesNotMatch(bundle, /require\w*\(["']\.\/impl\//);
});

test('扩展产物注册云端提交历史命令', async () => {
  const bundle = await readFile(path.join(process.cwd(), 'dist', 'extension.js'), 'utf8');
  assert.match(bundle, /registerCommand\(["']profileGitSync\.showHistory["']/);
});

test('扩展产物包含侧边栏的脚本与样式', async () => {
  // 两者都由 Webview 按路径加载，缺任何一个侧边栏都只剩静态骨架。
  const script = await readFile(path.join(process.cwd(), 'dist', 'webview', 'sidebar.js'), 'utf8');
  assert.match(script, /acquireVsCodeApi\(\)/);
  // 脚本只以 import type 引用扩展侧模块，Node 内置模块不应被打进浏览器产物。
  assert.doesNotMatch(script, /require\(["']node:/);
  assert.match(await readFile(path.join(process.cwd(), 'media', 'sidebar.css'), 'utf8'), /\.history-list/);
});
