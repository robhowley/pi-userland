import { defaultProcessRunner, type ProcessRunner } from './process.js';

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
  | { ok: false; reason: 'launch-failed'; message: string };

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

  const cmux = await run('cmux', ['capabilities'], cwd, env, options);
  if (cmux.exitCode !== 0) {
    return {
      ok: false,
      reason: 'cmux-unavailable',
      message: `Junction requires an available cmux CLI; no worktree was created. ${commandError(cmux)}`,
    };
  }

  const pi = await run('which', ['pi'], cwd, env, options);
  if (pi.exitCode !== 0) {
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
  const result = await run(
    'cmux',
    buildWorkspaceCreateArgs(branch, worktreePath),
    worktreePath,
    options.env ?? process.env,
    options,
  );
  if (result.exitCode !== 0) {
    return {
      ok: false,
      reason: 'launch-failed',
      message: commandError(result),
    };
  }
  return { ok: true };
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

function commandError(result: { stdout: string; stderr: string; exitCode: number }): string {
  return (result.stderr || result.stdout).trim() || `exit ${result.exitCode}`;
}
