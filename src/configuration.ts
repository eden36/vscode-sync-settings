import * as vscode from 'vscode';
import { DEFAULT_CONFIGURATION, SyncConfiguration } from './types';

const CONFIG_KEY = 'profileGitSync.configuration';
const REPOSITORY_URL_SECRET = 'profileGitSync.repositoryUrl';

type StoredConfiguration = Partial<Omit<SyncConfiguration, 'repositoryUrl'>> & {
  repositoryUrl?: string;
};

export function hasEmbeddedCredentials(repositoryUrl: string): boolean {
  return /^https?:\/\/[^/@\s]+:[^/@\s]+@/i.test(repositoryUrl);
}

export function resolveRepositoryUrl(fromSecret: string | undefined, stored: StoredConfiguration): {
  repositoryUrl: string;
  persisted: Omit<SyncConfiguration, 'repositoryUrl'>;
  shouldPersistSecret: boolean;
} {
  if (fromSecret !== undefined) {
    return {
      repositoryUrl: fromSecret,
      persisted: pickPersistedConfiguration(stored),
      shouldPersistSecret: false
    };
  }
  if (stored.repositoryUrl) {
    return {
      repositoryUrl: stored.repositoryUrl,
      persisted: pickPersistedConfiguration(stored),
      shouldPersistSecret: true
    };
  }
  return {
    repositoryUrl: DEFAULT_CONFIGURATION.repositoryUrl,
    persisted: pickPersistedConfiguration(stored),
    shouldPersistSecret: false
  };
}

export class ConfigurationStore {
  private repositoryUrl = DEFAULT_CONFIGURATION.repositoryUrl;

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public async initialize(): Promise<void> {
    const stored = this.context.globalState.get<StoredConfiguration>(CONFIG_KEY, {});
    const resolved = resolveRepositoryUrl(await this.context.secrets.get(REPOSITORY_URL_SECRET), stored);
    this.repositoryUrl = resolved.repositoryUrl;
    if (resolved.shouldPersistSecret) {
      await this.context.secrets.store(REPOSITORY_URL_SECRET, resolved.repositoryUrl);
    }
    if (resolved.shouldPersistSecret || stored.repositoryUrl !== undefined) {
      await this.context.globalState.update(CONFIG_KEY, resolved.persisted);
    }
  }

  public get(): SyncConfiguration {
    const stored = this.context.globalState.get<StoredConfiguration>(CONFIG_KEY, {});
    return {
      repositoryUrl: this.repositoryUrl,
      branch: stored.branch ?? DEFAULT_CONFIGURATION.branch,
      gitUserName: stored.gitUserName ?? DEFAULT_CONFIGURATION.gitUserName,
      gitUserEmail: stored.gitUserEmail ?? DEFAULT_CONFIGURATION.gitUserEmail
    };
  }

  public async save(value: SyncConfiguration): Promise<void> {
    this.repositoryUrl = value.repositoryUrl;
    if (value.repositoryUrl) {
      await this.context.secrets.store(REPOSITORY_URL_SECRET, value.repositoryUrl);
    } else {
      await this.context.secrets.delete(REPOSITORY_URL_SECRET);
    }
    await this.context.globalState.update(CONFIG_KEY, pickPersistedConfiguration(value));
  }
}

function pickPersistedConfiguration(value: StoredConfiguration | SyncConfiguration): Omit<SyncConfiguration, 'repositoryUrl'> {
  return {
    branch: value.branch ?? DEFAULT_CONFIGURATION.branch,
    gitUserName: value.gitUserName ?? DEFAULT_CONFIGURATION.gitUserName,
    gitUserEmail: value.gitUserEmail ?? DEFAULT_CONFIGURATION.gitUserEmail
  };
}
