import * as path from 'node:path';
import * as vscode from 'vscode';
import { resolveHostStoragePaths } from './host-paths';
import { HostKind } from './types';

export interface HostEnvironment {
  kind: HostKind;
  userDataPath: string;
  runtimePath: string;
  extensionDataUri?: string;
  /** 已安装扩展的全局清单，与 Profile 无关，位于扩展安装目录下。 */
  extensionsManifestPath?: string;
}

export function detectHost(context: vscode.ExtensionContext): HostEnvironment {
  const applicationName = vscode.env.appName.toLowerCase();
  const kind: HostKind = applicationName.includes('cursor') ? 'cursor' : 'vscode';
  const { userDataPath, runtimePath } = resolveHostStoragePaths(context.globalStorageUri.fsPath);
  // 开发宿主的 extensionPath 指向项目源码目录，据此推不出扩展安装目录，此时不采集扩展清单。
  const production = context.extensionMode === vscode.ExtensionMode.Production;
  const extensionsRoot = path.dirname(context.extensionPath);
  return {
    kind,
    userDataPath,
    runtimePath,
    extensionDataUri: production ? toUriPath(path.dirname(extensionsRoot)) : undefined,
    extensionsManifestPath: production ? path.join(extensionsRoot, 'extensions.json') : undefined,
  };
}

function toUriPath(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/');
  return process.platform === 'win32' ? `/${normalized}` : normalized;
}
