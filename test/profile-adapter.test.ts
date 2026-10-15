import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { ProfileAdapter, testing } from '../src/profile-adapter';

const NAMED_DEVELOP = testing.profileSnapshotId('开发');

/** 一台机器的 User 目录：默认 Profile 加若干命名 Profile，返回各命名 Profile 的磁盘目录。 */
async function machine(root: string, profiles: Record<string, string> = {}) {
  const userDataPath = path.join(root, 'User');
  const runtimePath = path.join(userDataPath, 'globalStorage', 'local.profile-git-sync');
  await mkdir(runtimePath, { recursive: true });
  const locations: Record<string, string> = {};
  for (const [name, location] of Object.entries(profiles)) {
    locations[name] = path.join(userDataPath, 'profiles', location);
    await mkdir(locations[name], { recursive: true });
  }
  await writeFile(path.join(userDataPath, 'globalStorage', 'storage.json'), JSON.stringify({
    userDataProfiles: Object.entries(profiles).map(([name, location]) => ({ location, name })),
  }));
  return { userDataPath, runtimePath, locations };
}

test('快照路径拒绝目录穿越', () => {
  assert.throws(() => testing.normalizeRelative('../settings.json'), /非法相对路径/);
  assert.throws(() => testing.resolveInside('C:\\safe', '..\\secret'), /路径超出允许范围/);
});

test('哈希与 Profile 标识只由内容和名称决定', () => {
  assert.equal(testing.sha256(Buffer.from('配置')), testing.sha256(Buffer.from('配置')));
  assert.equal(testing.profileSnapshotId('开发'), testing.profileSnapshotId('开发'));
  assert.notEqual(testing.profileSnapshotId('开发'), testing.profileSnapshotId('测试'));
  assert.match(testing.profileSnapshotId('a/b\\..'), /^named-[0-9a-f]{16}$/);
});

