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

/** 导出仓库文件内容时不能按文本裁剪，否则写回的文件与仓库版本不一致。 */
export function runProcessBinary(command: string, args: string[], cwd?: string, timeoutMs = 60_000): Promise<BinaryProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'auto' }
    });
    const stdout: Buffer[] = [];
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
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
