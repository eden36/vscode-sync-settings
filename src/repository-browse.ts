/** 能确定网页形态的公网站点。企业版自定义域名不在此列。 */
const BROWSE_HOSTS = new Set(['github.com', 'gitee.com']);

/**
 * 把配置里的 Git 地址译成仓库首页。
 * 只接受 github.com / gitee.com 的 `git@主机:所有者/仓库`、`ssh://git@主机/所有者/仓库`、`https://主机/所有者/仓库`，
 * 末尾 `.git` 与斜杠可有可无，`ssh://` 的端口忽略。认不出时返回 undefined，调用方不要自行打开原地址。
 */
export function browseRepositoryUrl(repositoryUrl: string): string | undefined {
  const located = locateRepository(repositoryUrl);
  if (!located) return undefined;
  return `https://${located.host}/${located.owner}/${located.repo}`;
}

/** 在仓库首页后接上这次提交。hash 必须是完整的 40 位，避免把不受控的路径拼进要打开的链接。 */
export function browseCommitUrl(repositoryUrl: string, hash: string): string | undefined {
  if (!/^[0-9a-f]{40}$/.test(hash)) return undefined;
  const repository = browseRepositoryUrl(repositoryUrl);
  return repository ? `${repository}/commit/${hash}` : undefined;
}

function locateRepository(repositoryUrl: string): { host: string; owner: string; repo: string } | undefined {
  const value = repositoryUrl.trim();
  if (!value || /[\s?#]/.test(value)) return undefined;
  const scp = /^git@([^:/]+):([^/]+)\/([^/]+)\/?$/i.exec(value);
  if (scp) return accepted(scp[1] ?? '', scp[2] ?? '', scp[3] ?? '');
  const ssh = /^ssh:\/\/git@([^:/]+)(?::(\d+))?\/([^/]+)\/([^/]+)\/?$/i.exec(value);
  if (ssh) {
    if (ssh[2] !== undefined && !validPort(ssh[2])) return undefined;
    return accepted(ssh[1] ?? '', ssh[3] ?? '', ssh[4] ?? '');
  }
  const https = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/?$/i.exec(value);
  if (https) return accepted(https[1] ?? '', https[2] ?? '', https[3] ?? '');
  return undefined;
}

function accepted(hostText: string, ownerText: string, repoText: string): { host: string; owner: string; repo: string } | undefined {
  const host = canonicalHost(hostText);
  const owner = segment(ownerText);
  const repo = segment(repoText.replace(/\.git$/i, ''));
  if (!host || !owner || !repo) return undefined;
  return { host, owner, repo };
}

function canonicalHost(host: string): string | undefined {
  const bare = host.toLowerCase().replace(/^www\./, '');
  return BROWSE_HOSTS.has(bare) ? bare : undefined;
}

/** 路径只保留一段普通名称，挡掉 `..`、空段和需要转义的字符。 */
function segment(value: string): string | undefined {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') return undefined;
  return value;
}

function validPort(value: string): boolean {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}
