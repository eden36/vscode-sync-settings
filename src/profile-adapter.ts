import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { applyEdits, modify, parse } from 'jsonc-parser';
import { formatExtensionManifest, HOST_EXTENSIONS_FILE, parseExtensionIds, sortExtensionIds } from './extension-manifest';
import type { HostEnvironment } from './host';
import { namedProfiles, readManifest } from './snapshot-conflict';
import { ProfileDescriptor, SNAPSHOT_SCHEMA_VERSION, SnapshotManifest } from './types';

// Profile 目录下的 extensions.json 是 IDE 维护的启用状态，跨机器同步会引用本机没有的扩展；
// 扩展改由快照根目录的宿主级清单统一处理。
const FILE_RESOURCES = ['settings.json', 'keybindings.json', 'tasks.json', 'mcp.json'];
const DIRECTORY_RESOURCES = ['snippets', 'prompts'];
const SETTINGS_FILE = 'settings.json';
const KEYBINDINGS_FILE = 'keybindings.json';
/** 宿主级文件在仓库宿主目录下的子目录名。 */
const HOST_FILE_DIRECTORY = 'global';
const TEMPORARY_MARKER = '.profile-git-sync-';
const PLUGIN_SETTING_PREFIX = 'profileGitSync.';
const IGNORED_SETTINGS_KEY = 'settingsSync.ignoredSettings';
const BACKUP_RETENTION = 10;
const STABLE_READ_RETRY_MS = 80;

interface StoredProfile {
  location?: string;
  name?: string;
  [key: string]: unknown;
}

interface StorageFile {
  userDataProfiles?: StoredProfile[];
}

export interface RestoreResult {
  changedFiles: string[];
  /** 云端有、本机没有的命名 Profile；插件不新建 Profile，这些 Profile 的配置没有写回。 */
  missingProfiles: string[];
  /** 本机有、云端没有的命名 Profile；插件不删除 Profile，原样保留。 */
  localOnlyProfiles: string[];
}

export interface RestoreOptions {
  /** 只写回这些名称的命名 Profile，用于让用户新建的 Profile 先套用云端内容；不写默认 Profile 与宿主级文件。 */
  profileNames?: ReadonlySet<string>;
}

export class ProfileAdapter {
  private readonly fingerprintCache = new Map<string, { mtimeMs: number; size: number; hash: string }>();
  private installedExtensionsCache: { mtimeMs: number; size: number; ids: string[] } | undefined;

  public constructor(private readonly environment: HostEnvironment) {}

  /**
   * 命名 Profile 的 id 由名称派生，不用磁盘目录名：目录名是各机器随机生成的，
   * 同名 Profile 在两台机器上目录不同，按目录名比较会被当成一删一增。
   */
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
        id: profileSnapshotId(profile.name),
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
    for (const hostFile of this.hostFiles) {
      const fileHash = await this.portableHash(hostFile.path, hostFile.name);
      if (fileHash) hash.update(`${HOST_FILE_DIRECTORY}/${hostFile.name}`).update(fileHash);
    }
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
          const fileHash = await this.portableHash(file, resource);
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
    const staging = `${hostRoot}.staging-${process.pid}-${Date.now()}`;
    await fs.rm(staging, { recursive: true, force: true });
    await fs.mkdir(staging, { recursive: true });

    const files: Record<string, string> = {};
    for (const profile of profiles) {
      const targetRoot = path.join(staging, 'profiles', profile.id);
      for (const resource of FILE_RESOURCES) {
        // 快捷键按平台分文件：Windows 与 macOS 的修饰键不同，共用一份会互相覆盖。
        const repositoryName = resource === KEYBINDINGS_FILE ? this.keybindingsName : resource;
        await this.snapshotFile(path.join(profile.location, resource), resource, staging, `profiles/${profile.id}/${repositoryName}`, files);
      }
      for (const resource of DIRECTORY_RESOURCES) {
        await this.snapshotDirectory(profile.location, resource, targetRoot, files, profile.id);
      }
    }
    for (const hostFile of this.hostFiles) {
      await this.snapshotFile(hostFile.path, hostFile.name, staging, `${HOST_FILE_DIRECTORY}/${hostFile.name}`, files);
    }

    const installedExtensions = await this.readInstalledExtensions();
    if (installedExtensions) {
      await fs.writeFile(path.join(staging, HOST_EXTENSIONS_FILE), installedExtensions);
      files[HOST_EXTENSIONS_FILE] = sha256(installedExtensions);
    }

