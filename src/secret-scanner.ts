import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SnapshotManifest } from './types';

// 直接以敏感词命名的键，例如 "apiKey"、"password"。
const SENSITIVE_KEY = /["'](?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|password|passwd|client[_-]?secret|private[_-]?key|github[_-]?token|gitlab[_-]?token|bearer[_-]?token|secret|token)["']\s*:/i;

/**
 * 环境变量风格的键，例如 mcp.json 里的 "env": { "BRAVE_API_KEY": "…" }。
 * 只匹配全大写下划线写法，避免误伤 editor.tokenColorCustomizations 这类驼峰配置项。
 */
const SENSITIVE_ENV_KEY = /["'][A-Z0-9_]*(?:API_?KEY|ACCESS_?TOKEN|AUTH_?TOKEN|_TOKEN|TOKEN_|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_?KEY)[A-Z0-9_]*["']\s*:/;

const SENSITIVE_VALUE = /(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9\-_]{20,}|sk-[A-Za-z0-9\-_]{10,}|xox[baprs]-[A-Za-z0-9\-]+)/;

/**
 * 扫描快照中的全部文件，不按扩展名筛选。
 * prompts 等目录允许任意扩展名，维护白名单迟早会漏掉新类型。
 */
export async function findPotentialSecrets(root: string, manifest: SnapshotManifest): Promise<string[]> {
  const matches: string[] = [];
  const resolvedRoot = path.resolve(root);
  for (const relative of Object.keys(manifest.files)) {
    const target = path.resolve(resolvedRoot, ...relative.split('/'));
    // 清单来自远端仓库，路径不可信，越界的条目一律视为可疑。
    if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
      matches.push(relative);
      continue;
    }
    const content = await fs.readFile(target, 'utf8').catch(() => undefined);
    if (content !== undefined && containsPotentialSecret(content)) matches.push(relative);
  }
  return matches;
}

export function containsPotentialSecret(content: string): boolean {
  return SENSITIVE_KEY.test(content) || SENSITIVE_ENV_KEY.test(content) || SENSITIVE_VALUE.test(content);
}
