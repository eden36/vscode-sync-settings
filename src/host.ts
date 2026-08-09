import * as path from 'node:path';
import * as vscode from 'vscode';
import { resolveHostStoragePaths } from './host-paths';
import { HostKind } from './types';

export interface HostEnvironment {
  kind: HostKind;
  userDataPath: string;
  runtimePath: string;
  extensionDataUri?: string;
}

export function detectHost(context: vscode.ExtensionContext): HostEnvironment {
  const applicationName = vscode.env.appName.toLowerCase();
  const kind: HostKind = applicationName.includes('cursor') ? 'cursor' : 'vscode';
  const { userDataPath, runtimePath } = resolveHostStoragePaths(context.globalStorageUri.fsPath);
  return {
    kind,
    userDataPath,
    runtimePath,
    extensionDataUri: context.extensionMode === vscode.ExtensionMode.Production
      ? toUriPath(path.dirname(path.dirname(context.extensionPath)))
      : undefined
  };
}

function toUriPath(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/');
  return process.platform === 'win32' ? `/${normalized}` : normalized;
}