    const manifest: SnapshotManifest = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      host: this.environment.kind,
      createdAt: '',
      profiles: profiles.map(({ id, name, isDefault }) => ({ id, name, isDefault })),
      files
    };
    await fs.writeFile(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await replaceDirectory(staging, hostRoot);
    return manifest;
  }

  /**
   * 把快照写回本机。Profile 按名称对应，插件不新建也不删除 Profile：
   * IDE 运行期间 storage.json 由主进程持有，外部改写会在它下次落盘时被覆盖，而 Profile 目录已经增删，两边就会错位。
   */
  public async restoreSnapshot(hostRoot: string, options: RestoreOptions = {}): Promise<RestoreResult> {
    const manifest = await readManifest(hostRoot);
    if (manifest.host !== this.environment.kind) throw new Error('远程快照的宿主类型与本机不一致。');

    const localProfiles = await this.listProfiles();
    const localByName = new Map(localProfiles.filter((profile) => !profile.isDefault).map((profile) => [profile.name, profile]));
    const defaultProfile = localProfiles[0];
    const targets = new Map<string, ProfileDescriptor>();
    const missingProfiles: string[] = [];
    for (const remote of manifest.profiles) {
      if (!isSafeSegment(remote.id)) throw new Error(`快照包含非法的 Profile 标识：${remote.id}`);
      const local = remote.isDefault ? defaultProfile : localByName.get(remote.name);
      if (!local) {
        if (!remote.isDefault) missingProfiles.push(remote.name);
        continue;
      }
      if (options.profileNames && (remote.isDefault || !options.profileNames.has(remote.name))) continue;
      targets.set(remote.id, local);
    }
    const remoteNames = new Set(namedProfiles(manifest));
    const localOnlyProfiles = [...localByName.keys()].filter((name) => !remoteNames.has(name));

    const changedFiles: string[] = [];
    const backupsRoot = path.join(this.environment.runtimePath, 'backups');
    const backupRoot = path.join(backupsRoot, new Date().toISOString().replaceAll(':', '-'));
    for (const [remoteId, profile] of targets) {
      for (const resource of FILE_RESOURCES) {
        const target = path.join(profile.location, resource);
        const relative = this.cloudFileFor(manifest, remoteId, resource);
        if (relative) {
          await this.writeFromSnapshot(hostRoot, relative, target, resource === SETTINGS_FILE, changedFiles);
        } else if (resource !== KEYBINDINGS_FILE && await pathExists(target)) {
          // 云端没有本平台的快捷键时保留本机：可能只是还没有同平台的机器上传过，不能当成删除。
          if (resource === SETTINGS_FILE) {
            const current = await stableRead(target);
            const text = current.toString('utf8');
            const parsed = parse(text, [], { allowTrailingComma: true }) as unknown;
            const retained = new Set([...localSettingKeys(parsed), IGNORED_SETTINGS_KEY]);
            if (isRecord(parsed) && Object.keys(parsed).some((key) => retained.has(key))) {
              // 云端删除只作用于便携设置；忽略声明也要留下，否则下一轮会把本机专属值上传。
              const entries: Array<[string, unknown]> = Object.keys(parsed)
                .filter((key) => !retained.has(key)).map((key) => [key, undefined]);
              const content = this.prepareForLocal(false, Buffer.from(editSettings(text, entries), 'utf8'), current);
              if (current.equals(content)) continue;
              const backup = path.join(backupRoot, remoteId, resource);
              await fs.mkdir(path.dirname(backup), { recursive: true });
              await fs.cp(target, backup, { dereference: true });
              await atomicWrite(target, content, this.stagingPath);
              changedFiles.push(target);
              continue;
            }
          }
          await backupAndRemove(target, path.join(backupRoot, remoteId, resource));
          changedFiles.push(target);
        }
      }
      for (const resource of DIRECTORY_RESOURCES) {
        const root = path.join(profile.location, resource);
        const prefix = `profiles/${remoteId}/${resource}/`;
        for (const target of await collectFiles(root)) {
          const nested = path.relative(root, target).split(path.sep).join('/');
          if (!manifest.files[`${prefix}${nested}`]) {
            await backupAndRemove(target, path.join(backupRoot, remoteId, resource, ...nested.split('/')));
            changedFiles.push(target);
          }
        }
        for (const relative of Object.keys(manifest.files)) {
          if (!relative.startsWith(prefix)) continue;
          const normalized = normalizeRelative(relative);
          // 扩展清单由 IDE 自己维护，绝不能写回本机。
          if (path.posix.basename(normalized) === HOST_EXTENSIONS_FILE) continue;
          const target = resolveInside(root, normalized.slice(prefix.length));
          await this.writeFromSnapshot(hostRoot, normalized, target, false, changedFiles);
        }
      }
    }
    if (!options.profileNames) {
      for (const hostFile of this.hostFiles) {
        const relative = `${HOST_FILE_DIRECTORY}/${hostFile.name}`;
        // 云端没有时保留本机：旧版本的快照不含宿主级文件，不能据此删除本机配置。
        if (!manifest.files[relative]) continue;
        await this.writeFromSnapshot(hostRoot, relative, hostFile.path, false, changedFiles);
      }
    }
    await pruneBackups(backupsRoot);
    return { changedFiles, missingProfiles, localOnlyProfiles };
  }

  /** 本机某个 Profile 文件在快照中对应的条目；快捷键优先取本平台的，没有时兼容旧快照的单份文件。 */
  private cloudFileFor(manifest: SnapshotManifest, remoteId: string, resource: string): string | undefined {
    const candidates = resource === KEYBINDINGS_FILE
      ? [`profiles/${remoteId}/${this.keybindingsName}`, `profiles/${remoteId}/${KEYBINDINGS_FILE}`]
      : [`profiles/${remoteId}/${resource}`];
    return candidates.find((relative) => manifest.files[relative] !== undefined);
  }

  private async writeFromSnapshot(
    hostRoot: string,
    relative: string,
    target: string,
    settings: boolean,
    changedFiles: string[],
  ): Promise<void> {
    const source = resolveInside(hostRoot, normalizeRelative(relative));
    const sourceContent = await stableRead(source);
    const currentContent = await fs.readFile(target).catch(() => undefined);
    const localContent = this.prepareForLocal(settings, sourceContent, currentContent);
    if (currentContent?.equals(localContent)) return;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await atomicWrite(target, localContent, this.stagingPath);
    changedFiles.push(target);
  }

  private async snapshotFile(
    source: string,
    resource: string,
    stagingRoot: string,
    relative: string,
    files: Record<string, string>,
  ): Promise<void> {
    const content = await stableRead(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!content) return;
    const portableContent = this.prepareForRepository(resource, content);
    const target = path.join(stagingRoot, ...relative.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, portableContent);
    files[relative] = sha256(portableContent);
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
      const content = this.prepareForRepository(resource, await stableRead(absolute));
      const target = path.join(targetRoot, resource, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
      files[`profiles/${profileId}/${resource}/${relative.split(path.sep).join('/')}`] = sha256(content);
    }
  }

  /**
   * 本机用户安装的扩展标识，来自扩展目录的清单文件。
   * 内置扩展不在该文件中，因此这份列表可以安全地用于判断哪些扩展需要卸载。
   * 指纹检测每隔几秒就要读一次，文件没变时直接复用上次的解析结果。
   */
  public async listInstalledExtensionIds(): Promise<string[]> {
    const manifestPath = this.environment.extensionsManifestPath;
    if (!manifestPath) return [];
    const stat = await fs.stat(manifestPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!stat) return [];
    const cached = this.installedExtensionsCache;
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return [...cached.ids];
    const content = await stableRead(manifestPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!content) return [];
    const ids = sortExtensionIds(parseExtensionIds(content.toString('utf8')));
    this.installedExtensionsCache = { mtimeMs: stat.mtimeMs, size: stat.size, ids };
    return [...ids];
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

  private get keybindingsName(): string {
    return `keybindings.${this.environment.platform ?? process.platform}.json`;
  }

  private get hostFiles(): NonNullable<HostEnvironment['hostFiles']> {
    return this.environment.hostFiles ?? [];
  }

  private prepareForRepository(resource: string, content: Buffer): Buffer {
    const normalized = normalizeLineEndings(content);
    // 插件自身设置与用户声明忽略的设置只属于本机，随 settings.json 同步会被另一台机器覆盖。
    if (resource === SETTINGS_FILE) return Buffer.from(stripLocalSettings(normalized.toString('utf8')), 'utf8');
    return normalized;
  }

  private prepareForLocal(settings: boolean, content: Buffer, current: Buffer | undefined): Buffer {
    const restored = settings
      ? Buffer.from(restoreLocalSettings(content.toString('utf8'), current?.toString('utf8') ?? ''), 'utf8')
      : content;
    // 仓库统一存 LF；本机原来是 CRLF 时按 CRLF 写回，否则同步一次就会把用户文件的换行符整份改掉。
    if (!current || !usesCrlf(current) || restored.includes(0)) return restored;
    return Buffer.from(restored.toString('utf8').replace(/\r?\n/g, '\r\n'), 'utf8');
  }
}

