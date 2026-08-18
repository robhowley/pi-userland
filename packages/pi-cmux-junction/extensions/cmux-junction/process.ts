import { execFile as nodeExecFile } from 'node:child_process';

interface ProcessOutput {
  stdout: string;
  stderr: string;
}

export type ProcessResult =
  | (ProcessOutput & { outcome: 'exit'; exitCode: number })
  | (ProcessOutput & {
      outcome: 'timeout';
      timeoutMs: number;
      signal: NodeJS.Signals | string;
    })
  | (ProcessOutput & { outcome: 'signal'; signal: NodeJS.Signals | string })
  | (ProcessOutput & { outcome: 'spawn-failed'; message: string; code?: string });

export interface ProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBufferBytes?: number;
  shell?: false;
}

export type ProcessRunner = (
  file: string,
  args: readonly string[],
  options: ProcessOptions,
) => Promise<ProcessResult>;

const DEFAULT_TIMEOUT_MS = 10_000;

export const defaultProcessRunner: ProcessRunner = async (file, args, options) =>
  await new Promise((resolve) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const child = nodeExecFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        ...(options.env === undefined ? {} : { env: options.env }),
        encoding: 'utf8',
        timeout: timeoutMs,
        ...(options.maxBufferBytes === undefined ? {} : { maxBuffer: options.maxBufferBytes }),
        shell: options.shell ?? false,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ outcome: 'exit', exitCode: 0, stdout, stderr });
          return;
        }
        if (error.killed) {
          resolve({
            outcome: 'timeout',
            timeoutMs,
            signal: error.signal ?? 'SIGTERM',
            stdout,
            stderr,
          });
          return;
        }
        if (error.signal !== undefined && error.signal !== null) {
          resolve({ outcome: 'signal', signal: error.signal, stdout, stderr });
          return;
        }
        if (typeof error.code === 'number') {
          resolve({ outcome: 'exit', exitCode: error.code, stdout, stderr });
          return;
        }
        resolve({
          outcome: 'spawn-failed',
          message: error.message,
          ...(typeof error.code === 'string' ? { code: error.code } : {}),
          stdout,
          stderr,
        });
      },
    );
    child.stdin?.end();
  });

export function processSucceeded(result: ProcessResult): boolean {
  return result.outcome === 'exit' && result.exitCode === 0;
}

export function processError(result: ProcessResult): string {
  const output = (result.stderr || result.stdout).trim();
  if (output.length > 0) return output;
  switch (result.outcome) {
    case 'exit':
      return `exit ${result.exitCode}`;
    case 'timeout':
      return 'command timed out';
    case 'signal':
      return `terminated by signal ${result.signal}`;
    case 'spawn-failed':
      return result.message;
  }
}
