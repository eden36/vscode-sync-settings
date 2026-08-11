import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { HostKind, SnapshotManifest } from './types';

export async function detectSnapshotConflicts(
  baseRoot: string | undefined,
  localRoot: string,
  cloudRoot: string,
  host: HostKind,
): Promise<string[]> {
  const base = baseRoot ? await readManifest(baseRoot) : emptyManifest(host);
  const local = await readManifest(localRoot);
  const cloud = await readManifest(cloudRoot);
  const conflicts: string[] = [];
  for (const relative of new Set([...Object.keys(base.files), ...Object.keys(local.files), ...Object.keys(cloud.files)])) {
    const baseHash = base.files[relative];
    const localHash = local.files[relative];
    const cloudHash = cloud.files[relative];
    if (localHash !== baseHash && cloudHash !== baseHash && localHash !== cloudHash) conflicts.push(relative);
  }
  const baseStructure = snapshotStructure(base);
  const localStructure = snapshotStructure(local);
  const cloudStructure = snapshotStructure(cloud);
  if (!sameValue(localStructure, baseStructure) && !sameValue(cloudStructure, baseStructure) && !sameValue(localStructure, cloudStructure)) {
    conflicts.push('Profile 结构和关联关系');
  }
  return conflicts;
}

function readManifest(root: string): Promise<SnapshotManifest> {
  return fs.readFile(path.join(root, 'manifest.json'), 'utf8').then((content) => JSON.parse(content) as SnapshotManifest);
}

function emptyManifest(host: HostKind): SnapshotManifest {
  return { schemaVersion: 1, host, createdAt: '', profiles: [], files: {} };
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

