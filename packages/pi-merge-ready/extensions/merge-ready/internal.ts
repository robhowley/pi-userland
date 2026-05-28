import type { MergeReadyExec, MergeReadyExecOptions, MergeReadyExecResult } from './git.js';

export type MergeReadyExecFailureReason = 'non_zero_exit' | 'threw';

export type MergeReadySuccessfulCommand = {
  ok: true;
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type MergeReadyFailedCommand = {
  ok: false;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  reason: MergeReadyExecFailureReason;
  thrownMessage?: string;
};

export type MergeReadyCommandResult = MergeReadySuccessfulCommand | MergeReadyFailedCommand;

const AUTH_FAILURE_RE =
  /gh auth login|authentication required|not logged (?:into|in) any hosts|HTTP 401|requires authentication|token .* invalid|resource not accessible by integration/i;
const API_FAILURE_RE =
  /GraphQL:|API rate limit exceeded|HTTP [45]\d\d|failed to connect|dial tcp|i\/o timeout|timed out|context deadline exceeded|EOF|could not resolve to/i;

export async function runNormalizedExecCommand(
  exec: MergeReadyExec,
  command: string,
  args: string[],
  cwd: string | undefined,
  timeout: number | undefined,
): Promise<MergeReadyCommandResult> {
  try {
    const rawResult = await exec(command, args, createExecOptions(cwd, timeout));
    const result = normalizeExecResult(rawResult);

    if (result.exitCode === 0) {
      return { ok: true, ...result };
    }

    return { ok: false, ...result, reason: 'non_zero_exit' };
  } catch (error) {
    const thrownMessage = getErrorMessage(error);

    return {
      ok: false,
      stdout: getErrorStringProperty(error, 'stdout'),
      stderr: getErrorStringProperty(error, 'stderr') || thrownMessage,
      exitCode: getErrorNumberProperty(error, 'exitCode') ?? getErrorNumberProperty(error, 'code'),
      reason: 'threw',
      thrownMessage,
    };
  }
}

export function classifyGitHubCliFailureReason(
  stderr: string,
  stdout: string,
): 'auth' | 'api' | 'command' {
  const combinedOutput = `${stderr}\n${stdout}`;

  if (AUTH_FAILURE_RE.test(combinedOutput)) {
    return 'auth';
  }
  if (API_FAILURE_RE.test(combinedOutput)) {
    return 'api';
  }
  return 'command';
}

export function createExecOptions(cwd: string | undefined, timeout: number | undefined) {
  if (cwd === undefined && timeout === undefined) {
    return undefined;
  }

  const options: MergeReadyExecOptions = {};
  if (cwd !== undefined) {
    options.cwd = cwd;
  }
  if (timeout !== undefined) {
    options.timeout = timeout;
  }
  return options;
}

export function normalizeExecResult(result: MergeReadyExecResult): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.exitCode ?? result.code ?? 0,
  };
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === 'string' ? error : String(error);
}

export function getErrorStringProperty(error: unknown, key: 'stdout' | 'stderr'): string {
  if (!error || typeof error !== 'object') {
    return '';
  }

  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

export function getErrorNumberProperty(error: unknown, key: 'exitCode' | 'code'): number | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : null;
}
