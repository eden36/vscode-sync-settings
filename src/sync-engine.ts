import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { parse, ParseError } from 'jsonc-parser';
import { AiService } from './ai';
import { ConfigurationStore } from './configuration';
import { GitService } from './git-service';
import { HostEnvironment } from './host';
import { ProfileAdapter } from './profile-adapter';
import { containsPotentialSecret, findPotentialSecrets } from './secret-scanner';
import { chooseFallbackSide, fallbackCommitMessage } from './sync-fallback';
import { RuntimeStatus, SnapshotManifest } from './types';

export class SyncEngine {
  private running = false;

  public constructor(
    private readonly environment: HostEnvironment,
    private readonly adapter: ProfileAdapter,
    private readonly git: GitService,
    private readonly ai: AiService,
    private readonly configurationStore: ConfigurationStore,
    private readonly updateStatus: (patch: Partial<RuntimeStatus>) => void,
    private readonly activeWindowCount: () => Promise<number>
  ) {}

  public async synchronize(allowStructural = false): Promise<void> {
    if (this.running) return;
    this.running = true;
    const configuration = this.configurationStore.get();
    let usedAiFallback = false;
    let recoveredPendingChanges = false;
    let temporaryRoot: string | undefined;
    try {
      if (!configuration.repositoryUrl) {
        this.updateStatus({ phase: '未配置', message: '请填写 Git 仓库地址。' });
        return;
      }
      const dirty = vscode.workspace.textDocuments.filter(
        (document) => document.isDirty && document.uri.scheme === 'file' && isInside(this.environment.userDataPath, document.uri.fsPath)
      );
      if (dirty.length) {
        this.updateStatus({ phase: '空闲', message: `有 ${dirty.length} 个未保存的配置文件，保存后再同步。` });
        return;
      }

      this.updateStatus({ phase: '正在扫描', message: undefined });
      temporaryRoot = path.join(this.environment.runtimePath, 'snapshots', `local-${process.pid}-${Date.now()}`);
      const localHostRoot = path.join(temporaryRoot, this.environment.kind);
      const includeAssociations = vscode.workspace.getConfiguration('profileGitSync').get<boolean>('includeProfileAssociations', false);
      const localManifest = await this.adapter.createSnapshot(localHostRoot, includeAssociations);
      const secretFiles = await findPotentialSecrets(localHostRoot, localManifest);
      if (secretFiles.length) {
        throw new Error(`检测到可能包含凭据的配置，已拒绝提交：${secretFiles.join('、')}`);
      }

      await this.git.prepare(configuration);
      const repositoryHostRoot = path.join(this.git.repositoryPath, '.profile-git-sync', 'hosts', this.environment.kind);
      const baseHostRoot = path.join(temporaryRoot, 'base');
      recoveredPendingChanges = await this.git.discardPendingHostChanges(this.environment.kind);
      await fs.rm(baseHostRoot, { recursive: true, force: true });
      if (await exists(repositoryHostRoot)) await fs.cp(repositoryHostRoot, baseHostRoot, { recursive: true });

      this.updateStatus({ phase: '正在拉取' });
      await this.git.pull(configuration);
      const remoteExists = await exists(path.join(repositoryHostRoot, 'manifest.json'));
      const baseExists = await exists(path.join(baseHostRoot, 'manifest.json'));

      let mergedRoot = localHostRoot;
      if (remoteExists) {
        const merged = path.join(temporaryRoot, 'merged');
        usedAiFallback = await this.mergeSnapshots(baseExists ? baseHostRoot : undefined, localHostRoot, repositoryHostRoot, merged);
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
        await this.git.commitAndPush(configuration, message);
      } else {
        await this.git.pushIfAhead(configuration);
      }

      const windows = await this.activeWindowCount();
      const restore = await this.adapter.restoreSnapshot(repositoryHostRoot, allowStructural && windows <= 1);
      if (restore.structuralChange) {
        this.updateStatus({ phase: '等待其他窗口关闭', activeWindows: windows, message: restore.message });
      }
      this.updateStatus({
        phase: restore.structuralChange ? '等待其他窗口关闭' : '空闲',
        pendingChanges: 0,
        lastSyncAt: new Date().toISOString(),
        message: finalSyncMessage(restore.message, changed.length > 0, usedAiFallback, recoveredPendingChanges)
      });
    } catch (error) {
      this.updateStatus({ phase: '失败', message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.running = false;
      if (temporaryRoot) {
        await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private async mergeSnapshots(baseRoot: string | undefined, oursRoot: string, theirsRoot: string, outputRoot: string): Promise<boolean> {
    const base = baseRoot ? await readManifest(baseRoot) : emptyManifest(this.environment.kind);
    const ours = await readManifest(oursRoot);
    const theirs = await readManifest(theirsRoot);
    const files = new Set([...Object.keys(base.files), ...Object.keys(ours.files), ...Object.keys(theirs.files)]);
    const outputFiles: Record<string, string> = {};
    const aiConflicts: string[] = [];
    const fallbackConflicts: string[] = [];
    await fs.rm(outputRoot, { recursive: true, force: true });
    await fs.mkdir(outputRoot, { recursive: true });

    for (const relative of files) {
      const baseHash = base.files[relative];
      const oursHash = ours.files[relative];
      const theirsHash = theirs.files[relative];
      let sourceRoot: string | undefined;
      let mergedContent: Buffer | undefined;
      if (oursHash === baseHash) sourceRoot = theirsHash ? theirsRoot : undefined;
      else if (theirsHash === baseHash || oursHash === theirsHash) sourceRoot = oursHash ? oursRoot : undefined;
      else {
        const [baseText, oursText, theirsText] = await Promise.all([
          readOptionalText(baseRoot, relative),
          readOptionalText(oursRoot, relative),
          readOptionalText(theirsRoot, relative)
        ]);
        let aiCandidateAccepted = false;
        if (![baseText, oursText, theirsText].some(containsPotentialSecret)) {
          try {
            const candidate = await this.ai.resolveConflict(relative, baseText, oursText, theirsText);
            validateCandidate(relative, candidate);
            mergedContent = Buffer.from(candidate, 'utf8');
            aiCandidateAccepted = true;
            aiConflicts.push(relative);
          } catch {
            // AI 不可用或结果无效时，继续使用确定性兜底。
          }
        }
        if (!aiCandidateAccepted) {
          const fallbackSide = chooseFallbackSide(oursHash, theirsHash);
          sourceRoot = fallbackSide === 'ours' ? oursRoot : fallbackSide === 'theirs' ? theirsRoot : undefined;
          fallbackConflicts.push(relative);
        }
      }
      if (!sourceRoot && !mergedContent) continue;
      const content = mergedContent ?? await fs.readFile(resolveSnapshotPath(sourceRoot!, relative));
      const target = resolveSnapshotPath(outputRoot, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
      outputFiles[relative] = sha256(content);
    }

    if (aiConflicts.length) {
      this.updateStatus({ phase: '存在冲突', message: `AI 已生成 ${aiConflicts.length} 个冲突合并候选。` });
      const choice = await vscode.window.showWarningMessage(
        `AI 已合并这些配置冲突：${aiConflicts.join('、')}。是否应用并提交？`,
        { modal: true },
        '应用合并结果'
      );
      if (choice !== '应用合并结果') throw new Error('用户取消了 AI 冲突合并，远程与本机配置均未改写。');
    }

    const profiles = sameProfiles(base, ours) ? theirs.profiles : ours.profiles;
    const manifest: SnapshotManifest = {
      schemaVersion: 1,
      host: this.environment.kind,
      createdAt: '',
      profiles,
      profileMetadata: sameProfiles(base, ours) ? theirs.profileMetadata : ours.profileMetadata,
      ...(sameProfiles(base, ours) && theirs.profileAssociations !== undefined
        ? { profileAssociations: theirs.profileAssociations }
        : ours.profileAssociations !== undefined
          ? { profileAssociations: ours.profileAssociations }
          : {}),
      files: outputFiles
    };
    await fs.writeFile(path.join(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return fallbackConflicts.length > 0;
  }
}

async function readManifest(root: string): Promise<SnapshotManifest> {
  return JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8')) as SnapshotManifest;
}

function emptyManifest(host: 'vscode' | 'cursor'): SnapshotManifest {
  return { schemaVersion: 1, host, createdAt: '', profiles: [], files: {} };
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

function sameProfiles(left: SnapshotManifest, right: SnapshotManifest): boolean {
  return JSON.stringify(left.profiles) === JSON.stringify(right.profiles);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function finalSyncMessage(
  structuralMessage: string | undefined,
  changed: boolean,
  usedAiFallback: boolean,
  recoveredPendingChanges: boolean
): string {
  if (structuralMessage) return structuralMessage;
  if (!changed) return recoveredPendingChanges ? '已清理上次中断的暂存状态，配置已是最新。' : '配置已是最新。';
  const notes: string[] = [];
  if (usedAiFallback) notes.push('AI 不可用或结果无效，已使用兜底策略');
  if (recoveredPendingChanges) notes.push('已清理上次中断的暂存状态');
  return notes.length ? `同步完成（${notes.join('；')}）。` : '同步完成。';
}

async function exists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false);
}
