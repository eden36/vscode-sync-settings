import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse, ParseError } from 'jsonc-parser';
import { AiService, stripJsonFence } from './ai';
import { ConflictStrategy, PendingConflictView } from './conflict-types';
import { ConfigurationStore } from './configuration';
import { WindowSafetySnapshot } from './coordinator';
import { ConfigurationRepositoryGitService } from './git-service';
import { HostEnvironment } from './host';
import { ProfileAdapter } from './profile-adapter';
import { containsPotentialSecret, findPotentialSecrets } from './secret-scanner';
import { fallbackCommitMessage } from './sync-fallback';
import { collectExtensionIdsFromFiles, waitForExtensions } from './extension-wait';
import { detectSnapshotConflicts } from './snapshot-conflict';
import { RuntimeStatus, SnapshotManifest, SyncOutcome } from './types';

interface PendingProfileConflict {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  repositoryUrl: string;
  branch: string;
  remoteHead?: string;
  localFingerprint: string;
  conflicts: string[];
  hasBase: boolean;
  aiCandidateReady?: boolean;
  aiError?: string;
}

export class SyncEngine {
  private running = false;
  private readonly pendingConflictPath: string;
  private readonly pendingConflictRoot: string;

  public constructor(
    private readonly environment: HostEnvironment,
    private readonly adapter: ProfileAdapter,
    private readonly git: ConfigurationRepositoryGitService,
    private readonly ai: AiService,
    private readonly configurationStore: ConfigurationStore,
    private readonly updateStatus: (patch: Partial<RuntimeStatus>) => void,
    private readonly windowSafety: () => Promise<WindowSafetySnapshot>,
  ) {
    this.pendingConflictPath = path.join(environment.runtimePath, 'pending-profile-conflict.json');
    this.pendingConflictRoot = path.join(environment.runtimePath, 'pending-profile-conflict');
  }

  public async pendingConflictView(): Promise<PendingConflictView | undefined> {
    const conflict = await this.readPendingConflict();
    if (!conflict) return undefined;
    return {
      id: conflict.id,
      kind: 'profileSnapshot',
      title: conflict.aiCandidateReady ? 'AI 已生成合并方案' : '发现配置冲突，已暂停同步',
      description: conflict.aiCandidateReady
        ? `AI 已合并 ${conflict.conflicts.length} 项冲突并通过检查。确认后将同时更新本机和云端。`
        : '云端和本机包含不同修改。请选择要保留的版本，处理前不会覆盖任何一方。',
      items: conflict.conflicts,
      aiCandidateReady: conflict.aiCandidateReady === true,
      ...(conflict.aiError ? { aiError: conflict.aiError } : {}),
    };
  }

