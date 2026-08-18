import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { applyEdits, modify, parse } from 'jsonc-parser';
import { formatExtensionManifest, HOST_EXTENSIONS_FILE, parseExtensionIds, sortExtensionIds } from './extension-manifest';
import type { HostEnvironment } from './host';
import { readManifest } from './snapshot-conflict';
import { ProfileDescriptor, SnapshotManifest } from './types';

// Profile 目录下的 extensions.json 是 IDE 维护的启用状态，跨机器同步会引用本机没有的扩展；
// 扩展改由快照根目录的宿主级清单统一处理。
const FILE_RESOURCES = ['settings.json', 'keybindings.json', 'tasks.json', 'mcp.json'];
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
    // 安装或卸载扩展也要触发同步，但只认标识变化，扩展升级不算。
    const installedExtensions = await this.readInstalledExtensions();
    if (installedExtensions) hash.update(HOST_EXTENSIONS_FILE).update(sha256(installedExtensions));
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

  public async createSnapshot(hostRoot: string): Promise<SnapshotManifest> {
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

    const installedExtensions = await this.readInstalledExtensions();
    if (installedExtensions) {
      await fs.writeFile(path.join(staging, HOST_EXTENSIONS_FILE), installedExtensions);
      files[HOST_EXTENSIONS_FILE] = sha256(installedExtensions);
    }

    const manifest: SnapshotManifest = {
      schemaVersion: 1,
      host: this.environment.kind,
      createdAt: '',
      profiles: profiles.map(({ id, name, isDefault }) => ({ id, name, isDefault })),
      profileMetadata: storage.userDataProfiles?.map((profile) => ({ ...profile })) ?? [],
      // 工作区与 Profile 的关联关系始终同步，不作为开关暴露。
      ...(storage.profileAssociations !== undefined ? { profileAssociations: storage.profileAssociations } : {}),
      files
    };
    await fs.writeFile(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await replaceDirectory(staging, hostRoot);
    return manifest;
  }

  public async restoreSnapshot(hostRoot: string, allowStructural: boolean, applyMatchingFiles = false): Promise<RestoreResult> {
    const manifest = await readManifest(hostRoot);
    if (manifest.host !== this.environment.kind) throw new Error('远程快照的宿主类型与本机不一致。');

    const localProfiles = await this.listProfiles();
    const localIds = new Set(localProfiles.map((profile) => profile.id));
    const remoteIds = new Set(manifest.profiles.map((profile) => profile.id));
    const structuralChange = !setsEqual(localIds, remoteIds);
    if (structuralChange && !allowStructural && !applyMatchingFiles) {
      return {
        changedFiles: [],
        structuralChange,
        structuralApplied: false,
        message: '远程包含 Profile 增删，只剩一个窗口时会自动应用。',
      };
    }

    const applyStructure = structuralChange && allowStructural;
    if (applyStructure) {
      await this.restoreProfileStructure(manifest);
    }

    const refreshedProfiles = applyStructure ? await this.listProfiles() : localProfiles;
    // 多窗口无法增删 Profile 时只动共有 Profile，避免随后合并把本机旧文件推回云端。
    const targetProfiles = structuralChange && !allowStructural
      ? refreshedProfiles.filter((profile) => remoteIds.has(profile.id))
      : refreshedProfiles;
    const localById = new Map(targetProfiles.map((profile) => [profile.id, profile]));
    const changedFiles: string[] = [];
    const backupsRoot = path.join(this.environment.runtimePath, 'backups');
    const backupRoot = path.join(backupsRoot, new Date().toISOString().replaceAll(':', '-'));
    for (const profile of targetProfiles) {
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
      // 扩展清单由 IDE 自己维护，只用来决定装哪些扩展，绝不能写回本机。
      // 旧版本的云端快照里还带 Profile 级 extensions.json（记录的是本机启用状态），一并跳过。
      if (normalized === HOST_EXTENSIONS_FILE || normalized.endsWith(`/${HOST_EXTENSIONS_FILE}`)) continue;
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
    return {
      changedFiles,
      structuralChange,
      structuralApplied: applyStructure,
      ...(structuralChange && !applyStructure
        ? { message: '已按云端覆盖共有 Profile 的配置；远程包含 Profile 增删，只剩一个窗口时会自动应用。' }
        : {}),
    };
  }

  private async restoreProfileStructure(manifest: SnapshotManifest): Promise<void> {
    const metadata = resolveProfileMetadata(manifest);
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

  /**
   * 本机用户安装的扩展标识，来自扩展目录的清单文件。
   * 内置扩展不在该文件中，因此这份列表可以安全地用于判断哪些扩展需要卸载。
   */
  public async listInstalledExtensionIds(): Promise<string[]> {
    const manifestPath = this.environment.extensionsManifestPath;
    if (!manifestPath) return [];
    const content = await stableRead(manifestPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!content) return [];
    return sortExtensionIds(parseExtensionIds(content.toString('utf8')));
  }

  /**
   * 已安装扩展清单的仓库形态，只保留标识并排序。
   * 原文件还含版本号、安装路径和安装时间等本机专属字段，原样同步会让扩展一升级就产生无意义的冲突。
   */
  private async readInstalledExtensions(): Promise<Buffer | undefined> {
    const ids = await this.listInstalledExtensionIds();
    if (!ids.length) return undefined;
    return Buffer.from(formatExtensionManifest(ids), 'utf8');
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
    return content;
  }

  private prepareForLocal(relative: string, content: Buffer, current: Buffer | undefined): Buffer {
    if (relative.endsWith('/settings.json')) {
      return Buffer.from(restorePluginSettings(content.toString('utf8'), current?.toString('utf8') ?? ''), 'utf8');
    }
    return content;
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

/** 旧快照可能省略元数据；命名 Profile 的 id 就是磁盘目录名，可以按清单补全。 */
function resolveProfileMetadata(manifest: SnapshotManifest): Array<Record<string, unknown>> {
  if (manifest.profileMetadata) return manifest.profileMetadata;
  return manifest.profiles
    .filter((profile) => !profile.isDefault)
    .map((profile) => ({ location: profile.id, name: profile.name }));
}

export const testing = { normalizeRelative, resolveInside, setsEqual, sha256, stripPluginSettings, restorePluginSettings, pruneBackups, resolveProfileMetadata };
