import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { ProfileAdapter, testing } from '../src/profile-adapter';

test('快照路径拒绝目录穿越', () => {
  assert.throws(() => testing.normalizeRelative('../settings.json'), /非法相对路径/);
  assert.throws(() => testing.resolveInside('C:\\safe', '..\\secret'), /路径超出允许范围/);
});

test('集合比较与哈希结果稳定', () => {
  assert.equal(testing.setsEqual(new Set(['a', 'b']), new Set(['b', 'a'])), true);
  assert.equal(testing.setsEqual(new Set(['a']), new Set(['b'])), false);
  assert.equal(testing.sha256(Buffer.from('配置')), testing.sha256(Buffer.from('配置')));
});

test('按 location 枚举命名 Profile，并恢复文件修改和删除', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-adapter-'));
  const userDataPath = path.join(root, 'User');
  const runtimePath = path.join(userDataPath, 'globalStorage', 'local.profile-git-sync');
  const namedPath = path.join(userDataPath, 'profiles', 'abc123');
  await Promise.all([mkdir(runtimePath, { recursive: true }), mkdir(namedPath, { recursive: true })]);
  await writeFile(path.join(userDataPath, 'globalStorage', 'storage.json'), JSON.stringify({
    userDataProfiles: [{ location: 'abc123', name: '开发', useDefaultFlags: { tasks: true } }]
  }));
  await writeFile(path.join(userDataPath, 'settings.json'), '{"editor.fontSize": 15}');
  await writeFile(path.join(namedPath, 'settings.json'), '{"editor.fontSize": 16}');
  const adapter = new ProfileAdapter({ kind: 'vscode', userDataPath, runtimePath });
  const snapshot = path.join(root, 'snapshot');
  try {
    const profiles = await adapter.listProfiles();
    assert.deepEqual(profiles.map((profile) => profile.id), ['default', 'abc123']);
    await adapter.createSnapshot(snapshot);
    await writeFile(path.join(namedPath, 'settings.json'), '{"editor.fontSize": 99}');
    await writeFile(path.join(namedPath, 'tasks.json'), '{}');
    const restored = await adapter.restoreSnapshot(snapshot, false);
    assert.equal(await readFile(path.join(namedPath, 'settings.json'), 'utf8'), '{"editor.fontSize": 16}');
    await assert.rejects(readFile(path.join(namedPath, 'tasks.json')), /ENOENT/);
    assert.equal(restored.structuralChange, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('工作区关联不进快照，恢复 Profile 结构也不覆盖本机关联', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-adapter-associations-'));
  const userDataPath = path.join(root, 'User');
  const runtimePath = path.join(userDataPath, 'globalStorage', 'local.profile-git-sync');
  const storagePath = path.join(userDataPath, 'globalStorage', 'storage.json');
  const associations = {
    workspaces: { 'file:///d%3A/local': '__default__profile__' },
    emptyWindows: { '1787144855726': '__default__profile__' },
  };
  await mkdir(runtimePath, { recursive: true });
  await writeFile(storagePath, JSON.stringify({ userDataProfiles: [], profileAssociations: associations }));
  await writeFile(path.join(userDataPath, 'settings.json'), '{"editor.fontSize": 15}');
  const adapter = new ProfileAdapter({ kind: 'vscode', userDataPath, runtimePath });
  const snapshot = path.join(root, 'snapshot');
  try {
    // 工作区路径和空窗口 id 都是本机专属数据，进了快照就会让两台机器永远互相判成有改动。
    const manifest = await adapter.createSnapshot(snapshot);
    assert.equal('profileAssociations' in manifest, false);
    const written = JSON.parse(await readFile(path.join(snapshot, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    assert.equal('profileAssociations' in written, false);

    await writeFile(path.join(snapshot, 'manifest.json'), JSON.stringify({
      ...manifest,
      profiles: [...manifest.profiles, { id: 'abc123', name: '开发', isDefault: false }],
      profileMetadata: [{ location: 'abc123', name: '开发' }],
      profileAssociations: { workspaces: { 'file:///d%3A/remote': '__default__profile__' } },
    }, null, 2));
    const restored = await adapter.restoreSnapshot(snapshot, true);
    assert.equal(restored.structuralApplied, true);
    const storage = JSON.parse(await readFile(storagePath, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(storage.profileAssociations, associations);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('快照与指纹按 LF 归一，换行符差异不算改动', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-adapter-eol-'));
  const userDataPath = path.join(root, 'User');
  const runtimePath = path.join(userDataPath, 'globalStorage', 'local.profile-git-sync');
  const settings = '{\r\n  "editor.fontSize": 15\r\n}\r\n';
  const snippet = '{\r\n  "循环": { "prefix": "for" }\r\n}\r\n';
  await Promise.all([mkdir(runtimePath, { recursive: true }), mkdir(path.join(userDataPath, 'snippets'), { recursive: true })]);
  await writeFile(path.join(userDataPath, 'settings.json'), settings);
  await writeFile(path.join(userDataPath, 'snippets', 'markdown.json'), snippet);
  const adapter = new ProfileAdapter({ kind: 'vscode', userDataPath, runtimePath });
  const snapshot = path.join(root, 'snapshot');
  try {
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

test('换行符归一只改写 CRLF，其余内容原样返回', () => {
  assert.equal(testing.normalizeLineEndings(Buffer.from('a\r\nb\r\n', 'utf8')).toString('utf8'), 'a\nb\n');
  const untouched = Buffer.from('a\rb\nc', 'utf8');
  assert.equal(testing.normalizeLineEndings(untouched), untouched);
});

test('换行符归一跳过二进制内容', () => {
  // 0xff 不是合法 UTF-8，解码再编码会被替换成 U+FFFD；含 NUL 的内容必须一个字节都不动。
  const binary = Buffer.from([0x89, 0x50, 0x00, 0xff, 0x0d, 0x0a, 0x1a]);
  assert.equal(testing.normalizeLineEndings(binary), binary);
});

test('快照采集宿主级已安装扩展清单，只保留标识且不写回本机', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-adapter-extensions-'));
  const userDataPath = path.join(root, 'User');
  const runtimePath = path.join(userDataPath, 'globalStorage', 'local.profile-git-sync');
  const extensionsRoot = path.join(root, '.cursor', 'extensions');
  const extensionsManifestPath = path.join(extensionsRoot, 'extensions.json');
  await Promise.all([mkdir(runtimePath, { recursive: true }), mkdir(extensionsRoot, { recursive: true })]);
  await writeFile(path.join(userDataPath, 'settings.json'), '{"editor.fontSize": 15}');
  // 真实清单里还有版本号、安装路径和安装时间，这些本机专属字段不应进入仓库。
  await writeFile(extensionsManifestPath, JSON.stringify([
    { identifier: { id: 'ms-python.python', uuid: 'x' }, version: '2024.1.0', location: { path: '/tmp/a' } },
    { identifier: { id: 'anysphere.remote-ssh' }, version: '1.1.14', metadata: { installedTimestamp: 1 } },
    { identifier: { id: 'ms-python.python' }, version: '2024.2.0' },
  ]));

  const adapter = new ProfileAdapter({ kind: 'cursor', userDataPath, runtimePath, extensionsManifestPath });
  const snapshot = path.join(root, 'snapshot');
  try {
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
    await adapter.restoreSnapshot(snapshot, false);
    assert.equal(await readFile(extensionsManifestPath, 'utf8'), '{"sentinel": true}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('未提供扩展清单路径时快照不含扩展信息', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-adapter-no-extensions-'));
  const userDataPath = path.join(root, 'User');
  const runtimePath = path.join(userDataPath, 'globalStorage', 'local.profile-git-sync');
  await mkdir(runtimePath, { recursive: true });
  await writeFile(path.join(userDataPath, 'settings.json'), '{}');
  try {
    const adapter = new ProfileAdapter({ kind: 'vscode', userDataPath, runtimePath });
    const manifest = await adapter.createSnapshot(path.join(root, 'snapshot'));
    assert.equal(manifest.files['extensions.json'], undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('旧快照里的 Profile 级扩展清单不写回本机', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-adapter-legacy-extensions-'));
  const userDataPath = path.join(root, 'User');
  const runtimePath = path.join(userDataPath, 'globalStorage', 'local.profile-git-sync');
  const snapshot = path.join(root, 'snapshot');
  await mkdir(runtimePath, { recursive: true });
  await mkdir(path.join(snapshot, 'profiles', 'default'), { recursive: true });
  await writeFile(path.join(userDataPath, 'settings.json'), '{}');
  try {
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
    const restored = await adapter.restoreSnapshot(snapshot, false);
    assert.equal(await readFile(path.join(userDataPath, 'settings.json'), 'utf8'), '{"editor.fontSize": 21}');
    assert.equal(restored.changedFiles.some((file) => file.endsWith('extensions.json')), false);
    await assert.rejects(() => readFile(path.join(userDataPath, 'extensions.json'), 'utf8'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('结构变化且不允许应用时默认不写回任何文件', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-adapter-blocked-'));
  const userDataPath = path.join(root, 'User');
  const runtimePath = path.join(userDataPath, 'globalStorage', 'local.profile-git-sync');
  const namedPath = path.join(userDataPath, 'profiles', 'abc123');
  await Promise.all([mkdir(runtimePath, { recursive: true }), mkdir(namedPath, { recursive: true })]);
  await writeFile(path.join(userDataPath, 'globalStorage', 'storage.json'), JSON.stringify({
    userDataProfiles: [{ location: 'abc123', name: '开发' }]
  }));
  await writeFile(path.join(userDataPath, 'settings.json'), '{"editor.fontSize": 15}');
  await writeFile(path.join(namedPath, 'settings.json'), '{"editor.fontSize": 16}');
  const adapter = new ProfileAdapter({ kind: 'vscode', userDataPath, runtimePath });
  const snapshot = path.join(root, 'snapshot');
  try {
    await adapter.createSnapshot(snapshot);
    await writeFile(path.join(userDataPath, 'globalStorage', 'storage.json'), JSON.stringify({
      userDataProfiles: [
        { location: 'abc123', name: '开发' },
        { location: 'extra456', name: '额外' },
      ]
    }));
    await writeFile(path.join(userDataPath, 'settings.json'), '{"editor.fontSize": 99}');
    const restored = await adapter.restoreSnapshot(snapshot, false);
    assert.equal(restored.structuralChange, true);
    assert.equal(restored.structuralApplied, false);
    assert.equal(restored.changedFiles.length, 0);
    assert.equal(await readFile(path.join(userDataPath, 'settings.json'), 'utf8'), '{"editor.fontSize": 99}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('结构变化被窗口拦住时仍可覆盖共有 Profile 的文件', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-adapter-matching-'));
  const userDataPath = path.join(root, 'User');
  const runtimePath = path.join(userDataPath, 'globalStorage', 'local.profile-git-sync');
  const namedPath = path.join(userDataPath, 'profiles', 'abc123');
  const extraPath = path.join(userDataPath, 'profiles', 'extra456');
  await Promise.all([
    mkdir(runtimePath, { recursive: true }),
    mkdir(namedPath, { recursive: true }),
    mkdir(extraPath, { recursive: true }),
  ]);
  await writeFile(path.join(userDataPath, 'globalStorage', 'storage.json'), JSON.stringify({
    userDataProfiles: [{ location: 'abc123', name: '开发' }]
  }));
  await writeFile(path.join(userDataPath, 'settings.json'), '{"editor.fontSize": 15}');
  await writeFile(path.join(namedPath, 'settings.json'), '{"editor.fontSize": 16}');
  const adapter = new ProfileAdapter({ kind: 'vscode', userDataPath, runtimePath });
  const snapshot = path.join(root, 'snapshot');
  try {
    await adapter.createSnapshot(snapshot);
    await writeFile(path.join(userDataPath, 'globalStorage', 'storage.json'), JSON.stringify({
      userDataProfiles: [
        { location: 'abc123', name: '开发' },
        { location: 'extra456', name: '额外' },
      ]
    }));
    await writeFile(path.join(userDataPath, 'settings.json'), '{"editor.fontSize": 99}');
    await writeFile(path.join(namedPath, 'settings.json'), '{"editor.fontSize": 99}');
    await writeFile(path.join(extraPath, 'settings.json'), '{"editor.fontSize": 42}');
    const restored = await adapter.restoreSnapshot(snapshot, false, true);
    assert.equal(restored.structuralChange, true);
    assert.equal(restored.structuralApplied, false);
    assert.equal(await readFile(path.join(userDataPath, 'settings.json'), 'utf8'), '{"editor.fontSize": 15}');
    assert.equal(await readFile(path.join(namedPath, 'settings.json'), 'utf8'), '{"editor.fontSize": 16}');
    assert.equal(await readFile(path.join(extraPath, 'settings.json'), 'utf8'), '{"editor.fontSize": 42}');
    const storage = JSON.parse(await readFile(path.join(userDataPath, 'globalStorage', 'storage.json'), 'utf8')) as {
      userDataProfiles: Array<{ location: string }>;
    };
    assert.deepEqual(storage.userDataProfiles.map((profile) => profile.location), ['abc123', 'extra456']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('缺少 Profile 元数据时按清单补全并应用结构变化', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-adapter-metadata-'));
  const userDataPath = path.join(root, 'User');
  const runtimePath = path.join(userDataPath, 'globalStorage', 'local.profile-git-sync');
  const extraPath = path.join(userDataPath, 'profiles', 'extra456');
  const snapshot = path.join(root, 'snapshot');
  await Promise.all([
    mkdir(runtimePath, { recursive: true }),
    mkdir(extraPath, { recursive: true }),
    mkdir(path.join(snapshot, 'profiles', 'default'), { recursive: true }),
  ]);
  await writeFile(path.join(userDataPath, 'globalStorage', 'storage.json'), JSON.stringify({
    userDataProfiles: [{ location: 'extra456', name: '插件调试' }]
  }));
  await writeFile(path.join(userDataPath, 'settings.json'), '{"editor.fontSize": 99}');
  await writeFile(path.join(extraPath, 'settings.json'), '{"editor.fontSize": 42}');
  await writeFile(path.join(snapshot, 'profiles', 'default', 'settings.json'), '{"editor.fontSize": 14}');
  await writeFile(path.join(snapshot, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    host: 'vscode',
    createdAt: '',
    profiles: [{ id: 'default', name: '默认', isDefault: true }],
    files: { 'profiles/default/settings.json': testing.sha256(Buffer.from('{"editor.fontSize": 14}', 'utf8')) },
  }, null, 2)}\n`);
  const adapter = new ProfileAdapter({ kind: 'vscode', userDataPath, runtimePath });
  try {
    const restored = await adapter.restoreSnapshot(snapshot, true);
    assert.equal(restored.structuralChange, true);
    assert.equal(restored.structuralApplied, true);
    assert.equal(await readFile(path.join(userDataPath, 'settings.json'), 'utf8'), '{"editor.fontSize": 14}');
    const storage = JSON.parse(await readFile(path.join(userDataPath, 'globalStorage', 'storage.json'), 'utf8')) as {
      userDataProfiles?: Array<{ location: string }>;
    };
    assert.deepEqual(storage.userDataProfiles ?? [], []);
    await assert.rejects(readFile(path.join(extraPath, 'settings.json')), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('缺少元数据但清单含命名 Profile 时按 id 补全并创建目录', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-adapter-synthesize-'));
  const userDataPath = path.join(root, 'User');
  const runtimePath = path.join(userDataPath, 'globalStorage', 'local.profile-git-sync');
  const snapshot = path.join(root, 'snapshot');
  const namedSnapshot = path.join(snapshot, 'profiles', 'abc123');
  await Promise.all([
    mkdir(runtimePath, { recursive: true }),
    mkdir(path.join(userDataPath, 'globalStorage'), { recursive: true }),
    mkdir(namedSnapshot, { recursive: true }),
  ]);
  await writeFile(path.join(userDataPath, 'globalStorage', 'storage.json'), '{}');
  await writeFile(path.join(userDataPath, 'settings.json'), '{"editor.fontSize": 10}');
  await writeFile(path.join(namedSnapshot, 'settings.json'), '{"editor.fontSize": 16}');
  await writeFile(path.join(snapshot, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    host: 'vscode',
    createdAt: '',
    profiles: [
      { id: 'default', name: '默认', isDefault: true },
      { id: 'abc123', name: '开发', isDefault: false },
    ],
    files: { 'profiles/abc123/settings.json': testing.sha256(Buffer.from('{"editor.fontSize": 16}', 'utf8')) },
  }, null, 2)}\n`);
  const adapter = new ProfileAdapter({ kind: 'vscode', userDataPath, runtimePath });
  try {
    const restored = await adapter.restoreSnapshot(snapshot, true);
    assert.equal(restored.structuralApplied, true);
    assert.equal(await readFile(path.join(userDataPath, 'profiles', 'abc123', 'settings.json'), 'utf8'), '{"editor.fontSize": 16}');
    const storage = JSON.parse(await readFile(path.join(userDataPath, 'globalStorage', 'storage.json'), 'utf8')) as {
      userDataProfiles: Array<{ location: string; name: string }>;
    };
    assert.deepEqual(storage.userDataProfiles, [{ location: 'abc123', name: '开发' }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('旧快照缺少元数据时按 Profile 清单补全', () => {
  assert.deepEqual(testing.resolveProfileMetadata({
    schemaVersion: 1,
    host: 'vscode',
    createdAt: '',
    profiles: [
      { id: 'default', name: '默认', isDefault: true },
      { id: 'abc123', name: '开发', isDefault: false },
    ],
    files: {},
  }), [{ location: 'abc123', name: '开发' }]);
  assert.deepEqual(testing.resolveProfileMetadata({
    schemaVersion: 1,
    host: 'vscode',
    createdAt: '',
    profiles: [{ id: 'default', name: '默认', isDefault: true }],
    files: {},
  }), []);
  assert.deepEqual(testing.resolveProfileMetadata({
    schemaVersion: 1,
    host: 'vscode',
    createdAt: '',
    profiles: [{ id: 'default', name: '默认', isDefault: true }],
    profileMetadata: [{ location: 'kept', name: '保留' }],
    files: {},
  }), [{ location: 'kept', name: '保留' }]);
});

test('快照剥离插件自身设置并在写回本机时保留原值', () => {
  const text = '{\n  // 编辑器\n  "editor.fontSize": 14,\n  "profileGitSync.enabled": false\n}';
  const stripped = testing.stripPluginSettings(text);
  assert.match(stripped, /\/\/ 编辑器/);
  assert.doesNotMatch(stripped, /profileGitSync/);
  const restored = testing.restorePluginSettings(stripped, '{"profileGitSync.enabled": true}');
  assert.match(restored, /"profileGitSync.enabled":\s*true/);
  assert.match(restored, /"editor.fontSize":\s*14/);
  assert.equal(testing.stripPluginSettings('not-json'), 'not-json');
  assert.equal(testing.restorePluginSettings('{}', 'not-json'), '{}');
});

test('本机专属的插件设置变化不会改变同步指纹', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-fingerprint-'));
  const userDataPath = path.join(root, 'User');
  const runtimePath = path.join(userDataPath, 'globalStorage', 'local.profile-git-sync');
  try {
    await mkdir(runtimePath, { recursive: true });
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
  const userDataPath = path.join(root, 'User');
  const runtimePath = path.join(userDataPath, 'globalStorage', 'local.profile-git-sync');
  const snippetsPath = path.join(userDataPath, 'snippets');
  try {
    await mkdir(runtimePath, { recursive: true });
    await mkdir(snippetsPath, { recursive: true });
    await writeFile(path.join(userDataPath, 'settings.json'), '{"editor.fontSize": 14}');
    await writeFile(path.join(snippetsPath, 'zh.code-snippets'), '{}');
    await writeFile(path.join(snippetsPath, 'zh.code-snippets.profile-git-sync-1234'), '残留内容');
    const adapter = new ProfileAdapter({ kind: 'vscode', userDataPath, runtimePath });
    const snapshot = path.join(root, 'snapshot');
    const manifest = await adapter.createSnapshot(snapshot);
    assert.deepEqual(Object.keys(manifest.files).filter((file) => file.includes('.profile-git-sync-')), []);

    await writeFile(path.join(userDataPath, 'settings.json'), '{"editor.fontSize": 99}');
    await adapter.restoreSnapshot(snapshot, false);
    assert.equal(await readFile(path.join(userDataPath, 'settings.json'), 'utf8'), '{"editor.fontSize": 14}');
    assert.deepEqual((await readdir(userDataPath)).filter((name) => name.includes('.profile-git-sync-')), []);
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
