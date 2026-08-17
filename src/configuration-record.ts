import { randomUUID } from 'node:crypto';
import { DEFAULT_CONFIGURATION, PluginConfiguration } from './types';

const CONFIGURATION_SCHEMA_VERSION = 2;

export type StoredConfiguration = Partial<Omit<PluginConfiguration, 'repositoryUrl'>> & {
  repositoryUrl?: string;
};

export interface VersionedConfigurationRecord {
  schemaVersion: 2;
  revision: string;
  deviceId: string;
  logicalTime: number;
  clock: Record<string, number>;
  configuration: PluginConfiguration;
}

export type ConfigurationRecordRelation = 'same' | 'left-newer' | 'right-newer' | 'concurrent';

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
  persisted: Omit<PluginConfiguration, 'repositoryUrl' | 'mode' | 'pollIntervalSeconds' | 'debounceSeconds' | 'includeProfileAssociations'>;
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
  const relation = relateConfigurationRecords(left, right);
  if (relation === 'left-newer') return 1;
  if (relation === 'right-newer') return -1;
  if (left.logicalTime !== right.logicalTime) return left.logicalTime < right.logicalTime ? -1 : 1;
  const device = left.deviceId.localeCompare(right.deviceId);
  return device || left.revision.localeCompare(right.revision);
}

export function relateConfigurationRecords(left: VersionedConfigurationRecord, right: VersionedConfigurationRecord): ConfigurationRecordRelation {
  if (left.revision === right.revision) return 'same';
  const devices = new Set([...Object.keys(left.clock), ...Object.keys(right.clock)]);
  let leftAhead = false;
  let rightAhead = false;
  for (const device of devices) {
    const leftValue = left.clock[device] ?? 0;
    const rightValue = right.clock[device] ?? 0;
    leftAhead ||= leftValue > rightValue;
    rightAhead ||= rightValue > leftValue;
  }
  if (leftAhead && rightAhead) return 'concurrent';
  if (leftAhead) return 'left-newer';
  if (rightAhead) return 'right-newer';
  return 'concurrent';
}

export function parseConfigurationRecord(value: unknown): VersionedConfigurationRecord | undefined {
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== CONFIGURATION_SCHEMA_VERSION)) return undefined;
  if (!validIdentifier(value.revision) || !validIdentifier(value.deviceId)) return undefined;
  if (typeof value.logicalTime !== 'number' || !Number.isSafeInteger(value.logicalTime) || value.logicalTime < 0) return undefined;
  const configuration = parsePluginConfiguration(value.configuration);
  if (!configuration) return undefined;
  const clock = value.schemaVersion === 1
    ? { [value.deviceId as string]: value.logicalTime }
    : parseClock(value.clock);
  if (!clock) return undefined;
  return {
    schemaVersion: CONFIGURATION_SCHEMA_VERSION,
    revision: value.revision,
    deviceId: value.deviceId,
    logicalTime: value.logicalTime,
    clock,
    configuration,
  };
}

export function createConfigurationRecord(
  configuration: PluginConfiguration,
  deviceId: string,
  previousLogicalTime = 0,
  now = Date.now(),
  revision: string = randomUUID(),
  previousClock: Record<string, number> = {},
): VersionedConfigurationRecord {
  const parsed = parsePluginConfiguration(configuration);
  if (!parsed) throw new Error('同步配置参数错误。');
  const logicalTime = Math.max(now, previousLogicalTime + 1);
  return {
    schemaVersion: CONFIGURATION_SCHEMA_VERSION,
    revision,
    deviceId,
    logicalTime,
    clock: { ...previousClock, [deviceId]: Math.max((previousClock[deviceId] ?? 0) + 1, logicalTime) },
    configuration: parsed,
  };
}

export function mergedClock(left: VersionedConfigurationRecord, right: VersionedConfigurationRecord): Record<string, number> {
  const result: Record<string, number> = {};
  for (const device of new Set([...Object.keys(left.clock), ...Object.keys(right.clock)])) {
    result[device] = Math.max(left.clock[device] ?? 0, right.clock[device] ?? 0);
  }
  return result;
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
  const mode = value.mode;
  if (mode !== undefined && mode !== 'backup' && mode !== 'sync') return undefined;
  if (typeof value.includeProfileAssociations !== 'boolean') return undefined;
  if (!validInterval(value.debounceSeconds, 5) || !validInterval(value.pollIntervalSeconds, 30)) return undefined;
  return {
    repositoryUrl,
    branch,
    gitUserName,
    gitUserEmail,
    // 旧记录没有 mode，回落备份模式：最坏结果是不写回本机，方向安全。
    mode: mode === 'sync' ? 'sync' : 'backup',
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

function parseClock(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > 128) return undefined;
  if (!entries.every(([key, count]) => validIdentifier(key) && Number.isSafeInteger(count) && (count as number) >= 0)) return undefined;
  return Object.fromEntries(entries) as Record<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
