import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { applyEdits, modify, parse } from 'jsonc-parser';
import type { HostEnvironment } from './host';
import { ProfileDescriptor, SnapshotManifest } from './types';

const FILE_RESOURCES = ['settings.json', 'keybindings.json', 'tasks.json', 'extensions.json', 'mcp.json'];
const DIRECTORY_RESOURCES = ['snippets', 'prompts'];
const TEMPORARY_MARKER = '.profile-git-sync-';
const PLUGIN_SETTING_PREFIX = 'profileGitSync.';
const BACKUP_RETENTION = 10;
const STABLE_READ_RETRY_MS = 80;

interface StoredProfile {
  location?: string;
  name?: string;
  [key: string]: unknown;
}

interface StorageFile {
  userDataProfiles?: StoredProfile[];
  profileAssociations?: unknown;
}

export interface RestoreResult {
  changedFiles: string[];
  structuralChange: boolean;
  structuralApplied: boolean;
  message?: string;
}

export class ProfileAdapter {
  private readonly fingerprintCache = new Map<string, { mtimeMs: number; size: number; hash: string }>();

  public constructor(private readonly environment: HostEnvironment) {}

  public async listProfiles(): Promise<ProfileDescriptor[]> {
    const profiles: ProfileDescriptor[] = [
      { id: 'default', name: '默认', location: this.environment.userDataPath, isDefault: true }
    ];
    const storage = await this.readStorage();
    for (const profile of storage.userDataProfiles ?? []) {
      if (!profile.location || !profile.name || !isSafeSegment(profile.location)) {
        continue;
      }
      profiles.push({
        id: profile.location,
        name: profile.name,
        location: path.join(this.environment.userDataPath, 'profiles', profile.location),
        isDefault: false
      });
    }
    return profiles;
  }

  public async fingerprint(): Promise<string> {
    const profiles = (await this.listProfiles()).sort((left, right) => left.id.localeCompare(right.id));
    const hash = createHash('sha256');
    for (const profile of profiles) {
      hash.update(`${profile.id}\0${profile.name}\0${profile.isDefault ? '1' : '0'}\0`);
      for (const resource of FILE_RESOURCES) {
        const fileHash = await this.portableHash(path.join(profile.location, resource), resource);
        if (fileHash) hash.update(resource).update(fileHash);
      }
      for (const resource of DIRECTORY_RESOURCES) {
        const root = path.join(profile.location, resource);
        const files = (await collectFiles(root)).sort();
        for (const file of files) {
          const fileHash = await this.portableHash(file, path.basename(file));
          if (fileHash) hash.update(path.relative(root, file)).update(fileHash);
        }
      }
    }
    return hash.digest('hex');
  }

