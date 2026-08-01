import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { HostEnvironment } from './host';
import { ProfileDescriptor, SnapshotManifest } from './types';

const FILE_RESOURCES = ['settings.json', 'keybindings.json', 'tasks.json', 'extensions.json', 'mcp.json'];
const DIRECTORY_RESOURCES = ['snippets', 'prompts'];

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
  message?: string;
}

export class ProfileAdapter {
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
    const profiles = await this.listProfiles();
    const hash = createHash('sha256');
    for (const profile of profiles) {
      hash.update(`${profile.id}\0${profile.name}\0`);
      for (const resource of FILE_RESOURCES) {
        const content = await stableRead(path.join(profile.location, resource)).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
        if (content) hash.update(resource).update(content);
      }
      for (const resource of DIRECTORY_RESOURCES) {
        const root = path.join(profile.location, resource);
        const entries = await fs.readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
        const files = entries.filter((entry) => entry.isFile()).map((entry) => {
          const parentPath = entry.parentPath ?? entry.path;
          return path.join(parentPath, entry.name);
        }).sort();
        for (const file of files) hash.update(path.relative(root, file)).update(await stableRead(file));
      }
    }
    return hash.digest('hex');
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
      return { changedFiles: [], structuralChange, message: '远程包含 Profile 增删，请关闭其他窗口后安全应用。' };
    }

    if (structuralChange) {
      await this.restoreProfileStructure(manifest);
    }

    const refreshedProfiles = structuralChange ? await this.listProfiles() : localProfiles;
    const localById = new Map(refreshedProfiles.map((profile) => [profile.id, profile]));
    const changedFiles: string[] = [];
    const backupRoot = path.join(this.environment.runtimePath, 'backups', new Date().toISOString().replaceAll(':', '-'));
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
        const entries = await fs.readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const parentPath = entry.parentPath ?? entry.path;
          const target = path.join(parentPath, entry.name);
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
      const localContent = this.prepareForLocal(relative, sourceContent);
      const currentContent = await fs.readFile(target).catch(() => undefined);
      if (currentContent?.equals(localContent)) {
        continue;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await atomicWrite(target, localContent);
      changedFiles.push(target);
    }
    return { changedFiles, structuralChange };
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
    const backupRoot = path.join(this.environment.runtimePath, 'backups', `structure-${Date.now()}`);
    await fs.mkdir(backupRoot, { recursive: true });
    await fs.copyFile(storagePath, path.join(backupRoot, 'storage.json'));
    if (await pathExists(profilesPath)) await fs.cp(profilesPath, path.join(backupRoot, 'profiles'), { recursive: true });

    const storage = await this.readStorage();
    storage.userDataProfiles = metadata as StoredProfile[];
    if (manifest.profileAssociations !== undefined) storage.profileAssociations = manifest.profileAssociations;
    await atomicWrite(storagePath, Buffer.from(`${JSON.stringify(storage, null, 2)}\n`, 'utf8'));
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
    const entries = await fs.readdir(root, { recursive: true, withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const sortedEntries = entries.filter((entry) => entry.isFile()).sort((left, right) => {
      const leftParent = left.parentPath ?? left.path;
      const rightParent = right.parentPath ?? right.path;
      return path.join(leftParent, left.name).localeCompare(path.join(rightParent, right.name));
    });
    for (const entry of sortedEntries) {
      const parentPath = entry.parentPath ?? entry.path;
      const absolute = path.join(parentPath, entry.name);
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

  private prepareForRepository(resource: string, content: Buffer): Buffer {
    if (resource !== 'extensions.json' || !this.environment.extensionDataUri) return content;
    return Buffer.from(content.toString('utf8').replaceAll(this.environment.extensionDataUri, '%%EXTENSION_DATA_PATH%%'), 'utf8');
  }

  private prepareForLocal(relative: string, content: Buffer): Buffer {
    if (!relative.endsWith('/extensions.json') || !this.environment.extensionDataUri) return content;
    return Buffer.from(content.toString('utf8').replaceAll('%%EXTENSION_DATA_PATH%%', this.environment.extensionDataUri), 'utf8');
  }
}

async function stableRead(filePath: string): Promise<Buffer> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await fs.stat(filePath);
    const content = await fs.readFile(filePath);
    const after = await fs.stat(filePath);
    if (before.size === after.size && before.mtimeMs === after.mtimeMs) return content;
  }
  throw new Error(`配置文件持续变化，暂缓同步：${filePath}`);
}

async function atomicWrite(target: string, content: Buffer): Promise<void> {
  const temporary = `${target}.profile-git-sync-${process.pid}`;
  const previous = `${target}.profile-git-sync-previous-${process.pid}`;
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

function isSafeSegment(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\');
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

export const testing = { normalizeRelative, resolveInside, setsEqual, sha256 };
