import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { hostLabel, resolveHostKind, resolveHostStoragePaths } from './host-paths';
import { HostKind } from './types';

/** 不属于任何 Profile、只在宿主层存在的配置文件，在仓库里放在宿主目录的 global/ 下。 */
export interface HostFile {
  name: string;
  path: string;
}

export interface HostEnvironment {
  kind: HostKind;
  /** 已知宿主用固定中文/产品名，其余用应用名原文。 */
  label?: string;
  userDataPath: string;
  runtimePath: string;
  /** 已安装扩展的全局清单，与 Profile 无关，位于扩展安装目录下。 */
  extensionsManifestPath?: string;
  /** 快捷键按平台分文件存放；缺省取当前进程的平台。 */
  platform?: NodeJS.Platform;
  /**
   * 当前窗口是否运行在默认 Profile，缺省视为是。
   * 扩展装卸命令只作用于当前窗口的 Profile，而同步的扩展清单属于默认 Profile，非默认 Profile 窗口不能代为装卸。
   */
  inDefaultProfile?: boolean;
  hostFiles?: HostFile[];
}

/** 认不出宿主或 User Data 布局对不上时返回 undefined，由调用方拒绝启用。 */
export function detectHost(context: vscode.ExtensionContext): HostEnvironment | undefined {
  const kind = resolveHostKind(vscode.env.appName);
  const paths = resolveHostStoragePaths(context.globalStorageUri.fsPath);
  if (!kind || !paths) return undefined;
  const { userDataPath, runtimePath, inDefaultProfile } = paths;
  // 开发宿主的 extensionPath 指向项目源码目录，据此推不出扩展安装目录，此时不采集扩展清单。
  const production = context.extensionMode === vscode.ExtensionMode.Production;
  const extensionsRoot = path.dirname(context.extensionPath);
  return {
    kind,
    label: hostLabel(kind, vscode.env.appName),
    userDataPath,
    runtimePath,
    extensionsManifestPath: production ? path.join(extensionsRoot, 'extensions.json') : undefined,
    platform: process.platform,
    inDefaultProfile,
    // Cursor 的全局 MCP 配置不在 User 目录，而在用户主目录的 .cursor 下。
    hostFiles: kind === 'cursor' ? [{ name: 'mcp.json', path: path.join(os.homedir(), '.cursor', 'mcp.json') }] : [],
  };
}
