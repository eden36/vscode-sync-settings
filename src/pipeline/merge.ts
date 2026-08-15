import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse, ParseError } from 'jsonc-parser';
import { AiService, stripJsonFence } from '../ai';
import { containsPotentialSecret, findPotentialSecrets } from '../secret-scanner';
import {
  classifyThreeWay,
  emptyManifest,
  readManifest,
  resolveConflictFallback,
  snapshotStructure,
  SnapshotStructure,
} from '../snapshot-conflict';
import { MergeReport, SnapshotManifest } from '../types';
import { backupConflictSnapshots } from './backup';
import { requireValue, Stage, StageOutcome, SyncContext } from './types';

const STRUCTURE_LABEL = 'Profile 结构和关联关系';

export const mergeStage: Stage = {
  name: 'merge',
  async run(context: SyncContext): Promise<StageOutcome> {
    const { conflictBackupRoot } = context.dependencies;
    const { localHostRoot, repositoryHostRoot, baseHostRoot, temporaryRoot } = context.paths;
    const strategy = requireValue(context.artifacts.strategy, 'strategy');

    // 首次接入或重建后没有可信合并基准，必须整包采用云端，本轮不改写仓库内容。
    if (strategy === 'adopt') {
      await backupConflictSnapshots(conflictBackupRoot, localHostRoot, repositoryHostRoot);
      return { kind: 'continue' };
    }

    // 远端还没有本宿主的快照时（例如同一仓库先接入了另一个宿主），直接用本机内容初始化，没有可合并的对方。
    let mergedRoot = localHostRoot;
    if (requireValue(context.artifacts.remoteExists, 'remoteExists')) {
      const baseExists = await exists(path.join(baseHostRoot, 'manifest.json'));
      const merged = path.join(temporaryRoot, 'merged');
      const report = await mergeSnapshots(context, baseExists ? baseHostRoot : undefined, localHostRoot, repositoryHostRoot, merged);
      context.report.merge = report;
      if (report.conflicts.length) await backupConflictSnapshots(conflictBackupRoot, localHostRoot, repositoryHostRoot);
      mergedRoot = merged;
    }

    await fs.rm(repositoryHostRoot, { recursive: true, force: true });
    await fs.mkdir(path.dirname(repositoryHostRoot), { recursive: true });
    await fs.cp(mergedRoot, repositoryHostRoot, { recursive: true });

    const mergedManifest = await readManifest(repositoryHostRoot);
    const mergedSecrets = await findPotentialSecrets(repositoryHostRoot, mergedManifest);
    if (mergedSecrets.length) throw new Error(`检测到可能包含凭据的配置，已拒绝同步：${mergedSecrets.join('、')}`);
    return { kind: 'continue' };
  },
};

/** 冲突一律自动收敛：优先 AI 合并，AI 不可用或结果无效时按确定性规则择一，绝不中断同步。 */
async function mergeSnapshots(
  context: SyncContext,
  baseRoot: string | undefined,
  localRoot: string,
  cloudRoot: string,
  outputRoot: string,
): Promise<MergeReport> {
  const { ai, environment, updateStatus } = context.dependencies;
  const base = baseRoot ? await readManifest(baseRoot) : emptyManifest(environment.kind);
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
        updateStatus({ sync: { kind: 'running', stage: 'ai' }, message: `正在自动合并：${relative}` });
        try {
          mergedContent = await aiMergeFile(ai, baseRoot, localRoot, cloudRoot, relative);
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

  const structure = await mergeStructure(context, base, local, cloud, aiAvailable, report);
  const manifest: SnapshotManifest = {
    schemaVersion: 1,
    host: environment.kind,
    createdAt: '',
    profiles: structure.profiles,
    ...(structure.profileMetadata !== undefined ? { profileMetadata: structure.profileMetadata } : {}),
    ...(structure.profileAssociations !== undefined ? { profileAssociations: structure.profileAssociations } : {}),
    files: outputFiles
  };
  await fs.writeFile(path.join(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return report;
}

async function aiMergeFile(
  ai: AiService,
  baseRoot: string | undefined,
  localRoot: string,
  cloudRoot: string,
  relative: string,
): Promise<Buffer> {
  const [baseText, localText, cloudText] = await Promise.all([
    readOptionalText(baseRoot, relative),
    readOptionalText(localRoot, relative),
    readOptionalText(cloudRoot, relative)
  ]);
  if ([baseText, localText, cloudText].some(containsPotentialSecret)) throw new Error(`冲突文件可能包含凭据，无法交给 AI：${relative}`);
  const candidate = await ai.resolveConflict(relative, baseText, localText, cloudText);
  validateCandidate(relative, candidate);
  return Buffer.from(candidate, 'utf8');
}

async function mergeStructure(
  context: SyncContext,
  base: SnapshotManifest,
  local: SnapshotManifest,
  cloud: SnapshotManifest,
  aiAvailable: boolean,
  report: MergeReport,
): Promise<SnapshotStructure> {
  const { ai, updateStatus } = context.dependencies;
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
      updateStatus({ sync: { kind: 'running', stage: 'ai' }, message: `正在自动合并：${STRUCTURE_LABEL}` });
      const candidate = stripJsonFence(await ai.resolveConflict(STRUCTURE_LABEL, texts[0]!, texts[1]!, texts[2]!));
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function safeErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ').slice(0, 500);
}

async function exists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false);
}
