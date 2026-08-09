import { randomUUID } from 'node:crypto';
import { DEFAULT_CONFIGURATION, PluginConfiguration } from './types';

const CONFIGURATION_SCHEMA_VERSION = 1;

export type StoredConfiguration = Partial<Omit<PluginConfiguration, 'repositoryUrl'>> & {
  repositoryUrl?: string;
};

export interface VersionedConfigurationRecord {
  schemaVersion: 1;
  revision: string;
  deviceId: string;
  logicalTime: number;
  configuration: PluginConfiguration;
}

export function hasEmbeddedCredentials(repositoryUrl: string): boolean {
  return /^https?:\/\/[^/@\s]+:[^/@\s]+@/i.test(repositoryUrl);
}

export function isValidBranch(branch: string): boolean {
  return branch.length > 0
    && branch.length <= 255
    && /^[A-Za-z0-9._/-]+$/.test(branch)
    && !branch.startsWith('-')
    && !branch.startsWith('.')
    && !branch.endsWith('/')
    && !branch.endsWith('.')
    && !branch.endsWith('.lock')
    && !branch.includes('..')
    && !branch.includes('//');
}

export function resolveRepositoryUrl(fromSecret: string | undefined, stored: StoredConfiguration): {
  repositoryUrl: string;
  persisted: Omit<PluginConfiguration, 'repositoryUrl' | 'autoSync' | 'pollIntervalSeconds' | 'debounceSeconds' | 'includeProfileAssociations'>;
  shouldPersistSecret: boolean;
} {
  const persisted = {
    branch: stored.branch ?? DEFAULT_CONFIGURATION.branch,
    gitUserName: stored.gitUserName ?? DEFAULT_CONFIGURATION.gitUserName,
    gitUserEmail: stored.gitUserEmail ?? DEFAULT_CONFIGURATION.gitUserEmail,
  };
  if (fromSecret !== undefined) return { repositoryUrl: fromSecret, persisted, shouldPersistSecret: false };
  if (stored.repositoryUrl) return { repositoryUrl: stored.repositoryUrl, persisted, shouldPersistSecret: true };
  return { repositoryUrl: DEFAULT_CONFIGURATION.repositoryUrl, persisted, shouldPersistSecret: false };
}

export function compareConfigurationRecords(left: VersionedConfigurationRecord, right: VersionedConfigurationRecord): number {
  if (left.logicalTime !== right.logicalTime) return left.logicalTime < right.logicalTime ? -1 : 1;
  const device = left.deviceId.localeCompare(right.deviceId);
  return device || left.revision.localeCompare(right.revision);
}

export function parseConfigurationRecord(value: unknown): VersionedConfigurationRecord | undefined {
  if (!isRecord(value) || value.schemaVersion !== CONFIGURATION_SCHEMA_VERSION) return undefined;
  if (!validIdentifier(value.revision) || !validIdentifier(value.deviceId)) return undefined;
  if (typeof value.logicalTime !== 'number' || !Number.isSafeInteger(value.logicalTime) || value.logicalTime < 0) return undefined;
  const configuration = parsePluginConfiguration(value.configuration);
  if (!configuration) return undefined;
  return {
    schemaVersion: CONFIGURATION_SCHEMA_VERSION,
    revision: value.revision,
    deviceId: value.deviceId,
    logicalTime: value.logicalTime,
    configuration,
  };
}

export function createConfigurationRecord(
  configuration: PluginConfiguration,
  deviceId: string,
  previousLogicalTime = 0,
  now = Date.now(),
  revision: string = randomUUID(),
): VersionedConfigurationRecord {
  const parsed = parsePluginConfiguration(configuration);
  if (!parsed) throw new Error('同步配置参数错误。');
  return {
    schemaVersion: CONFIGURATION_SCHEMA_VERSION,
    revision,
    deviceId,
    logicalTime: Math.max(now, previousLogicalTime + 1),
    configuration: parsed,
  };
}

export function parsePluginConfiguration(value: unknown): PluginConfiguration | undefined {
  if (!isRecord(value)) return undefined;
  const stringKeys = ['repositoryUrl', 'branch', 'gitUserName', 'gitUserEmail'] as const;
  if (!stringKeys.every((key) => typeof value[key] === 'string')) return undefined;
  const repositoryUrl = value.repositoryUrl as string;
  const branch = value.branch as string;
  const gitUserName = value.gitUserName as string;
  const gitUserEmail = value.gitUserEmail as string;
  if (repositoryUrl.length > 4_096 || /\r|\n/.test(repositoryUrl) || hasEmbeddedCredentials(repositoryUrl)) return undefined;
  if (!isValidBranch(branch)) return undefined;
  if ([gitUserName, gitUserEmail].some((text) => text.length > 320 || /\r|\n/.test(text))) return undefined;
  if (typeof value.autoSync !== 'boolean' || typeof value.includeProfileAssociations !== 'boolean') return undefined;
  if (!validInterval(value.debounceSeconds, 5) || !validInterval(value.pollIntervalSeconds, 30)) return undefined;
  return {
    repositoryUrl,
    branch,
    gitUserName,
    gitUserEmail,
    autoSync: value.autoSync,
    debounceSeconds: value.debounceSeconds,
    pollIntervalSeconds: value.pollIntervalSeconds,
    includeProfileAssociations: value.includeProfileAssociations,
  };
}

export function sameConfiguration(left: PluginConfiguration, right: PluginConfiguration): boolean {
  return Object.keys(DEFAULT_CONFIGURATION).every((key) => (
    left[key as keyof PluginConfiguration] === right[key as keyof PluginConfiguration]
  ));
}

function validInterval(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= 86_400;
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
