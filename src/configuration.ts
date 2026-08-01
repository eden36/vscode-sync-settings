import * as vscode from 'vscode';
import { DEFAULT_CONFIGURATION, SyncConfiguration } from './types';

const CONFIG_KEY = 'profileGitSync.configuration';

export class ConfigurationStore {
  public constructor(private readonly context: vscode.ExtensionContext) {}

  public get(): SyncConfiguration {
    const stored = this.context.globalState.get<Partial<SyncConfiguration>>(CONFIG_KEY, {});
    return {
      repositoryUrl: stored.repositoryUrl ?? DEFAULT_CONFIGURATION.repositoryUrl,
      branch: stored.branch ?? DEFAULT_CONFIGURATION.branch,
      gitUserName: stored.gitUserName ?? DEFAULT_CONFIGURATION.gitUserName,
      gitUserEmail: stored.gitUserEmail ?? DEFAULT_CONFIGURATION.gitUserEmail
    };
  }

  public async save(value: SyncConfiguration): Promise<void> {
    await this.context.globalState.update(CONFIG_KEY, value);
  }
}
