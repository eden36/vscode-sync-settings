import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { containsPotentialSecret, findPotentialSecrets } from '../src/secret-scanner';

test('凭据扫描覆盖常见键名与 token 值', () => {
  assert.equal(containsPotentialSecret('{"apiKey":"x"}'), true);
  assert.equal(containsPotentialSecret('{"token":"x"}'), true);
  assert.equal(containsPotentialSecret('{"label":"ghp_1234567890123456789012345678901234"}'), true);
  assert.equal(containsPotentialSecret('{"editor.fontSize":14}'), false);
});

test('凭据扫描放行不含真实凭据的取值，引用后拼接内容仍然拦截', () => {
  // mcp.json 用变量引用存放凭据是标准写法，真正的值不在文件里。
  assert.equal(containsPotentialSecret('{"env":{"GITHUB_TOKEN":"${input:github_token}"}}'), false);
  assert.equal(containsPotentialSecret('{"headers":{"Authorization":"Bearer ${env:API_TOKEN}"}}'), false);
  assert.equal(containsPotentialSecret('{"password": ""}'), false);
  assert.equal(containsPotentialSecret('{"token": null}'), false);
  assert.equal(containsPotentialSecret('{"editor.tokenColorCustomizations":{}}'), false);

  assert.equal(containsPotentialSecret('{"env":{"GITHUB_TOKEN":"abc123"}}'), true);
  assert.equal(containsPotentialSecret('{"password": "abc"}'), true);
  assert.equal(containsPotentialSecret('{"token":"${input:token}suffix"}'), true);
  assert.equal(containsPotentialSecret('{"token":"prefix ${input:token}"}'), true);
  assert.equal(containsPotentialSecret('{"secret":{"value":"abc"}}'), true);
  // 同一个文件里放行的写法不能掩护后面真正的凭据。
  assert.equal(containsPotentialSecret('{"token":"${input:token}","apiKey":"abc"}'), true);
  // 取值本身像 token 时，键名再普通也照样拦下。
  assert.equal(containsPotentialSecret('{"note":"ghp_1234567890123456789012345678901234"}'), true);
});

test('凭据格式要求前缀处于单词边界，普通文本里夹带的前缀不算', () => {
  // task-、disk-、desk- 里都含有 sk-，误判会让整轮同步被拒绝。
  assert.equal(containsPotentialSecret('{"label":"task-dependencies-build"}'), false);
  assert.equal(containsPotentialSecret('清理脚本 disk-cleanup-script-v2'), false);
  assert.equal(containsPotentialSecret('{"key":"sk-proj-abcdefghijklmnop"}'), true);
  assert.equal(containsPotentialSecret('{"value":"sk-ant-api03-abcdefghij"}'), true);
});

test('凭据扫描覆盖云服务密钥、私钥与 JWT', () => {
  assert.equal(containsPotentialSecret('{"aws":"AKIAIOSFODNN7EXAMPLE"}'), true);
  assert.equal(containsPotentialSecret('{"maps":"AIzaSyA1234567890abcdefghijklmnopqrstuv"}'), true);
  assert.equal(containsPotentialSecret('-----BEGIN OPENSSH PRIVATE KEY-----\nabc'), true);
  assert.equal(containsPotentialSecret('-----BEGIN PRIVATE KEY-----'), true);
  assert.equal(containsPotentialSecret('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N'), true);
  // 公钥与普通的大写单词不是凭据。
  assert.equal(containsPotentialSecret('-----BEGIN PUBLIC KEY-----'), false);
  assert.equal(containsPotentialSecret('{"note":"AKIA is the prefix"}'), false);
});

test('凭据扫描覆盖环境变量风格的键名且不误伤配置项', () => {
  // mcp.json 里的 MCP 服务器凭据是这种形态，键名带业务前缀。
  assert.equal(containsPotentialSecret('{"env":{"BRAVE_API_KEY":"BSAxxx"}}'), true);
  assert.equal(containsPotentialSecret('{"env":{"ANTHROPIC_API_KEY":"xyz"}}'), true);
  assert.equal(containsPotentialSecret('{"DATABASE_PASSWORD":"p"}'), true);
  assert.equal(containsPotentialSecret('{"MY_SECRET_VALUE":"s"}'), true);
  // 驼峰写法的编辑器配置不能被误判，否则用户根本无法同步。
  assert.equal(containsPotentialSecret('{"editor.tokenColorCustomizations":{}}'), false);
  assert.equal(containsPotentialSecret('{"editor.semanticTokenColorCustomizations":{}}'), false);
  assert.equal(containsPotentialSecret('{"editor.fontSize":14}'), false);
});

test('凭据扫描覆盖快照中的所有文件而不限扩展名', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-scan-'));
  try {
    await mkdir(path.join(root, 'profiles', 'default', 'prompts'), { recursive: true });
    await writeFile(path.join(root, 'profiles', 'default', 'prompts', 'review.prompt.md'), '使用 ghp_0123456789abcdefghijklmnop 调用接口');
    const manifest = {
      schemaVersion: 1 as const, host: 'vscode' as const, createdAt: '', profiles: [],
      files: { 'profiles/default/prompts/review.prompt.md': 'x' },
    };
    assert.deepEqual(await findPotentialSecrets(root, manifest), ['profiles/default/prompts/review.prompt.md']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('清单中越界的路径按可疑处理，不读取快照目录之外的文件', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-git-sync-escape-'));
  try {
    await mkdir(path.join(root, 'inside'), { recursive: true });
    const manifest = {
      schemaVersion: 1 as const, host: 'vscode' as const, createdAt: '', profiles: [],
      files: { '../../outside.json': 'x' },
    };
    assert.deepEqual(await findPotentialSecrets(path.join(root, 'inside'), manifest), ['../../outside.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
