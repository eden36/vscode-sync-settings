import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// 冲突备份保留份数：既能回溯最近几次自动合并，又不会让运行目录无限增长。
const MAX_CONFLICT_BACKUPS = 5;

/** 自动合并会覆盖某一方的内容，先留存两份原始快照，用户事后仍可人工找回。 */
export async function backupConflictSnapshots(backupRoot: string, localRoot: string, cloudRoot: string): Promise<void> {
  const target = path.join(backupRoot, new Date().toISOString().replaceAll(':', '-'));
  await fs.mkdir(target, { recursive: true });
  await Promise.all([
    fs.cp(localRoot, path.join(target, 'local'), { recursive: true }),
    fs.cp(cloudRoot, path.join(target, 'cloud'), { recursive: true }),
  ]);
  const entries = (await fs.readdir(backupRoot).catch(() => [] as string[])).sort();
  for (const name of entries.slice(0, Math.max(0, entries.length - MAX_CONFLICT_BACKUPS))) {
    await fs.rm(path.join(backupRoot, name), { recursive: true, force: true }).catch(() => undefined);
  }
}