test('按名称派生命名 Profile 的标识，并恢复文件修改和删除', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-adapter-'));
  try {
    const { userDataPath, runtimePath, locations } = await machine(root, { 开发: 'abc123' });
    const namedPath = locations['开发']!;
    await writeFile(path.join(userDataPath, 'settings.json'), '{"editor.fontSize": 15}');
    await writeFile(path.join(namedPath, 'settings.json'), '{"editor.fontSize": 16}');
    const adapter = new ProfileAdapter({ kind: 'vscode', userDataPath, runtimePath });
    const snapshot = path.join(root, 'snapshot');
    const profiles = await adapter.listProfiles();
    assert.deepEqual(profiles.map((profile) => profile.id), ['default', NAMED_DEVELOP]);
    const manifest = await adapter.createSnapshot(snapshot);
    assert.equal(manifest.schemaVersion, 2);
    assert.equal('profileMetadata' in manifest, false);
    await writeFile(path.join(namedPath, 'settings.json'), '{"editor.fontSize": 99}');
    await writeFile(path.join(namedPath, 'tasks.json'), '{}');
    const restored = await adapter.restoreSnapshot(snapshot);
    assert.equal(await readFile(path.join(namedPath, 'settings.json'), 'utf8'), '{"editor.fontSize": 16}');
    await assert.rejects(readFile(path.join(namedPath, 'tasks.json')), /ENOENT/);
    assert.deepEqual(restored.missingProfiles, []);
    assert.deepEqual(restored.localOnlyProfiles, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('两台机器同名 Profile 的磁盘目录不同也能对应写回', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-adapter-by-name-'));
  try {
    const first = await machine(path.join(root, 'first'), { 开发: 'aaa111' });
    const second = await machine(path.join(root, 'second'), { 开发: 'bbb222' });
    await writeFile(path.join(first.locations['开发']!, 'settings.json'), '{"editor.fontSize": 18}');
    const snapshot = path.join(root, 'snapshot');
    await new ProfileAdapter({ kind: 'vscode', userDataPath: first.userDataPath, runtimePath: first.runtimePath }).createSnapshot(snapshot);

    const restored = await new ProfileAdapter({ kind: 'vscode', userDataPath: second.userDataPath, runtimePath: second.runtimePath })
      .restoreSnapshot(snapshot);
    assert.equal(await readFile(path.join(second.locations['开发']!, 'settings.json'), 'utf8'), '{"editor.fontSize": 18}');
    assert.deepEqual(restored.missingProfiles, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Profile 集合不同时只写回共有 Profile，不改 storage.json、不增删 Profile 目录', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-adapter-mismatch-'));
  try {
    const cloud = await machine(path.join(root, 'cloud'), { 开发: 'aaa111', 工作: 'ccc333' });
    await writeFile(path.join(cloud.locations['工作']!, 'settings.json'), '{"editor.fontSize": 20}');
    await writeFile(path.join(cloud.userDataPath, 'settings.json'), '{"editor.fontSize": 14}');
    const snapshot = path.join(root, 'snapshot');
    await new ProfileAdapter({ kind: 'vscode', userDataPath: cloud.userDataPath, runtimePath: cloud.runtimePath }).createSnapshot(snapshot);

    const local = await machine(path.join(root, 'local'), { 开发: 'bbb222', 本机: 'ddd444' });
    await writeFile(path.join(local.locations['本机']!, 'settings.json'), '{"editor.fontSize": 42}');
    const storagePath = path.join(local.userDataPath, 'globalStorage', 'storage.json');
    const storageBefore = await readFile(storagePath, 'utf8');
    const restored = await new ProfileAdapter({ kind: 'vscode', userDataPath: local.userDataPath, runtimePath: local.runtimePath })
      .restoreSnapshot(snapshot);

    // IDE 运行期间 storage.json 由主进程持有，改写会在它下次落盘时被覆盖，因此一个字节都不能动。
    assert.equal(await readFile(storagePath, 'utf8'), storageBefore);
    assert.deepEqual((await readdir(path.join(local.userDataPath, 'profiles'))).sort(), ['bbb222', 'ddd444']);
    assert.deepEqual(restored.missingProfiles, ['工作']);
    assert.deepEqual(restored.localOnlyProfiles, ['本机']);
    assert.equal(await readFile(path.join(local.userDataPath, 'settings.json'), 'utf8'), '{"editor.fontSize": 14}');
    assert.equal(await readFile(path.join(local.locations['本机']!, 'settings.json'), 'utf8'), '{"editor.fontSize": 42}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('只写回指定名称的 Profile，用于让新建的 Profile 套用云端内容', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-adapter-claim-'));
  try {
    const cloud = await machine(path.join(root, 'cloud'), { 开发: 'aaa111' });
    await writeFile(path.join(cloud.userDataPath, 'settings.json'), '{"editor.fontSize": 14}');
    await writeFile(path.join(cloud.locations['开发']!, 'settings.json'), '{"editor.fontSize": 16}');
    const snapshot = path.join(root, 'snapshot');
    await new ProfileAdapter({ kind: 'vscode', userDataPath: cloud.userDataPath, runtimePath: cloud.runtimePath }).createSnapshot(snapshot);

    const local = await machine(path.join(root, 'local'), { 开发: 'bbb222' });
    await writeFile(path.join(local.userDataPath, 'settings.json'), '{"editor.fontSize": 99}');
    await new ProfileAdapter({ kind: 'vscode', userDataPath: local.userDataPath, runtimePath: local.runtimePath })
      .restoreSnapshot(snapshot, { profileNames: new Set(['开发']) });
    assert.equal(await readFile(path.join(local.locations['开发']!, 'settings.json'), 'utf8'), '{"editor.fontSize": 16}');
    assert.equal(await readFile(path.join(local.userDataPath, 'settings.json'), 'utf8'), '{"editor.fontSize": 99}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('旧版快照的命名 Profile 以磁盘目录为标识，仍按名称对应写回', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-adapter-legacy-ids-'));
  try {
    const local = await machine(root, { 开发: 'bbb222' });
    const snapshot = path.join(root, 'snapshot');
    await mkdir(path.join(snapshot, 'profiles', 'aaa111'), { recursive: true });
    await writeFile(path.join(snapshot, 'profiles', 'aaa111', 'settings.json'), '{"editor.fontSize": 16}');
    await writeFile(path.join(snapshot, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      host: 'vscode',
      createdAt: '',
      profiles: [{ id: 'default', name: '默认', isDefault: true }, { id: 'aaa111', name: '开发', isDefault: false }],
      profileMetadata: [{ location: 'aaa111', name: '开发' }],
      files: { 'profiles/aaa111/settings.json': 'x' },
    }));
    await new ProfileAdapter({ kind: 'vscode', userDataPath: local.userDataPath, runtimePath: local.runtimePath }).restoreSnapshot(snapshot);
    assert.equal(await readFile(path.join(local.locations['开发']!, 'settings.json'), 'utf8'), '{"editor.fontSize": 16}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('工作区关联不进快照', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-adapter-associations-'));
  try {
    const { userDataPath, runtimePath } = await machine(root);
    await writeFile(path.join(userDataPath, 'globalStorage', 'storage.json'), JSON.stringify({
      userDataProfiles: [],
      profileAssociations: { workspaces: { 'file:///d%3A/local': '__default__profile__' } },
    }));
    await writeFile(path.join(userDataPath, 'settings.json'), '{"editor.fontSize": 15}');
    const snapshot = path.join(root, 'snapshot');
    // 工作区路径和空窗口 id 都是本机专属数据，进了快照就会让两台机器永远互相判成有改动。
    const manifest = await new ProfileAdapter({ kind: 'vscode', userDataPath, runtimePath }).createSnapshot(snapshot);
    assert.equal('profileAssociations' in manifest, false);
    const written = JSON.parse(await readFile(path.join(snapshot, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    assert.equal('profileAssociations' in written, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('快捷键按平台分文件存放，写回时取本平台的，没有时兼容旧快照，都没有就保留本机', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-adapter-keybindings-'));
  try {
    const { userDataPath, runtimePath } = await machine(root);
    const keybindings = path.join(userDataPath, 'keybindings.json');
    await writeFile(keybindings, '[{"key":"ctrl+k"}]');
    const windows = new ProfileAdapter({ kind: 'vscode', userDataPath, runtimePath, platform: 'win32' });
    const mac = new ProfileAdapter({ kind: 'vscode', userDataPath, runtimePath, platform: 'darwin' });
    const snapshot = path.join(root, 'snapshot');
    const manifest = await windows.createSnapshot(snapshot);
    assert.equal(typeof manifest.files['profiles/default/keybindings.win32.json'], 'string');
    assert.equal(manifest.files['profiles/default/keybindings.json'], undefined);

    // macOS 上没有本平台的快捷键：保留本机，不能把 Windows 的那份写过来，也不能当成删除。
    await writeFile(keybindings, '[{"key":"cmd+k"}]');
    await mac.restoreSnapshot(snapshot);
    assert.equal(await readFile(keybindings, 'utf8'), '[{"key":"cmd+k"}]');

    // 旧快照只有一份 keybindings.json 时任何平台都照常写回。
    const legacy = path.join(root, 'legacy');
    await mkdir(path.join(legacy, 'profiles', 'default'), { recursive: true });
    await writeFile(path.join(legacy, 'profiles', 'default', 'keybindings.json'), '[{"key":"alt+k"}]');
    await writeFile(path.join(legacy, 'manifest.json'), JSON.stringify({
      schemaVersion: 1, host: 'vscode', createdAt: '', profiles: [{ id: 'default', name: '默认', isDefault: true }],
      files: { 'profiles/default/keybindings.json': 'x' },
    }));
    await mac.restoreSnapshot(legacy);
    assert.equal(await readFile(keybindings, 'utf8'), '[{"key":"alt+k"}]');

    await windows.restoreSnapshot(snapshot);
    assert.equal(await readFile(keybindings, 'utf8'), '[{"key":"ctrl+k"}]');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Cursor 的全局 MCP 配置随快照同步，云端没有时保留本机', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-adapter-host-files-'));
  try {
    const { userDataPath, runtimePath } = await machine(root);
    const mcpPath = path.join(root, '.cursor', 'mcp.json');
    await mkdir(path.dirname(mcpPath), { recursive: true });
    await writeFile(mcpPath, '{"mcpServers":{"a":{}}}');
    const adapter = new ProfileAdapter({ kind: 'cursor', userDataPath, runtimePath, hostFiles: [{ name: 'mcp.json', path: mcpPath }] });
    const snapshot = path.join(root, 'snapshot');
    const manifest = await adapter.createSnapshot(snapshot);
    assert.equal(typeof manifest.files['global/mcp.json'], 'string');

    const before = await adapter.fingerprint();
    await writeFile(mcpPath, '{"mcpServers":{"b":{}}}');
    assert.notEqual(await adapter.fingerprint(), before);
    await adapter.restoreSnapshot(snapshot);
    assert.equal(await readFile(mcpPath, 'utf8'), '{"mcpServers":{"a":{}}}');

    // 旧版本快照不含宿主级文件，不能据此删除本机配置。
    const legacy = path.join(root, 'legacy');
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, 'manifest.json'), JSON.stringify({
      schemaVersion: 1, host: 'cursor', createdAt: '', profiles: [{ id: 'default', name: '默认', isDefault: true }], files: {},
    }));
    await adapter.restoreSnapshot(legacy);
    assert.equal(await readFile(mcpPath, 'utf8'), '{"mcpServers":{"a":{}}}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('快照与指纹按 LF 归一，换行符差异不算改动', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-adapter-eol-'));
  try {
    const { userDataPath, runtimePath } = await machine(root);
    const settings = '{\r\n  "editor.fontSize": 15\r\n}\r\n';
    const snippet = '{\r\n  "循环": { "prefix": "for" }\r\n}\r\n';
    await mkdir(path.join(userDataPath, 'snippets'), { recursive: true });
    await writeFile(path.join(userDataPath, 'settings.json'), settings);
    await writeFile(path.join(userDataPath, 'snippets', 'markdown.json'), snippet);
    const adapter = new ProfileAdapter({ kind: 'vscode', userDataPath, runtimePath });
    const snapshot = path.join(root, 'snapshot');
    const manifest = await adapter.createSnapshot(snapshot);
    assert.equal(
      manifest.files['profiles/default/settings.json'],
      testing.sha256(Buffer.from(settings.replaceAll('\r\n', '\n'), 'utf8')),
    );
    assert.equal(
      manifest.files['profiles/default/snippets/markdown.json'],
      testing.sha256(Buffer.from(snippet.replaceAll('\r\n', '\n'), 'utf8')),
    );
    assert.equal(await readFile(path.join(snapshot, 'profiles', 'default', 'settings.json'), 'utf8'), settings.replaceAll('\r\n', '\n'));

    // 只把本机文件换成 LF，指纹不应变化，否则两台机器的 Git 换行符配置不同就会互相判成有改动。
    const before = await adapter.fingerprint();
    await writeFile(path.join(userDataPath, 'settings.json'), settings.replaceAll('\r\n', '\n'));
    await writeFile(path.join(userDataPath, 'snippets', 'markdown.json'), snippet.replaceAll('\r\n', '\n'));
    assert.equal(await adapter.fingerprint(), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('本机文件原本是 CRLF 时按 CRLF 写回', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-adapter-crlf-'));
  try {
    const { userDataPath, runtimePath } = await machine(root);
    const settingsPath = path.join(userDataPath, 'settings.json');
    const adapter = new ProfileAdapter({ kind: 'vscode', userDataPath, runtimePath });
    await writeFile(settingsPath, '{\n  "editor.fontSize": 18\n}\n');
    const snapshot = path.join(root, 'snapshot');
    await adapter.createSnapshot(snapshot);

    await writeFile(settingsPath, '{\r\n  "editor.fontSize": 12\r\n}\r\n');
    await adapter.restoreSnapshot(snapshot);
    assert.equal(await readFile(settingsPath, 'utf8'), '{\r\n  "editor.fontSize": 18\r\n}\r\n');

    // 内容一致、只差换行符时不应重写文件。
    const restored = await adapter.restoreSnapshot(snapshot);
    assert.deepEqual(restored.changedFiles, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('写回软链接管理的配置时写到链接目标，不替换链接本身', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-adapter-symlink-'));
  try {
    const { userDataPath, runtimePath } = await machine(root);
    const dotfile = path.join(root, 'dotfiles', 'settings.json');
    await mkdir(path.dirname(dotfile), { recursive: true });
    await writeFile(dotfile, '{"editor.fontSize": 18}');
    const settingsPath = path.join(userDataPath, 'settings.json');
    try {
      await symlink(dotfile, settingsPath, 'file');
    } catch {
      // Windows 未开启开发者模式时普通用户不能创建软链接。
      context.skip('当前环境无法创建软链接');
      return;
    }
    const adapter = new ProfileAdapter({ kind: 'vscode', userDataPath, runtimePath });
    const snapshot = path.join(root, 'snapshot');
    await adapter.createSnapshot(snapshot);
    await writeFile(dotfile, '{"editor.fontSize": 99}');
    await adapter.restoreSnapshot(snapshot);
    assert.equal(await readFile(dotfile, 'utf8'), '{"editor.fontSize": 18}');
    assert.equal((await lstat(settingsPath)).isSymbolicLink(), true);
    assert.deepEqual((await readdir(path.dirname(dotfile))).filter((name) => name.includes('.profile-git-sync-')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('快照采集宿主级已安装扩展清单，只保留标识且不写回本机', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-adapter-extensions-'));
  try {
    const { userDataPath, runtimePath } = await machine(root);
    const extensionsRoot = path.join(root, '.cursor', 'extensions');
    const extensionsManifestPath = path.join(extensionsRoot, 'extensions.json');
    await mkdir(extensionsRoot, { recursive: true });
    await writeFile(path.join(userDataPath, 'settings.json'), '{"editor.fontSize": 15}');
    // 真实清单里还有版本号、安装路径和安装时间，这些本机专属字段不应进入仓库。
    await writeFile(extensionsManifestPath, JSON.stringify([
      { identifier: { id: 'ms-python.python', uuid: 'x' }, version: '2024.1.0', location: { path: '/tmp/a' } },
      { identifier: { id: 'anysphere.remote-ssh' }, version: '1.1.14', metadata: { installedTimestamp: 1 } },
      { identifier: { id: 'ms-python.python' }, version: '2024.2.0' },
    ]));

    const adapter = new ProfileAdapter({ kind: 'cursor', userDataPath, runtimePath, extensionsManifestPath });
    const snapshot = path.join(root, 'snapshot');
    const manifest = await adapter.createSnapshot(snapshot);
    assert.equal(typeof manifest.files['extensions.json'], 'string');
    assert.deepEqual(
      JSON.parse(await readFile(path.join(snapshot, 'extensions.json'), 'utf8')),
      [{ identifier: { id: 'anysphere.remote-ssh' } }, { identifier: { id: 'ms-python.python' } }],
    );

    // 版本升级不改变标识集合，因此不应产生新的快照差异。
    const before = manifest.files['extensions.json'];
    await writeFile(extensionsManifestPath, JSON.stringify([
      { identifier: { id: 'ms-python.python' }, version: '2025.9.9' },
      { identifier: { id: 'anysphere.remote-ssh' }, version: '9.9.9' },
    ]));
    const second = await adapter.createSnapshot(path.join(root, 'snapshot2'));
    assert.equal(second.files['extensions.json'], before);

    // 写回只处理 Profile 文件，绝不覆盖 IDE 维护的扩展清单。
    await writeFile(extensionsManifestPath, '{"sentinel": true}');
    await adapter.restoreSnapshot(snapshot);
    assert.equal(await readFile(extensionsManifestPath, 'utf8'), '{"sentinel": true}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('未提供扩展清单路径时快照不含扩展信息', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-adapter-no-extensions-'));
  try {
    const { userDataPath, runtimePath } = await machine(root);
    await writeFile(path.join(userDataPath, 'settings.json'), '{}');
    const adapter = new ProfileAdapter({ kind: 'vscode', userDataPath, runtimePath });
    const manifest = await adapter.createSnapshot(path.join(root, 'snapshot'));
    assert.equal(manifest.files['extensions.json'], undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('旧快照里的 Profile 级扩展清单不写回本机', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-adapter-legacy-extensions-'));
  try {
    const { userDataPath, runtimePath } = await machine(root);
    const snapshot = path.join(root, 'snapshot');
    await mkdir(path.join(snapshot, 'profiles', 'default'), { recursive: true });
    await writeFile(path.join(userDataPath, 'settings.json'), '{}');
    // 0.1.x 版本的云端快照里带 Profile 级 extensions.json，记录的是本机启用状态，跨机器写回会引用本机没有的扩展。
    await writeFile(path.join(snapshot, 'profiles', 'default', 'extensions.json'), '[{"identifier":{"id":"stale.one"}}]');
    await writeFile(path.join(snapshot, 'profiles', 'default', 'settings.json'), '{"editor.fontSize": 21}');
    await writeFile(path.join(snapshot, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      host: 'vscode',
      createdAt: '',
      profiles: [{ id: 'default', name: '默认', isDefault: true }],
      files: { 'profiles/default/extensions.json': 'x', 'profiles/default/settings.json': 'y' },
    }));

    const adapter = new ProfileAdapter({ kind: 'vscode', userDataPath, runtimePath });
    const restored = await adapter.restoreSnapshot(snapshot);
    assert.equal(await readFile(path.join(userDataPath, 'settings.json'), 'utf8'), '{"editor.fontSize": 21}');
    assert.equal(restored.changedFiles.some((file) => file.endsWith('extensions.json')), false);
    await assert.rejects(() => readFile(path.join(userDataPath, 'extensions.json'), 'utf8'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('快照剥离插件自身设置并在写回本机时保留原值', () => {
  const text = '{\n  // 编辑器\n  "editor.fontSize": 14,\n  "profileGitSync.enabled": false\n}';
  const stripped = testing.stripLocalSettings(text);
  assert.match(stripped, /\/\/ 编辑器/);
  assert.doesNotMatch(stripped, /profileGitSync/);
  const restored = testing.restoreLocalSettings(stripped, '{"profileGitSync.enabled": true}');
  assert.match(restored, /"profileGitSync.enabled":\s*true/);
  assert.match(restored, /"editor.fontSize":\s*14/);
  assert.equal(testing.stripLocalSettings('not-json'), 'not-json');
  assert.equal(testing.restoreLocalSettings('{}', 'not-json'), '{}');
});

test('settingsSync.ignoredSettings 列出的设置只属于本机，不进仓库也不被覆盖', () => {
  const local = '{\n  "settingsSync.ignoredSettings": ["python.defaultInterpreterPath", "-editor.fontSize"],\n'
    + '  "python.defaultInterpreterPath": "C:/Python/python.exe",\n  "editor.fontSize": 14\n}';
  const stripped = testing.stripLocalSettings(local);
  assert.doesNotMatch(stripped, /C:\/Python/);
  // 以 - 开头的写法是取消忽略，不是要忽略的键。
  assert.match(stripped, /"editor.fontSize":\s*14/);

  // 另一台机器带来的值不能覆盖本机；本机没有这个键时也不能凭空写入。
  const incoming = '{\n  "settingsSync.ignoredSettings": ["python.defaultInterpreterPath"],\n'
    + '  "python.defaultInterpreterPath": "/usr/bin/python3",\n  "editor.fontSize": 16\n}';
  assert.match(testing.restoreLocalSettings(incoming, local), /"python.defaultInterpreterPath":\s*"C:\/Python\/python.exe"/);
  assert.doesNotMatch(testing.restoreLocalSettings(incoming, '{}'), /python.defaultInterpreterPath":\s*"/);
});

test('本机专属的插件设置变化不会改变同步指纹', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-fingerprint-'));
  try {
    const { userDataPath, runtimePath } = await machine(root);
    const settingsPath = path.join(userDataPath, 'settings.json');
    await writeFile(settingsPath, '{"editor.fontSize": 14}');
    const adapter = new ProfileAdapter({ kind: 'vscode', userDataPath, runtimePath });
    const before = await adapter.fingerprint();
    await writeFile(settingsPath, '{"editor.fontSize": 14, "profileGitSync.pollIntervalSeconds": 900}');
    assert.equal(await adapter.fingerprint(), before);
    await writeFile(settingsPath, '{"editor.fontSize": 16}');
    assert.notEqual(await adapter.fingerprint(), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('写回配置不会在 Profile 目录留下临时文件，残留文件也不进入快照', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-staging-'));
  try {
    const { userDataPath, runtimePath } = await machine(root);
    const snippetsPath = path.join(userDataPath, 'snippets');
    await mkdir(snippetsPath, { recursive: true });
    await writeFile(path.join(userDataPath, 'settings.json'), '{"editor.fontSize": 14}');
    await writeFile(path.join(snippetsPath, 'zh.code-snippets'), '{}');
    await writeFile(path.join(snippetsPath, 'zh.code-snippets.profile-git-sync-1234'), '残留内容');
    const adapter = new ProfileAdapter({ kind: 'vscode', userDataPath, runtimePath });
    const snapshot = path.join(root, 'snapshot');
    const manifest = await adapter.createSnapshot(snapshot);
    assert.deepEqual(Object.keys(manifest.files).filter((file) => file.includes('.profile-git-sync-')), []);

    await writeFile(path.join(userDataPath, 'settings.json'), '{"editor.fontSize": 99}');
    await adapter.restoreSnapshot(snapshot);
    assert.equal(await readFile(path.join(userDataPath, 'settings.json'), 'utf8'), '{"editor.fontSize": 14}');
    assert.deepEqual((await readdir(userDataPath)).filter((name) => name.includes('.profile-git-sync-')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('已安装扩展清单没有变化时复用上次的解析结果', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-extension-cache-'));
  try {
    const { userDataPath, runtimePath } = await machine(root);
    const extensionsManifestPath = path.join(root, 'extensions.json');
    await writeFile(extensionsManifestPath, '[{"identifier":{"id":"b.two"}},{"identifier":{"id":"a.one"}}]');
    const adapter = new ProfileAdapter({ kind: 'vscode', userDataPath, runtimePath, extensionsManifestPath });
    assert.deepEqual(await adapter.listInstalledExtensionIds(), ['a.one', 'b.two']);
    // 调用方修改返回值不能污染缓存。
    (await adapter.listInstalledExtensionIds()).push('c.three');
    assert.deepEqual(await adapter.listInstalledExtensionIds(), ['a.one', 'b.two']);
    await writeFile(extensionsManifestPath, '[{"identifier":{"id":"a.one"}}]');
    const later = new Date(Date.now() + 5_000);
    await utimes(extensionsManifestPath, later, later);
    assert.deepEqual(await adapter.listInstalledExtensionIds(), ['a.one']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('配置备份只保留最近若干份', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-backups-'));
  try {
    for (let index = 0; index < 13; index += 1) {
      const backup = path.join(root, `backup-${index}`);
      await mkdir(backup);
      const time = new Date(Date.UTC(2026, 0, 1) + index * 60_000);
      await utimes(backup, time, time);
    }
    await testing.pruneBackups(root);
    const remaining = (await readdir(root)).sort((left, right) => left.localeCompare(right));
    assert.equal(remaining.length, 10);
    assert.equal(remaining.includes('backup-0'), false);
    assert.equal(remaining.includes('backup-12'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