  /** 指纹按提交到仓库的形态计算，本机专属内容变化不应触发同步；未变化的文件直接复用缓存哈希。 */
  private async portableHash(filePath: string, resource: string): Promise<string | undefined> {
    const stat = await fs.stat(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!stat) return undefined;
    const cached = this.fingerprintCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.hash;
    const hash = sha256(this.prepareForRepository(resource, await stableRead(filePath)));
    this.fingerprintCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, hash });
    return hash;
  }

  public async createSnapshot(hostRoot: string, includeAssociations = false): Promise<SnapshotManifest> {
    const profiles = await this.listProfiles();
    const storage = await this.readStorage();
    const staging = `${hostRoot}.staging-${process.pid}-${Date.now()}`;
    await fs.rm(staging, { recursive: true, force: true });
    await fs.mkdir(staging, { recursive: true });

    const files: Record<string, string> = {};
    for (const profile of profiles) {
      const targetRoot = path.join(staging, 'profiles', profile.id);
      for (const resource of FILE_RESOURCES) {
        await this.snapshotFile(profile.location, resource, targetRoot, files, profile.id);
      }
      for (const resource of DIRECTORY_RESOURCES) {
        await this.snapshotDirectory(profile.location, resource, targetRoot, files, profile.id);
      }
    }

    const manifest: SnapshotManifest = {
      schemaVersion: 1,
      host: this.environment.kind,
      createdAt: '',
      profiles: profiles.map(({ id, name, isDefault }) => ({ id, name, isDefault })),
      profileMetadata: storage.userDataProfiles?.map((profile) => ({ ...profile })),
      ...(includeAssociations && storage.profileAssociations !== undefined
        ? { profileAssociations: storage.profileAssociations }
        : {}),
      files
    };
    await fs.writeFile(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await replaceDirectory(staging, hostRoot);
    return manifest;
  }

  public async restoreSnapshot(hostRoot: string, allowStructural: boolean): Promise<RestoreResult> {
    const manifestPath = path.join(hostRoot, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as SnapshotManifest;
    if (manifest.schemaVersion !== 1 || manifest.host !== this.environment.kind) {
      throw new Error('远程快照格式或宿主类型不兼容。');
    }

    const localProfiles = await this.listProfiles();
    const localIds = new Set(localProfiles.map((profile) => profile.id));
    const remoteIds = new Set(manifest.profiles.map((profile) => profile.id));
    const structuralChange = !setsEqual(localIds, remoteIds);
    if (structuralChange && !allowStructural) {
      return {
        changedFiles: [],
        structuralChange,
        structuralApplied: false,
        message: '远程包含 Profile 增删，只剩一个窗口时会自动应用。',
      };
    }

    if (structuralChange) {
      await this.restoreProfileStructure(manifest);
    }

    const refreshedProfiles = structuralChange ? await this.listProfiles() : localProfiles;
    const localById = new Map(refreshedProfiles.map((profile) => [profile.id, profile]));
    const changedFiles: string[] = [];
    const backupsRoot = path.join(this.environment.runtimePath, 'backups');
    const backupRoot = path.join(backupsRoot, new Date().toISOString().replaceAll(':', '-'));
    for (const profile of refreshedProfiles) {
      for (const resource of FILE_RESOURCES) {
        const relative = `profiles/${profile.id}/${resource}`;
        const target = path.join(profile.location, resource);
        if (!manifest.files[relative] && await pathExists(target)) {
          await backupAndRemove(target, path.join(backupRoot, profile.id, resource));
          changedFiles.push(target);
        }
      }
      for (const resource of DIRECTORY_RESOURCES) {
        const root = path.join(profile.location, resource);
        for (const target of await collectFiles(root)) {
          const nested = path.relative(root, target).split(path.sep).join('/');
          const relative = `profiles/${profile.id}/${resource}/${nested}`;
          if (!manifest.files[relative]) {
            await backupAndRemove(target, path.join(backupRoot, profile.id, resource, ...nested.split('/')));
            changedFiles.push(target);
          }
        }
      }
    }
    for (const relative of Object.keys(manifest.files)) {
      const normalized = normalizeRelative(relative);
      const parts = normalized.split('/');
      if (parts[0] !== 'profiles' || parts.length < 3) {
        throw new Error(`快照包含非法路径：${relative}`);
      }
      const profile = localById.get(parts[1] ?? '');
      if (!profile) {
        continue;
      }
      const resourcePath = parts.slice(2).join(path.sep);
      const target = resolveInside(profile.location, resourcePath);
      const source = resolveInside(hostRoot, normalized);
      const sourceContent = await stableRead(source);
      const currentContent = await fs.readFile(target).catch(() => undefined);
      const localContent = this.prepareForLocal(relative, sourceContent, currentContent);
      if (currentContent?.equals(localContent)) {
        continue;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await atomicWrite(target, localContent, this.stagingPath);
      changedFiles.push(target);
    }
    await pruneBackups(backupsRoot);
    return { changedFiles, structuralChange, structuralApplied: structuralChange };
  }

  private async restoreProfileStructure(manifest: SnapshotManifest): Promise<void> {
    const metadata = manifest.profileMetadata;
    if (!metadata) throw new Error('远程快照缺少 Profile 元数据，无法安全应用结构变化。');
    const locations = metadata.map((profile) => profile.location);
    if (!locations.every((location) => typeof location === 'string' && isSafeSegment(location))) {
      throw new Error('远程 Profile 元数据包含非法目录。');
    }
    const expected = new Set(manifest.profiles.filter((profile) => !profile.isDefault).map((profile) => profile.id));
    if (!setsEqual(expected, new Set(locations as string[]))) {
      throw new Error('远程 Profile 清单与元数据不一致。');
    }
    const storagePath = path.join(this.environment.userDataPath, 'globalStorage', 'storage.json');
    const profilesPath = path.join(this.environment.userDataPath, 'profiles');
    const backupRoot = path.join(this.environment.runtimePath, 'backups', `structure-${new Date().toISOString().replaceAll(':', '-')}`);
    await fs.mkdir(backupRoot, { recursive: true });
    await fs.copyFile(storagePath, path.join(backupRoot, 'storage.json'));
    if (await pathExists(profilesPath)) await fs.cp(profilesPath, path.join(backupRoot, 'profiles'), { recursive: true });

    const storage = await this.readStorage();
    storage.userDataProfiles = metadata as StoredProfile[];
    if (manifest.profileAssociations !== undefined) storage.profileAssociations = manifest.profileAssociations;
    await atomicWrite(storagePath, Buffer.from(`${JSON.stringify(storage, null, 2)}\n`, 'utf8'), this.stagingPath);
    const allowed = new Set(locations as string[]);
    for (const entry of await fs.readdir(profilesPath).catch(() => [])) {
      if (!allowed.has(entry)) await fs.rm(path.join(profilesPath, entry), { recursive: true, force: true });
    }
    for (const location of allowed) await fs.mkdir(path.join(profilesPath, location), { recursive: true });
  }

  private async snapshotFile(
    sourceRoot: string,
    resource: string,
    targetRoot: string,
    files: Record<string, string>,
    profileId: string
  ): Promise<void> {
    const source = path.join(sourceRoot, resource);
    const content = await stableRead(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!content) return;
    const portableContent = this.prepareForRepository(resource, content);
    const target = path.join(targetRoot, resource);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, portableContent);
    files[`profiles/${profileId}/${resource}`] = sha256(portableContent);
  }

  private async snapshotDirectory(
    sourceRoot: string,
    resource: string,
    targetRoot: string,
    files: Record<string, string>,
    profileId: string
  ): Promise<void> {
    const root = path.join(sourceRoot, resource);
    const sorted = (await collectFiles(root)).sort((left, right) => left.localeCompare(right));
    for (const absolute of sorted) {
      const relative = path.relative(root, absolute);
      const content = await stableRead(absolute);
      const target = path.join(targetRoot, resource, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
      files[`profiles/${profileId}/${resource}/${relative.split(path.sep).join('/')}`] = sha256(content);
    }
  }

  private async readStorage(): Promise<StorageFile> {
    const storagePath = path.join(this.environment.userDataPath, 'globalStorage', 'storage.json');
    try {
      return JSON.parse((await stableRead(storagePath)).toString('utf8')) as StorageFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new Error(`无法读取 Profile 元数据：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private get stagingPath(): string {
    return path.join(this.environment.runtimePath, 'staging');
  }

  private prepareForRepository(resource: string, content: Buffer): Buffer {
    // 插件自身设置由版本化配置记录负责收敛，随 settings.json 同步会与之互相覆盖。
    if (resource === 'settings.json') return Buffer.from(stripPluginSettings(content.toString('utf8')), 'utf8');
    if (resource !== 'extensions.json' || !this.environment.extensionDataUri) return content;
    return Buffer.from(content.toString('utf8').replaceAll(this.environment.extensionDataUri, '%%EXTENSION_DATA_PATH%%'), 'utf8');
  }

  private prepareForLocal(relative: string, content: Buffer, current: Buffer | undefined): Buffer {
    if (relative.endsWith('/settings.json')) {
      return Buffer.from(restorePluginSettings(content.toString('utf8'), current?.toString('utf8') ?? ''), 'utf8');
    }
    if (!relative.endsWith('/extensions.json') || !this.environment.extensionDataUri) return content;
    return Buffer.from(content.toString('utf8').replaceAll('%%EXTENSION_DATA_PATH%%', this.environment.extensionDataUri), 'utf8');
  }
}

async function stableRead(filePath: string): Promise<Buffer> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // 用户正在编辑时连续读取容易落在同一次写入窗口内，重试之间必须等待。
    if (attempt > 0) await delay(STABLE_READ_RETRY_MS * attempt);
    const before = await fs.stat(filePath);
    const content = await fs.readFile(filePath);
    const after = await fs.stat(filePath);
    if (before.size === after.size && before.mtimeMs === after.mtimeMs) return content;
  }
  throw new Error(`配置文件持续变化，暂缓同步：${filePath}`);
}

/** 临时文件必须写在运行目录，否则崩溃残留会被快照当成用户配置提交到仓库。 */
async function atomicWrite(target: string, content: Buffer, stagingRoot: string): Promise<void> {
  await fs.mkdir(stagingRoot, { recursive: true });
  const token = `${process.pid}-${randomUUID()}`;
  const temporary = path.join(stagingRoot, `write-${token}`);
  const previous = path.join(stagingRoot, `previous-${token}`);
  await fs.writeFile(temporary, content);
  await fs.rm(previous, { force: true });
  try {
    await fs.rename(target, previous);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    await fs.rename(temporary, target);
    await fs.rm(previous, { force: true });
  } catch (error) {
    await fs.rename(previous, target).catch(() => undefined);
    throw error;
  }
}

async function replaceDirectory(source: string, target: string): Promise<void> {
  const backup = `${target}.previous-${process.pid}`;
  await fs.rm(backup, { recursive: true, force: true });
  try {
    await fs.rename(target, backup);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    await fs.rename(source, target);
    await fs.rm(backup, { recursive: true, force: true });
  } catch (error) {
    await fs.rename(backup, target).catch(() => undefined);
    throw error;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false);
}

async function backupAndRemove(target: string, backup: string): Promise<void> {
  await fs.mkdir(path.dirname(backup), { recursive: true });
  await fs.cp(target, backup, { recursive: true });
  await fs.rm(target, { recursive: true, force: true });
}

function normalizeRelative(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`非法相对路径：${value}`);
  }
  return normalized;
}

function resolveInside(root: string, relative: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`路径超出允许范围：${relative}`);
  }
  return resolved;
}

/** 递归收集目录下的文件，并跳过旧版本原子写残留的临时文件，避免它们被同步到仓库。 */
async function collectFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.isFile() && !entry.name.includes(TEMPORARY_MARKER))
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
}

async function pruneBackups(backupsRoot: string): Promise<void> {
  const entries = await fs.readdir(backupsRoot).catch(() => [] as string[]);
  if (entries.length <= BACKUP_RETENTION) return;
  const dated: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of entries) {
    const stat = await fs.stat(path.join(backupsRoot, name)).catch(() => undefined);
    if (stat) dated.push({ name, mtimeMs: stat.mtimeMs });
  }
  dated.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const entry of dated.slice(BACKUP_RETENTION)) {
    await fs.rm(path.join(backupsRoot, entry.name), { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 去掉本插件自身的设置项，保留原文的注释与格式。 */
function stripPluginSettings(text: string): string {
  return editPluginSettings(text, pluginSettingKeys(text).map((key) => [key, undefined]));
}

/** 写回本机时保留本机原有的插件设置，避免被不含这些键的仓库版本清空。 */
function restorePluginSettings(text: string, current: string): string {
  const parsed = parse(current, [], { allowTrailingComma: true }) as unknown;
  if (!isRecord(parsed)) return text;
  const entries = Object.entries(parsed).filter(([key]) => key.startsWith(PLUGIN_SETTING_PREFIX));
  return editPluginSettings(text, entries);
}

function editPluginSettings(text: string, entries: Array<[string, unknown]>): string {
  let result = text;
  for (const [key, value] of entries) {
    result = applyEdits(result, modify(result, [key], value, {}));
  }
  return result;
}

function pluginSettingKeys(text: string): string[] {
  const parsed = parse(text, [], { allowTrailingComma: true }) as unknown;
  if (!isRecord(parsed)) return [];
  return Object.keys(parsed).filter((key) => key.startsWith(PLUGIN_SETTING_PREFIX));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isSafeSegment(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\');
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

export const testing = { normalizeRelative, resolveInside, setsEqual, sha256, stripPluginSettings, restorePluginSettings, pruneBackups };
