import assert from 'node:assert/strict';
import test from 'node:test';
import { browseCommitUrl, browseRepositoryUrl } from '../src/repository-browse';

const hash = 'a'.repeat(40);

test('GitHub 与 Gitee 的三种地址都译成仓库首页', () => {
  const pages = [
    ['git@github.com:User/settings.git', 'https://github.com/User/settings'],
    ['git@gitee.com:User/settings.git', 'https://gitee.com/User/settings'],
    ['ssh://git@github.com/User/settings.git', 'https://github.com/User/settings'],
    ['ssh://git@gitee.com:22/User/settings.git', 'https://gitee.com/User/settings'],
    ['https://github.com/User/settings.git', 'https://github.com/User/settings'],
    ['https://www.gitee.com/User/settings/', 'https://gitee.com/User/settings'],
    ['  https://www.GitHub.com/User/settings.git/  ', 'https://github.com/User/settings'],
  ] as const;
  for (const [repositoryUrl, page] of pages) {
    assert.equal(browseRepositoryUrl(repositoryUrl), page);
    assert.equal(browseCommitUrl(repositoryUrl, hash), `${page}/commit/${hash}`);
  }
});

test('认不出的仓库地址与不完整的提交标识不生成链接', () => {
  for (const repositoryUrl of [
    '',
    'git@gitlab.com:user/settings.git',
    'https://github.example.com/user/settings.git',
    'http://github.com/user/settings.git',
    'https://user:token@github.com/user/settings.git',
    'https://github.com/user/settings/extra',
    'git@github.com:user/settings/extra.git',
    'ssh://github.com/user/settings.git',
    'ssh://git@github.com:0/user/settings.git',
    'git@github.com:../settings.git',
    'https://github.com/user/settings.git?ref=1',
  ]) {
    assert.equal(browseRepositoryUrl(repositoryUrl), undefined);
    assert.equal(browseCommitUrl(repositoryUrl, hash), undefined);
  }
  assert.equal(browseCommitUrl('git@github.com:user/settings.git', 'abc'), undefined);
  assert.equal(browseCommitUrl('git@github.com:user/settings.git', `${hash} --force`), undefined);
});