/** 命名 Profile 在仓库中的目录名。名称可能含有文件系统不允许的字符，因此取哈希。 */
function profileSnapshotId(name: string): string {
  return `named-${sha256(Buffer.from(name, 'utf8')).slice(0, 16)}`;
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

/**
 * 临时文件必须写在运行目录，否则崩溃残留会被快照当成用户配置提交到仓库。
 * 目标是软链接（用 dotfiles 仓库管理配置）时写到链接指向的文件：替换掉链接本身会让用户的 dotfiles 脱钩。
 * 链接目标可能在另一个磁盘，跨盘不能重命名，因此临时文件放在目标旁边，名称带标记以便快照跳过。
 */
async function atomicWrite(target: string, content: Buffer, stagingRoot: string): Promise<void> {
  const token = `${process.pid}-${randomUUID()}`;
  const link = await fs.lstat(target).catch(() => undefined);
  if (link?.isSymbolicLink()) {
    const real = await fs.realpath(target);
    const temporary = `${real}${TEMPORARY_MARKER}${token}`;
    await fs.writeFile(temporary, content);
    try {
      await fs.rename(temporary, real);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
    return;
  }

  await fs.mkdir(stagingRoot, { recursive: true });
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
  await fs.cp(target, backup, { recursive: true, dereference: true });
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

/**
 * 递归收集目录下的文件，并跳过原子写残留的临时文件，避免它们被同步到仓库。
 * 指向文件的软链接一并收集（dotfiles 管理的片段），指向目录的不跟随。
 */
async function collectFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.includes(TEMPORARY_MARKER)) continue;
    const absolute = path.join(entry.parentPath ?? entry.path, entry.name);
    if (entry.isFile()) files.push(absolute);
    else if (entry.isSymbolicLink() && (await fs.stat(absolute).catch(() => undefined))?.isFile()) files.push(absolute);
  }
  return files;
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

/** 去掉只属于本机的设置项，保留原文的注释与格式。 */
function stripLocalSettings(text: string): string {
  const parsed = parse(text, [], { allowTrailingComma: true }) as unknown;
  if (!isRecord(parsed)) return text;
  return editSettings(text, localSettingKeys(parsed).filter((key) => key in parsed).map((key) => [key, undefined]));
}

/**
 * 写回本机时，只属于本机的设置项一律保持本机原值：本机有就恢复，本机没有就去掉仓库里带来的值。
 * 忽略清单取两侧的并集，任一侧声明忽略的键都不应被另一侧覆盖。
 */
function restoreLocalSettings(text: string, current: string): string {
  const currentParsed = parse(current, [], { allowTrailingComma: true }) as unknown;
  const incomingParsed = parse(text, [], { allowTrailingComma: true }) as unknown;
  const keys = new Set([...localSettingKeys(currentParsed), ...ignoredSettingKeys(incomingParsed)]);
  const entries: Array<[string, unknown]> = [];
  for (const key of keys) {
    const value = isRecord(currentParsed) ? currentParsed[key] : undefined;
    if (value !== undefined || (isRecord(incomingParsed) && key in incomingParsed)) entries.push([key, value]);
  }
  return editSettings(text, entries);
}

/** 只属于本机的设置项：本插件自身的设置，以及 settingsSync.ignoredSettings 列出的键（沿用 IDE 内置同步的约定）。 */
function localSettingKeys(parsed: unknown): string[] {
  if (!isRecord(parsed)) return [];
  const own = Object.keys(parsed).filter((key) => key.startsWith(PLUGIN_SETTING_PREFIX));
  return [...new Set([...own, ...ignoredSettingKeys(parsed)])];
}

function ignoredSettingKeys(parsed: unknown): string[] {
  if (!isRecord(parsed)) return [];
  const ignored = parsed[IGNORED_SETTINGS_KEY];
  if (!Array.isArray(ignored)) return [];
  // 以 - 开头的写法表示取消 IDE 默认忽略的项，不是要忽略的键。
  return ignored.filter((key): key is string => typeof key === 'string' && key.length > 0 && !key.startsWith('-'));
}

function editSettings(text: string, entries: Array<[string, unknown]>): string {
  let result = text;
  for (const [key, value] of entries) {
    result = applyEdits(result, modify(result, [key], value, {}));
  }
  return result;
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

/**
 * 仓库形态统一按 LF 存放：两台机器的 Git 换行符配置不同时，
 * 同一份配置会被写成 CRLF 与 LF 两种字节，不归一就会算出两个哈希，判成双方都有改动。
 * 含 NUL 字节的按二进制处理、原样返回：按 UTF-8 解码再编码是有损的，会把非文本文件改坏后推上云端。
 * 不含 CRLF 的内容同样原样返回。
 */
function normalizeLineEndings(content: Buffer): Buffer {
  if (content.includes(0)) return content;
  const text = content.toString('utf8');
  if (!text.includes('\r\n')) return content;
  return Buffer.from(text.replaceAll('\r\n', '\n'), 'utf8');
}

function usesCrlf(content: Buffer): boolean {
  return !content.includes(0) && content.toString('utf8').includes('\r\n');
}

export const testing = {
  normalizeRelative,
  normalizeLineEndings,
  resolveInside,
  sha256,
  profileSnapshotId,
  stripLocalSettings,
  restoreLocalSettings,
  pruneBackups,
};
