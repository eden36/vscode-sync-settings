import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse, ParseError } from 'jsonc-parser';
import { AiService, stripJsonFence } from './ai';
import { ConfigurationStore } from './configuration';
import { WindowSafetySnapshot } from './coordinator';
import { ConfigurationRepositoryGitService } from './git-service';
import { HostEnvironment } from './host';
import { ProfileAdapter } from './profile-adapter';
import { containsPotentialSecret, findPotentialSecrets } from './secret-scanner';
import { fallbackCommitMessage } from './sync-fallback';
import { collectExtensionIdsFromFiles, waitForExtensions } from './extension-wait';
import {
  classifyThreeWay,
  emptyManifest,
  readManifest,
  resolveConflictFallback,
  snapshotStructure,
  SnapshotStructure,
} from './snapshot-conflict';
import { MergeReport, RuntimeStatus, SnapshotManifest, SyncMode, SyncOutcome } from './types';

// 冲突备份保留份数：既能回溯最近几次自动合并，又不会让运行目录无限增长。
const MAX_CONFLICT_BACKUPS = 5;
const STRUCTURE_LABEL = 'Profile 结构和关联关系';

export class SyncEngine {
  private running = false;
  private readonly conflictBackupRoot: string;

  public constructor(
    private readonly environment: HostEnvironment,
    private readonly adapter: ProfileAdapter,
    private readonly git: ConfigurationRepositoryGitService,
    private readonly ai: AiService,
    private readonly configurationStore: ConfigurationStore,
    private readonly updateStatus: (patch: Partial<RuntimeStatus>) => void,
    private readonly windowSafety: () => Promise<WindowSafetySnapshot>,
  ) {
    // 与 ProfileAdapter 的 backups 目录分开存放，避免被那边的保留策略清理。
    this.conflictBackupRoot = path.join(environment.runtimePath, 'conflict-backups');
  }