  public async synchronize(allowStructural = false): Promise<SyncOutcome | undefined> {
    if (this.running) return undefined;
    this.running = true;
    const configuration = this.configurationStore.get();
    let usedAiFallback = false;
    let recoveredPendingChanges = false;
    let temporaryRoot: string | undefined;
    try {
      if (this.configurationStore.hasConflict()) {
        this.updateStatus({ phase: '存在冲突', message: '请先处理同步设置冲突。' });
        return { ok: false, blockedByConflict: true };
      }
      if (await this.readPendingConflict()) {
        this.updateStatus({ phase: '存在冲突', message: '云端和本机配置存在冲突，请在同步状态中选择处理方式。' });
        return { ok: false, blockedByConflict: true };
      }
      if (!configuration.repositoryUrl) {
        this.updateStatus({ phase: '未配置', message: '请填写 Git 仓库地址。' });
        return { ok: false };
      }
      if (!await this.ensureWindowSafety()) return { ok: false, retry: true };

      this.updateStatus({ phase: '正在扫描', message: undefined });
      temporaryRoot = path.join(this.environment.runtimePath, 'snapshots', `local-${process.pid}-${Date.now()}`);
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
      await fs.rm(baseHostRoot, { recursive: true, force: true });
      if (await exists(repositoryHostRoot)) await fs.cp(repositoryHostRoot, baseHostRoot, { recursive: true });

      this.updateStatus({ phase: '正在拉取' });
      await this.git.pull(configuration);
      const remoteExists = await exists(path.join(repositoryHostRoot, 'manifest.json'));
      const baseExists = await exists(path.join(baseHostRoot, 'manifest.json'));

      let mergedRoot = localHostRoot;
      if (remoteExists) {
        const conflicts = await detectSnapshotConflicts(baseExists ? baseHostRoot : undefined, localHostRoot, repositoryHostRoot, this.environment.kind);
        if (conflicts.length) {
          await this.persistProfileConflict(
            baseExists ? baseHostRoot : undefined,
            localHostRoot,
            repositoryHostRoot,
            conflicts,
            configuration.repositoryUrl,
            configuration.branch,
          );
          this.updateStatus({ phase: '存在冲突', message: `发现 ${conflicts.length} 项配置冲突，已暂停同步。` });
          return { ok: false, blockedByConflict: true };
        }
        const merged = path.join(temporaryRoot, 'merged');
        await this.mergeSnapshots(baseExists ? baseHostRoot : undefined, localHostRoot, repositoryHostRoot, merged, false);
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

      const safety = await this.ensureWindowSafety();
      if (!safety) return { ok: false, retry: true };
      const restore = await this.adapter.restoreSnapshot(repositoryHostRoot, allowStructural && safety.activeWindows <= 1);
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
      if (restore.structuralChange) {
        this.updateStatus({ phase: '等待其他窗口关闭', activeWindows: safety.activeWindows, message: restore.message });
      }
      this.updateStatus({
        phase: restore.structuralChange ? '等待其他窗口关闭' : '空闲',
        pendingChanges: 0,
        lastSyncAt: new Date().toISOString(),
        message: finalSyncMessage(
          restore.message,
          changed.length > 0,
          usedAiFallback,
          recoveredPendingChanges,
          extensionsPending
        )
      });
      return { ok: true, extensionsPending };
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

  public async prepareConflictAiCandidate(id: string): Promise<void> {
    const conflict = await this.requireCurrentConflict(id);
    const roots = this.conflictRoots(conflict.id);
    this.updateStatus({ phase: '等待 AI', message: `正在合并 ${conflict.conflicts.length} 项冲突…` });
    try {
      await fs.rm(roots.candidate, { recursive: true, force: true });
      await this.mergeSnapshots(conflict.hasBase ? roots.base : undefined, roots.local, roots.cloud, roots.candidate, true);
      const manifest = await readManifest(roots.candidate);
      const secrets = await findPotentialSecrets(roots.candidate, manifest);
      if (secrets.length) throw new Error(`AI 合并结果可能包含凭据：${secrets.join('、')}`);
      conflict.aiCandidateReady = true;
      delete conflict.aiError;
      await atomicWriteJson(this.pendingConflictPath, conflict);
      this.updateStatus({ phase: '存在冲突', message: 'AI 已生成合并方案，请确认后应用。' });
    } catch (error) {
      conflict.aiCandidateReady = false;
      conflict.aiError = safeErrorMessage(error);
      await atomicWriteJson(this.pendingConflictPath, conflict);
      this.updateStatus({ phase: '存在冲突', message: `AI 合并失败：${conflict.aiError}` });
      throw error;
    }
  }

  public async resolvePendingConflict(id: string, strategy: ConflictStrategy): Promise<void> {
    const conflict = await this.requireCurrentConflict(id);
    if (strategy === 'ai' && !conflict.aiCandidateReady) throw new Error('AI 尚未生成可应用的合并方案。');
    const safety = await this.windowSafety();
    if (safety.dirtyWindows > 0 || safety.unreadableWindows > 0) throw new Error('存在未保存或状态无法确认的窗口，暂时无法应用冲突选择。');
    if (safety.activeWindows > 1) throw new Error('请关闭其他 IDE 窗口后再应用冲突选择。');

    const roots = this.conflictRoots(conflict.id);
    const selected = strategy === 'cloud' ? roots.cloud : strategy === 'local' ? roots.local : roots.candidate;
    const configuration = this.configurationStore.get();
    const repositoryHostRoot = path.join(this.git.repositoryPath, '.profile-git-sync', 'hosts', this.environment.kind);
    if (strategy !== 'cloud') {
      await fs.rm(repositoryHostRoot, { recursive: true, force: true });
      await fs.mkdir(path.dirname(repositoryHostRoot), { recursive: true });
      await fs.cp(selected, repositoryHostRoot, { recursive: true });
      const changed = await this.git.stageHost(this.environment.kind);
      if (changed.length) await this.git.commitAndPush(configuration, fallbackCommitMessage(this.environment.kind));
    }
    if (strategy !== 'local') await this.adapter.restoreSnapshot(selected, true);
    await this.clearPendingConflict(conflict.id);
    this.updateStatus({
      phase: '空闲',
      pendingChanges: 0,
      lastSyncAt: new Date().toISOString(),
      message: strategy === 'cloud' ? '已使用云端完整版本。' : strategy === 'local' ? '已使用本机完整版本。' : '已应用 AI 合并结果。',
    });
  }

  private async persistProfileConflict(
    baseRoot: string | undefined,
    localRoot: string,
    cloudRoot: string,
    conflicts: string[],
    repositoryUrl: string,
    branch: string,
  ): Promise<void> {
    const id = randomUUID();
    const roots = this.conflictRoots(id);
    await fs.rm(this.pendingConflictRoot, { recursive: true, force: true });
    await fs.mkdir(roots.root, { recursive: true });
    await Promise.all([
      fs.cp(localRoot, roots.local, { recursive: true }),
      fs.cp(cloudRoot, roots.cloud, { recursive: true }),
      ...(baseRoot ? [fs.cp(baseRoot, roots.base, { recursive: true })] : []),
    ]);
    const conflict: PendingProfileConflict = {
      schemaVersion: 1,
      id,
      createdAt: new Date().toISOString(),
      repositoryUrl,
      branch,
      remoteHead: await this.git.head(),
      localFingerprint: await this.adapter.fingerprint(),
      conflicts,
      hasBase: baseRoot !== undefined,
    };
    await atomicWriteJson(this.pendingConflictPath, conflict);
  }

  private async requireCurrentConflict(id: string): Promise<PendingProfileConflict> {
    const conflict = await this.readPendingConflict();
    if (!conflict || conflict.id !== id) throw new Error('待处理的配置冲突已不存在。');
    const configuration = this.configurationStore.get();
    if (configuration.repositoryUrl !== conflict.repositoryUrl || configuration.branch !== conflict.branch) {
      await this.clearPendingConflict(conflict.id);
      throw new Error('同步仓库设置已变化，请重新同步并检测冲突。');
    }
    if (await this.adapter.fingerprint() !== conflict.localFingerprint) {
      await this.clearPendingConflict(conflict.id);
      throw new Error('本机配置已变化，请重新同步并检测冲突。');
    }
    await this.git.prepare(configuration);
    await this.git.pull(configuration);
    if (await this.git.head() !== conflict.remoteHead) {
      await this.clearPendingConflict(conflict.id);
      throw new Error('云端配置已变化，请重新同步并检测冲突。');
    }
    return conflict;
  }

  private async readPendingConflict(): Promise<PendingProfileConflict | undefined> {
    return parsePendingProfileConflict(await readJsonFile(this.pendingConflictPath));
  }

  private conflictRoots(id: string) {
    const root = path.join(this.pendingConflictRoot, id);
    return {
      root,
      base: path.join(root, 'base'),
      local: path.join(root, 'local'),
      cloud: path.join(root, 'cloud'),
      candidate: path.join(root, 'candidate'),
    };
  }

  private async clearPendingConflict(id: string): Promise<void> {
    await Promise.all([
      fs.rm(this.pendingConflictPath, { force: true }),
      fs.rm(path.join(this.pendingConflictRoot, id), { recursive: true, force: true }),
    ]);
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

  private async mergeSnapshots(
    baseRoot: string | undefined,
    oursRoot: string,
    theirsRoot: string,
    outputRoot: string,
    useAi: boolean,
  ): Promise<void> {
    const base = baseRoot ? await readManifest(baseRoot) : emptyManifest(this.environment.kind);
    const ours = await readManifest(oursRoot);
    const theirs = await readManifest(theirsRoot);
    const files = new Set([...Object.keys(base.files), ...Object.keys(ours.files), ...Object.keys(theirs.files)]);
    const outputFiles: Record<string, string> = {};
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
        if (!useAi) throw new Error(`尚未处理配置冲突：${relative}`);
        const [baseText, oursText, theirsText] = await Promise.all([
          readOptionalText(baseRoot, relative),
          readOptionalText(oursRoot, relative),
          readOptionalText(theirsRoot, relative)
        ]);
        if ([baseText, oursText, theirsText].some(containsPotentialSecret)) throw new Error(`冲突文件可能包含凭据，无法交给 AI：${relative}`);
        const candidate = await this.ai.resolveConflict(relative, baseText, oursText, theirsText);
        validateCandidate(relative, candidate);
        mergedContent = Buffer.from(candidate, 'utf8');
      }
      if (!sourceRoot && !mergedContent) continue;
      const content = mergedContent ?? await fs.readFile(resolveSnapshotPath(sourceRoot!, relative));
      const target = resolveSnapshotPath(outputRoot, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
      outputFiles[relative] = sha256(content);
    }

    const structure = await mergeProfileStructure(this.ai, base, ours, theirs, useAi);
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

async function mergeProfileStructure(
  ai: AiService,
  base: SnapshotManifest,
  local: SnapshotManifest,
  cloud: SnapshotManifest,
  useAi: boolean,
): Promise<ReturnType<typeof snapshotStructure>> {
  const baseStructure = snapshotStructure(base);
  const localStructure = snapshotStructure(local);
  const cloudStructure = snapshotStructure(cloud);
  if (sameValue(localStructure, baseStructure)) return cloudStructure;
  if (sameValue(cloudStructure, baseStructure) || sameValue(localStructure, cloudStructure)) return localStructure;
  if (!useAi) throw new Error('尚未处理 Profile 结构和关联关系冲突。');
  const texts = [baseStructure, localStructure, cloudStructure].map((value) => JSON.stringify(value, null, 2));
  if (texts.some(containsPotentialSecret)) throw new Error('Profile 结构可能包含凭据，无法交给 AI。');
  const candidate = stripJsonFence(await ai.resolveConflict('Profile 结构和关联关系', texts[0]!, texts[1]!, texts[2]!));
  validateCandidate('profile-structure.json', candidate);
  return parseProfileStructure(JSON.parse(candidate) as unknown);
}

/** AI 返回的结构会直接写入 storage.json，必须逐项校验，避免破坏本机 Profile 存储。 */
function parseProfileStructure(value: unknown): ReturnType<typeof snapshotStructure> {
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

function snapshotStructure(manifest: SnapshotManifest) {
  return {
    profiles: manifest.profiles,
    ...(manifest.profileMetadata !== undefined ? { profileMetadata: manifest.profileMetadata } : {}),
    ...(manifest.profileAssociations !== undefined ? { profileAssociations: manifest.profileAssociations } : {}),
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function finalSyncMessage(
  structuralMessage: string | undefined,
  changed: boolean,
  usedAiFallback: boolean,
  recoveredPendingChanges: boolean,
  extensionsPending?: string[]
): string {
  if (structuralMessage) return structuralMessage;
  if (!changed) return recoveredPendingChanges ? '已清理上次中断的暂存状态，配置已是最新。' : '配置已是最新。';
  const notes: string[] = [];
  if (usedAiFallback) notes.push('AI 不可用或结果无效，已使用兜底策略');
  if (recoveredPendingChanges) notes.push('已清理上次中断的暂存状态');
  if (extensionsPending?.length) {
    notes.push(`部分扩展尚未安装完成：${extensionsPending.join('、')}`);
  }
  return notes.length ? `同步完成（${notes.join('；')}）。` : '同步完成。';
}

async function exists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false);
}

async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' });
  try {
    await fs.rename(temporary, filePath);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    await fs.rm(filePath, { force: true });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function parsePendingProfileConflict(value: unknown): PendingProfileConflict | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.id !== 'string') return undefined;
  if (typeof value.createdAt !== 'string' || typeof value.repositoryUrl !== 'string' || typeof value.branch !== 'string') return undefined;
  if (value.remoteHead !== undefined && typeof value.remoteHead !== 'string') return undefined;
  if (typeof value.localFingerprint !== 'string' || typeof value.hasBase !== 'boolean') return undefined;
  if (!Array.isArray(value.conflicts) || !value.conflicts.every((item) => typeof item === 'string')) return undefined;
  if (value.aiCandidateReady !== undefined && typeof value.aiCandidateReady !== 'boolean') return undefined;
  if (value.aiError !== undefined && typeof value.aiError !== 'string') return undefined;
  return value as unknown as PendingProfileConflict;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ').slice(0, 500);
}
