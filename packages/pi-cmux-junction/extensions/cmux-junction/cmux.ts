import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import {
  defaultProcessRunner,
  processError,
  processSucceeded,
  type ProcessRunner,
} from './process.js';

export interface CmuxOptions {
  runner?: ProcessRunner;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export type CmuxPreflightResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'missing-caller' | 'cmux-unavailable' | 'pi-unavailable';
      message: string;
    };

export type CmuxLaunchResult =
  | { ok: true }
  | { ok: false; reason: 'launch-failed' | 'launch-unknown'; message: string };

export async function preflightCmux(
  cwd: string,
  options: CmuxOptions = {},
): Promise<CmuxPreflightResult> {
  const env = options.env ?? process.env;
  if (!env['CMUX_WORKSPACE_ID']?.trim() || !env['CMUX_SURFACE_ID']?.trim()) {
    return {
      ok: false,
      reason: 'missing-caller',
      message:
        'Junction requires nonblank CMUX_WORKSPACE_ID and CMUX_SURFACE_ID; no worktree was created.',
    };
  }

  const cmuxFile = await resolveCmuxExecutable(env);
  const cmux = await run(cmuxFile, ['capabilities'], cwd, env, options);
  if (!processSucceeded(cmux)) {
    return {
      ok: false,
      reason: 'cmux-unavailable',
      message: `Junction requires an available cmux CLI; no worktree was created. ${processError(cmux)}`,
    };
  }

  const pi = await run('which', ['pi'], cwd, env, options);
  if (!processSucceeded(pi)) {
    return {
      ok: false,
      reason: 'pi-unavailable',
      message: 'Junction requires the pi executable on PATH; no worktree was created.',
    };
  }

  return { ok: true };
}

export function buildWorkspaceCreateArgs(branch: string, worktreePath: string): string[] {
  return [
    'workspace',
    'create',
    '--name',
    branch,
    '--cwd',
    worktreePath,
    '--command',
    'exec pi',
    '--focus',
    'false',
  ];
}

export async function launchCmuxWorkspace(
  branch: string,
  worktreePath: string,
  options: CmuxOptions = {},
): Promise<CmuxLaunchResult> {
  const env = options.env ?? process.env;
  const cmuxFile = await resolveCmuxExecutable(env);
  const result = await run(
    cmuxFile,
    buildWorkspaceCreateArgs(branch, worktreePath),
    worktreePath,
    env,
    options,
  );
  if (result.outcome === 'timeout' || result.outcome === 'signal') {
    return {
      ok: false,
      reason: 'launch-unknown',
      message: `${processError(result)}; cmux workspace creation may have completed.`,
    };
  }
  if (!processSucceeded(result)) {
    return {
      ok: false,
      reason: 'launch-failed',
      message: processError(result),
    };
  }
  return { ok: true };
}

async function resolveCmuxExecutable(env: NodeJS.ProcessEnv): Promise<string> {
  const bundled = env['CMUX_BUNDLED_CLI_PATH']?.trim();
  if (bundled === undefined || bundled.length === 0) return 'cmux';
  try {
    await access(bundled, constants.X_OK);
    return bundled;
  } catch {
    return 'cmux';
  }
}

async function run(
  file: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: CmuxOptions,
) {
  return await (options.runner ?? defaultProcessRunner)(file, args, {
    cwd,
    env,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}
