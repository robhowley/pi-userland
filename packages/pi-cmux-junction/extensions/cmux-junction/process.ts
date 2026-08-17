import { execFile as nodeExecFile } from 'node:child_process';

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export type ProcessRunner = (
  file: string,
  args: readonly string[],
  options: ProcessOptions,
) => Promise<ProcessResult>;

const DEFAULT_TIMEOUT_MS = 10_000;

export const defaultProcessRunner: ProcessRunner = async (file, args, options) =>
  await new Promise((resolve) => {
    const child = nodeExecFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        ...(options.env === undefined ? {} : { env: options.env }),
        encoding: 'utf8',
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const exitCode = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ stdout, stderr, exitCode });
      },
    );
    child.stdin?.end();
  });