  public async synchronize(): Promise<SyncOutcome | undefined> {
    if (this.running) return undefined;
    this.running = true;
    const configuration = this.configurationStore.get();
    let usedAiFallback = false;
    let recoveredPendingChanges = false;
    let recoveredFromDivergence = false;
    let temporaryRoot: string | undefined;
    let merge: MergeReport | undefined;
    try {
      if (!configuration.repositoryUrl) {
        this.updateStatus({ phase: '未配置', message: '请填写 Git 仓库地址。' });
        return { ok: false };
      }
      const backupOnly = configuration.mode === 'backup';
      if (!await this.ensureWindowSafety()) return { ok: false, retry: true };

      this.updateStatus({ phase: '正在扫描', message: undefined });
      // 同步在独占锁内执行，进程异常退出残留的临时快照可以安全清空。
      const snapshotRoot = path.join(this.environment.runtimePath, 'snapshots');
      await fs.rm(snapshotRoot, { recursive: true, force: true }).catch(() => undefined);
      temporaryRoot = path.join(snapshotRoot, `local-${process.pid}-${Date.now()}`);
      const localHostRoot = path.join(temporaryRoot, this.environment.kind);
      const localManifest = await this.adapter.createSnapshot(localHostRoot, configuration.includeProfileAssociations);
      const secretFiles = await findPotentialSecrets(localHostRoot, localManifest);
      if (secretFiles.length) {
        throw new Error(`检测到可能包含凭据的配置，已拒绝提交：${secretFiles.join('、')}`);
      }

      await this.git.prepare(configuration);
      const repositoryHostRoot = path.join(this.git.repositoryPath, '.profile-git-sync', 'hosts', this.environment.kind);
      const baseHostRoot = path.join(temporaryRoot, 'base');
      recoveredPendingChanges = await this.git.discardPendingHostChanges(this.environment.kind);

      this.updateStatus({ phase: '正在拉取' });
      const pull = await this.git.pull(configuration);
      recoveredFromDivergence = pull.recoveredFromDivergence;
      // 基准必须取本地与远端的共同祖先，否则本机上次的改动会被当成共同基础，导致误判冲突。
      if (pull.mergeBase && !backupOnly) await this.git.exportHostTree(pull.mergeBase, this.environment.kind, baseHostRoot);
      const remoteExists = await exists(path.join(repositoryHostRoot, 'manifest.json'));
      const baseExists = await exists(path.join(baseHostRoot, 'manifest.json'));

      let mergedRoot = localHostRoot;
      if (remoteExists && !backupOnly) {
        const merged = path.join(temporaryRoot, 'merged');
        merge = await this.mergeSnapshots(baseExists ? baseHostRoot : undefined, localHostRoot, repositoryHostRoot, merged);
        // 自动合并会覆盖某一方的内容，先留存两份原始快照，用户事后仍可人工找回。
        if (merge.conflicts.length) await this.backupConflictSnapshots(localHostRoot, repositoryHostRoot);
        mergedRoot = merged;
      }

      await fs.rm(repositoryHostRoot, { recursive: true, force: true });
      await fs.mkdir(path.dirname(repositoryHostRoot), { recursive: true });
      await fs.cp(mergedRoot, repositoryHostRoot, { recursive: true });

      const mergedManifest = await readManifest(repositoryHostRoot);
      const mergedSecrets = await findPotentialSecrets(repositoryHostRoot, mergedManifest);
      if (mergedSecrets.length) {
        throw new Error(`检测到可能包含凭据的配置，已拒绝同步：${mergedSecrets.join('、')}`);
      }

      const changed = await this.git.stageHost(this.environment.kind);
      if (changed.length) {
        this.updateStatus({ phase: '等待 AI', pendingChanges: changed.length });
        let message: string;
        try {
          message = await this.ai.createCommitMessage(changed.map((file) => `- ${file}`).join('\n'));
        } catch {
          message = fallbackCommitMessage(this.environment.kind);
          usedAiFallback = true;
        }
        this.updateStatus({ phase: '正在提交', message });
        if (!await this.ensureWindowSafety()) return { ok: false, retry: true };
        await this.git.commitAndPush(configuration, message);
      } else {
        if (!await this.ensureWindowSafety()) return { ok: false, retry: true };
        await this.git.pushIfAhead(configuration);
      }
      if (backupOnly) {
        this.updateStatus({
          phase: '空闲',
          pendingChanges: 0,
          lastSyncAt: new Date().toISOString(),
          message: finalSyncMessage({
            mode: configuration.mode,
            changed: changed.length > 0,
            usedAiFallback,
            recoveredPendingChanges,
            recoveredFromDivergence,
          }),
        });
        return { ok: true };
      }

      const safety = await this.ensureWindowSafety();
      if (!safety) return { ok: false, retry: true };
      // Profile 增删会重建磁盘上的 Profile 列表，只在本机仅剩一个窗口时应用，避免影响其他窗口正在使用的 Profile。
      const restore = await this.adapter.restoreSnapshot(repositoryHostRoot, safety.activeWindows <= 1);
      let extensionsPending: string[] | undefined;
      const extensionFiles = restore.changedFiles.filter((file) => path.basename(file) === 'extensions.json');
      if (extensionFiles.length) {
        const targetIds = await collectExtensionIdsFromFiles(extensionFiles);
        this.updateStatus({ phase: '正在同步扩展', message: '等待 IDE 安装扩展…' });
        const extensionResult = await waitForExtensions(targetIds, {
          onProgress: (message) => this.updateStatus({ phase: '正在同步扩展', message })
        });
        if (!extensionResult.converged) {
          extensionsPending = extensionResult.pending;
        }
      }
      const waitingForWindows = restore.structuralChange && !restore.structuralApplied;
      this.updateStatus({
        phase: waitingForWindows ? '等待其他窗口关闭' : '空闲',
        activeWindows: safety.activeWindows,
        pendingChanges: 0,
        lastSyncAt: new Date().toISOString(),
        message: finalSyncMessage({
          mode: configuration.mode,
          structuralMessage: restore.message,
          changed: changed.length > 0,
          usedAiFallback,
          recoveredPendingChanges,
          recoveredFromDivergence,
          extensionsPending,
          merge,
        })
      });
      return { ok: true, extensionsPending, structuralApplied: restore.structuralApplied };
    } catch (error) {
      this.updateStatus({ phase: '失败', message: error instanceof Error ? error.message : String(error) });
      return { ok: false };
    } finally {
      this.running = false;
      if (temporaryRoot) {
        await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private async backupConflictSnapshots(localRoot: string, cloudRoot: string): Promise<void> {
    const target = path.join(this.conflictBackupRoot, new Date().toISOString().replaceAll(':', '-'));
    await fs.mkdir(target, { recursive: true });
    await Promise.all([
      fs.cp(localRoot, path.join(target, 'local'), { recursive: true }),
      fs.cp(cloudRoot, path.join(target, 'cloud'), { recursive: true }),
    ]);
    const entries = (await fs.readdir(this.conflictBackupRoot).catch(() => [] as string[])).sort();
    for (const name of entries.slice(0, Math.max(0, entries.length - MAX_CONFLICT_BACKUPS))) {
      await fs.rm(path.join(this.conflictBackupRoot, name), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async ensureWindowSafety(): Promise<WindowSafetySnapshot | undefined> {
    const safety = await this.windowSafety();
    if (safety.dirtyWindows > 0) {
      this.updateStatus({
        phase: '空闲',
        activeWindows: safety.activeWindows,
        message: `有 ${safety.dirtyWindows} 个窗口存在未保存的配置文件，保存后再同步。`,
      });
      return undefined;
    }
    if (safety.unreadableWindows > 0) {
      this.updateStatus({
        phase: '空闲',
        activeWindows: safety.activeWindows,
        message: `有 ${safety.unreadableWindows} 个窗口状态无法确认，已暂停同步。`,
      });
      return undefined;
    }
    return safety;
  }

  /** 冲突一律自动收敛：优先 AI 合并，AI 不可用或结果无效时按确定性规则择一，绝不中断同步。 */
  private async mergeSnapshots(
    baseRoot: string | undefined,
    localRoot: string,
    cloudRoot: string,
    outputRoot: string,
  ): Promise<MergeReport> {
    const base = baseRoot ? await readManifest(baseRoot) : emptyManifest(this.environment.kind);
    const local = await readManifest(localRoot);
    const cloud = await readManifest(cloudRoot);
    const files = new Set([...Object.keys(base.files), ...Object.keys(local.files), ...Object.keys(cloud.files)]);
    const outputFiles: Record<string, string> = {};
    const report: MergeReport = { conflicts: [], aiMerged: [], autoMerged: [] };
    let aiAvailable = true;
    await fs.rm(outputRoot, { recursive: true, force: true });
    await fs.mkdir(outputRoot, { recursive: true });

    for (const relative of files) {
      const localHash = local.files[relative];
      const cloudHash = cloud.files[relative];
      const choice = classifyThreeWay(base.files[relative], localHash, cloudHash);
      let sourceRoot: string | undefined;
      let mergedContent: Buffer | undefined;
      if (choice === 'cloud') sourceRoot = cloudHash ? cloudRoot : undefined;
      else if (choice === 'local') sourceRoot = localHash ? localRoot : undefined;
      else {
        report.conflicts.push(relative);
        if (aiAvailable) {
          this.updateStatus({ phase: '等待 AI', message: `正在自动合并：${relative}` });
          try {
            mergedContent = await this.aiMergeFile(baseRoot, localRoot, cloudRoot, relative);
            report.aiMerged.push(relative);
          } catch (error) {
            // 模型不可用、无授权或超时属于整轮同步的共性问题，一次失败后不再让后续文件重复等待。
            aiAvailable = false;
            report.aiError ??= safeErrorMessage(error);
          }
        }
        if (!mergedContent) {
          sourceRoot = resolveConflictFallback(localHash, cloudHash) === 'local' ? localRoot : cloudRoot;
          report.autoMerged.push(relative);
        }
      }
      if (!sourceRoot && !mergedContent) continue;
      const content = mergedContent ?? await fs.readFile(resolveSnapshotPath(sourceRoot!, relative));
      const target = resolveSnapshotPath(outputRoot, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
      outputFiles[relative] = sha256(content);
    }

    const structure = await this.mergeStructure(base, local, cloud, aiAvailable, report);
    const manifest: SnapshotManifest = {
      schemaVersion: 1,
      host: this.environment.kind,
      createdAt: '',
      profiles: structure.profiles,
      ...(structure.profileMetadata !== undefined ? { profileMetadata: structure.profileMetadata } : {}),
      ...(structure.profileAssociations !== undefined ? { profileAssociations: structure.profileAssociations } : {}),
      files: outputFiles
    };
    await fs.writeFile(path.join(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return report;
  }

  private async aiMergeFile(baseRoot: string | undefined, localRoot: string, cloudRoot: string, relative: string): Promise<Buffer> {
    const [baseText, localText, cloudText] = await Promise.all([
      readOptionalText(baseRoot, relative),
      readOptionalText(localRoot, relative),
      readOptionalText(cloudRoot, relative)
    ]);
    if ([baseText, localText, cloudText].some(containsPotentialSecret)) throw new Error(`冲突文件可能包含凭据，无法交给 AI：${relative}`);
    const candidate = await this.ai.resolveConflict(relative, baseText, localText, cloudText);
    validateCandidate(relative, candidate);
    return Buffer.from(candidate, 'utf8');
  }

  private async mergeStructure(
    base: SnapshotManifest,
    local: SnapshotManifest,
    cloud: SnapshotManifest,
    aiAvailable: boolean,
    report: MergeReport,
  ): Promise<SnapshotStructure> {
    const baseStructure = snapshotStructure(base);
    const localStructure = snapshotStructure(local);
    const cloudStructure = snapshotStructure(cloud);
    const texts = [baseStructure, localStructure, cloudStructure].map((value) => JSON.stringify(value, null, 2));
    const choice = classifyThreeWay(
      JSON.stringify(baseStructure),
      JSON.stringify(localStructure),
      JSON.stringify(cloudStructure),
    );
    if (choice === 'cloud') return cloudStructure;
    if (choice === 'local') return localStructure;
    report.conflicts.push(STRUCTURE_LABEL);
    if (aiAvailable && !texts.some(containsPotentialSecret)) {
      try {
        this.updateStatus({ phase: '等待 AI', message: `正在自动合并：${STRUCTURE_LABEL}` });
        const candidate = stripJsonFence(await this.ai.resolveConflict(STRUCTURE_LABEL, texts[0]!, texts[1]!, texts[2]!));
        validateCandidate('profile-structure.json', candidate);
        report.aiMerged.push(STRUCTURE_LABEL);
        return parseProfileStructure(JSON.parse(candidate) as unknown);
      } catch (error) {
        report.aiError ??= safeErrorMessage(error);
      }
    }
    // 结构冲突回退到本机：宁可保留多余的 Profile，也不删除本机正在使用的 Profile。
    report.autoMerged.push(STRUCTURE_LABEL);
    return localStructure;
  }
}

async function readOptionalText(root: string | undefined, relative: string): Promise<string> {
  if (!root) return '';
  return fs.readFile(resolveSnapshotPath(root, relative), 'utf8').catch(() => '');
}

function resolveSnapshotPath(root: string, relative: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...relative.split('/'));
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`快照路径非法：${relative}`);
  return resolved;
}

function validateCandidate(relative: string, content: string): void {
  if (!content.trim()) throw new Error(`AI 为 ${relative} 返回了空的合并结果。`);
  if (content.includes('<<<<<<<') || content.includes('>>>>>>>')) throw new Error(`AI 未完整解决 ${relative} 的冲突。`);
  if (containsPotentialSecret(content)) throw new Error(`AI 为 ${relative} 生成的内容可能包含凭据。`);
  if (/\.(?:json|jsonc|code-snippets)$/i.test(relative)) {
    const errors: ParseError[] = [];
    parse(content, errors, { allowTrailingComma: true, disallowComments: false });
    if (errors.length) throw new Error(`AI 为 ${relative} 生成的 JSON/JSONC 无法解析。`);
  }
}

/** AI 返回的结构会直接写入 storage.json，必须逐项校验，避免破坏本机 Profile 存储。 */
function parseProfileStructure(value: unknown): SnapshotStructure {
  if (!isRecord(value) || !Array.isArray(value.profiles)) throw new Error('AI 返回的 Profile 结构无效。');
  const profiles = value.profiles.map((profile) => {
    if (!isRecord(profile) || !isNonEmptyString(profile.id) || !isNonEmptyString(profile.name) || typeof profile.isDefault !== 'boolean') {
      throw new Error('AI 返回的 Profile 清单无效。');
    }
    return { id: profile.id, name: profile.name, isDefault: profile.isDefault };
  });
  let profileMetadata: Array<Record<string, unknown>> | undefined;
  if (value.profileMetadata !== undefined) {
    if (!Array.isArray(value.profileMetadata)) throw new Error('AI 返回的 Profile 元数据无效。');
    profileMetadata = value.profileMetadata.map((entry) => {
      if (!isRecord(entry) || !isNonEmptyString(entry.location) || !isNonEmptyString(entry.name)) {
        throw new Error('AI 返回的 Profile 元数据无效。');
      }
      return { ...entry };
    });
  }
  if (value.profileAssociations !== undefined && !isAssociationMap(value.profileAssociations)) {
    throw new Error('AI 返回的 Profile 关联关系无效。');
  }
  return {
    profiles,
    ...(profileMetadata ? { profileMetadata } : {}),
    ...(value.profileAssociations !== undefined ? { profileAssociations: value.profileAssociations } : {}),
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isAssociationMap(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((group) => (
    isRecord(group) && Object.values(group).every((item) => typeof item === 'string')
  ));
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

interface SyncMessageDetails {
  mode: SyncMode;
  structuralMessage?: string;
  changed: boolean;
  usedAiFallback: boolean;
  recoveredPendingChanges: boolean;
  recoveredFromDivergence: boolean;
  extensionsPending?: string[];
  merge?: MergeReport;
}

export function finalSyncMessage(details: SyncMessageDetails): string {
  const notes: string[] = [];
  const merge = details.merge;
  if (merge?.conflicts.length) {
    if (merge.aiMerged.length) notes.push(`AI 已自动合并 ${merge.aiMerged.length} 项冲突`);
    if (merge.autoMerged.length) notes.push(`${merge.autoMerged.length} 项冲突按本机优先自动处理`);
    notes.push('冲突前的两份配置已备份到扩展运行目录');
  }
  if (details.structuralMessage) {
    return `${[details.structuralMessage.replace(/。$/, ''), ...notes].join('；')}。`;
  }
  if (!details.changed && !notes.length) {
    if (details.recoveredFromDivergence) return '已重新对齐上次未推送成功的提交，配置已是最新。';
    return details.recoveredPendingChanges ? '已清理上次中断的暂存状态，配置已是最新。' : '配置已是最新。';
  }
  if (details.usedAiFallback) notes.push('AI 不可用或结果无效，已使用兜底策略');
  if (details.recoveredPendingChanges) notes.push('已清理上次中断的暂存状态');
  if (details.recoveredFromDivergence) notes.push('已重新对齐上次未推送成功的提交');
  if (details.extensionsPending?.length) {
    notes.push(`部分扩展尚未安装完成：${details.extensionsPending.join('、')}`);
  }
  if (details.mode === 'backup') {
    return notes.length ? `备份完成（${notes.join('；')}）。` : '备份完成。';
  }
  return notes.length ? `同步完成（${notes.join('；')}）。` : '同步完成。';
}

async function exists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ').slice(0, 500);
}
