import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workspaceFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const debugDir = path.join(workspaceFolder, '.debug');
const prepareOnly = process.argv.includes('--prepare');
// 扩展宿主的 inspector 端口，与 launch.json 里「附加到扩展宿主」保持一致；同时调两个宿主时用 --inspect-port 错开。
const DEFAULT_INSPECT_PORT = 9229;

const HOSTS = {
  vscode: {
    displayName: 'VS Code',
    envKey: 'VSCODE_EXECUTABLE',
    userDataDir: path.join(debugDir, 'vscode', 'user-data'),
    executableNames: process.platform === 'win32' ? ['code.exe'] : ['code', 'electron'],
    cliNames: process.platform === 'win32' ? ['code.cmd', 'code.exe', 'code'] : ['code'],
    commonPaths: [
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
      path.join(process.env.ProgramFiles || '', 'Microsoft VS Code', 'Code.exe'),
      path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft VS Code', 'Code.exe'),
      '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
      '/usr/share/code/code',
      '/usr/bin/code',
    ],
  },
  cursor: {
    displayName: 'Cursor',
    envKey: 'CURSOR_EXECUTABLE',
    // Cursor 复用本机正式 User Data（见下方启动参数），没有隔离目录可建。
    executableNames: process.platform === 'win32' ? ['cursor.exe'] : ['cursor'],
    cliNames: process.platform === 'win32' ? ['cursor.cmd', 'cursor.exe', 'cursor'] : ['cursor'],
    commonPaths: [
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'cursor', 'Cursor.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Cursor', 'Cursor.exe'),
      '/Applications/Cursor.app/Contents/MacOS/Cursor',
      '/usr/bin/cursor',
      '/usr/share/cursor/cursor',
    ],
  },
};

/** 调试脚本的失败只需要把原因说清楚，Node 堆栈对使用者没有意义。 */
function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function exists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

function parseArg(name) {
  const prefix = `${name}=`;
  const paired = process.argv.find((value) => value.startsWith(prefix));
  if (paired) return paired.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function normalizeHost(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (key === 'vscode' || key === 'vs code' || key === 'code') return 'vscode';
  if (key === 'cursor') return 'cursor';
  return undefined;
}

function isHostExecutable(file, host) {
  return host.executableNames.includes(path.basename(file).toLowerCase());
}

function findExecutableNear(startPath, host) {
  if (exists(startPath) && isHostExecutable(startPath, host)) return startPath;
  let dir = path.dirname(path.resolve(startPath));
  for (let depth = 0; depth < 6; depth++) {
    for (const name of host.executableNames) {
      const candidate = path.join(dir, name);
      if (exists(candidate) && isHostExecutable(candidate, host)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function fromEnv(host) {
  const value = process.env[host.envKey];
  if (!value || !exists(value)) return undefined;
  return findExecutableNear(value, host);
}

function fromCommonPaths(host) {
  for (const candidate of host.commonPaths) {
    if (!candidate || !exists(candidate)) continue;
    if (isHostExecutable(candidate, host)) return candidate;
  }
  return undefined;
}

function fromPathEnv(host) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of host.cliNames) {
      const candidate = path.join(dir, name);
      if (!exists(candidate)) continue;
      const resolved = findExecutableNear(candidate, host);
      if (resolved) return resolved;
    }
  }
  return undefined;
}

function resolveHostExecutable(host) {
  return fromEnv(host) || fromCommonPaths(host) || fromPathEnv(host);
}

function cleanSpawnEnv() {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_INSPECT_RESUME_ON_START;
  delete env.VSCODE_INSPECT_FILES;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  return env;
}

for (const candidate of Object.values(HOSTS)) {
  if (candidate.userDataDir) await fsp.mkdir(candidate.userDataDir, { recursive: true });
}

const hostId = normalizeHost(parseArg('--host'));
const host = hostId ? HOSTS[hostId] : undefined;
if (prepareOnly && !host) process.exit(0);
if (!host) fail('请指定调试宿主：--host=vscode 或 --host=cursor。');

const executable = resolveHostExecutable(host);
if (!executable) {
  fail(`未找到 ${host.displayName} 可执行文件。请安装 ${host.displayName}，或设置环境变量 ${host.envKey} 指向其可执行文件。`);
}

if (prepareOnly) {
  process.stdout.write(`已定位 ${host.displayName}：${executable}\n`);
  process.exit(0);
}

const requestedPort = Number.parseInt(parseArg('--inspect-port') ?? '', 10);
const inspectPort = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : DEFAULT_INSPECT_PORT;
// 默认不用 --inspect-brk-extensions：附加失败时宿主会一直卡在启动前，代价比漏掉 activate 里的断点大。
// 需要调试激活顺序时加 --brk，再由「附加到扩展宿主」接上。
const inspectFlag = process.argv.includes('--brk') ? '--inspect-brk-extensions' : '--inspect-extensions';

// 宿主是 spawn 出来的独立进程，调试器只能靠这个端口附加；不给端口就只能运行、不能打断点。
const args = [`--extensionDevelopmentPath=${workspaceFolder}`, `${inspectFlag}=${inspectPort}`];
if (hostId === 'cursor') {
  // Cursor 登录态在正式 User Data 里；再用隔离目录会被当成新安装，弹出登录页。
  // 临时 Profile 避免在正式数据里留下「插件调试」。
  args.push('--profile-temp');
} else {
  args.push(`--user-data-dir=${host.userDataDir}`, '--profile=插件调试');
}

const child = spawn(executable, args, {
  env: cleanSpawnEnv(),
  stdio: 'inherit',
  windowsHide: false,
});

const stop = () => {
  if (child.exitCode === null && !child.killed) child.kill();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const exitCode = await new Promise((resolve) => {
  child.on('error', (error) => {
    process.stderr.write(`启动 ${host.displayName} 失败：${error instanceof Error ? error.message : String(error)}\n`);
    resolve(1);
  });
  child.on('exit', (code) => resolve(code ?? 1));
});
process.exit(exitCode);
