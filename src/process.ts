import { spawn } from 'node:child_process';

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface BinaryProcessResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

export async function runProcess(command: string, args: string[], cwd?: string, timeoutMs = 60_000): Promise<ProcessResult> {
  const result = await runProcessBinary(command, args, cwd, timeoutMs);
  return { stdout: result.stdout.toString('utf8').trim(), stderr: result.stderr, exitCode: result.exitCode };
}

/** 标准输出原样按字节返回，不解码也不裁剪首尾空白。 */
export function runProcessBinary(command: string, args: string[], cwd?: string, timeoutMs = 60_000): Promise<BinaryProcessResult> {
  return new Promise((resolve, reject) => {
    const windows = process.platform === 'win32';
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      // 非 Windows 上让子进程自成进程组，超时时才能连同它拉起的 ssh 一起结束。
      detached: !windows,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'auto' }
    });
    const stdout: Buffer[] = [];
    let stderr = '';
    const timer = setTimeout(() => {
      // kill 只结束进程本体，Git 拉起的 git-remote-https、ssh 会留下来继续占着仓库锁，必须连进程树一起结束。
      if (windows && child.pid !== undefined) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' })
          .on('error', () => child.kill());
      } else if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill();
        }
      } else {
        child.kill();
      }
      reject(new Error(`命令执行超时：${command}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(stdout), stderr: stderr.trim(), exitCode: code ?? -1 });
    });
  });
}
