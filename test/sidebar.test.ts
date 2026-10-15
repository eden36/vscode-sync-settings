import assert from 'node:assert/strict';
import test from 'node:test';
import { HISTORY_LIMIT_MAX, HISTORY_PAGE_SIZE, parseMessage } from '../src/sidebar-messages';
import { displayIcon, displayPhase, displayTone } from '../src/sidebar-status';

test('侧边栏消息解析拒绝越界参数与非法标识', () => {
  const hash = 'a'.repeat(40);
  assert.deepEqual(parseMessage({ type: 'ready' }), { type: 'ready' });
  assert.deepEqual(parseMessage({ type: 'toggleEnabled', enabled: true }), { type: 'toggleEnabled', enabled: true });
  assert.equal(parseMessage({ type: 'toggleEnabled', enabled: 'true' }), undefined);
  assert.equal(parseMessage({ type: 'setMode', mode: 'merge' }), undefined);
  assert.equal(parseMessage({ type: 'resolveConflict', resolution: 'both' }), undefined);
  // 处理哪一组 Profile 由扩展按共享状态决定，Webview 多带的字段不得随消息进入后续逻辑。
  assert.deepEqual(parseMessage({ type: 'resolveProfiles', names: ['伪造'] }), { type: 'resolveProfiles' });
  assert.equal(parseMessage({ type: 'unknown' }), undefined);
  assert.equal(parseMessage(null), undefined);

  assert.deepEqual(
    parseMessage({ type: 'loadHistory', limit: HISTORY_PAGE_SIZE, refresh: true }),
    { type: 'loadHistory', limit: HISTORY_PAGE_SIZE, refresh: true },
  );
  assert.deepEqual(
    parseMessage({ type: 'loadHistory', limit: HISTORY_LIMIT_MAX, refresh: false }),
    { type: 'loadHistory', limit: HISTORY_LIMIT_MAX, refresh: false },
  );
  for (const limit of [HISTORY_PAGE_SIZE - 1, HISTORY_LIMIT_MAX + 1, 30.5, Number.POSITIVE_INFINITY, Number.NaN, '30']) {
    assert.equal(parseMessage({ type: 'loadHistory', limit, refresh: true }), undefined);
  }
  assert.equal(parseMessage({ type: 'loadHistory', limit: HISTORY_PAGE_SIZE }), undefined);

  assert.deepEqual(parseMessage({ type: 'restoreCommit', hash }), { type: 'restoreCommit', hash });
  assert.equal(parseMessage({ type: 'restoreCommit', hash: 'abcdefg' }), undefined);
  assert.equal(parseMessage({ type: 'restoreCommit', hash: `${hash} --force` }), undefined);
  assert.deepEqual(parseMessage({ type: 'deleteTag', hash, tag: 'v1.0' }), { type: 'deleteTag', hash, tag: 'v1.0' });
  assert.equal(parseMessage({ type: 'deleteTag', hash, tag: '--delete' }), undefined);
  assert.equal(parseMessage({ type: 'deleteTag', hash }), undefined);
});

test('侧边栏保存配置的消息只保留已知字段', () => {
  const configuration = {
    repositoryUrl: 'git@example.com:user/settings.git',
    branch: 'main',
    gitUserName: '',
    gitUserEmail: '',
  };
  const automation = { debounceSeconds: 10, pollIntervalSeconds: 300 };
  // 多带的 mode 若随保存生效，就绕过了切换到同步模式的确认弹窗。
  assert.deepEqual(
    parseMessage({ type: 'save', configuration: { ...configuration, mode: 'sync' }, automation: { ...automation, mode: 'sync' } }),
    { type: 'save', configuration, automation },
  );
  assert.equal(parseMessage({ type: 'save', configuration: { ...configuration, branch: '-bad' }, automation }), undefined);
  assert.equal(
    parseMessage({ type: 'save', configuration: { ...configuration, repositoryUrl: 'a\nb' }, automation }),
    undefined,
  );
  assert.equal(parseMessage({ type: 'save', configuration, automation: { ...automation, debounceSeconds: 1 } }), undefined);
  assert.equal(parseMessage({ type: 'save', configuration }), undefined);
});

test('状态栏只在同步执行阶段显示忙碌', () => {
  assert.equal(displayIcon({ kind: 'running', stage: 'pull' }, 'in-sync'), '$(sync~spin)');
  assert.equal(displayIcon({ kind: 'running', stage: 'ai' }, 'in-sync'), '$(sync~spin)');
  assert.equal(displayIcon({ kind: 'idle' }, 'in-sync'), '$(check)');
  assert.equal(displayIcon({ kind: 'blocked', reason: 'profiles-mismatch' }, 'in-sync'), '$(question)');
});

test('对外状态由链路状态和本地远端关系共同决定', () => {
  assert.equal(displayPhase({ kind: 'disabled' }, 'in-sync'), '已关闭');
  assert.equal(displayPhase({ kind: 'unconfigured' }, 'no-repository'), '未配置');
  assert.equal(displayPhase({ kind: 'running', stage: 'pull' }, 'in-sync'), '同步中');
  assert.equal(displayPhase({ kind: 'blocked', reason: 'unrelated' }, 'unrelated'), '需要处理');
  assert.equal(displayPhase({ kind: 'failed' }, 'in-sync'), '同步失败');
  assert.equal(displayPhase({ kind: 'idle' }, 'in-sync'), '已同步');
  assert.equal(displayPhase({ kind: 'idle' }, 'no-repository'), '未同步');
});

test('删除本地仓库后即使留有上次同步时间也显示未同步', () => {
  assert.equal(displayPhase({ kind: 'idle' }, 'no-repository'), '未同步');
  assert.equal(displayIcon({ kind: 'idle' }, 'no-repository'), '$(circle-outline)');
  assert.equal(displayTone({ kind: 'idle' }, 'no-repository'), 'muted');
});

test('关闭同步时状态不按告警呈现', () => {
  assert.equal(displayIcon({ kind: 'disabled' }, 'in-sync'), '$(circle-slash)');
  assert.equal(displayTone({ kind: 'disabled' }, 'in-sync'), 'muted');
});
