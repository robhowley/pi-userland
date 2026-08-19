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

export interface CmuxTarget {
  socketPath: string;
  workspaceId: string;
  surfaceId: string;
}

export type CmuxTargetResolution =
  | { ok: true; workspaceId: string; surfaceId: string }
  | { ok: false; reason: 'process-failed' | 'invalid-response'; message: string };

export type CmuxLaunchRecipe = { mode: 'fresh' } | { mode: 'fork'; sourceSessionFile: string };

const SOURCE_SESSION_ENV = 'PI_CMUX_JUNCTION_SOURCE_SESSION';
const FRESH_PI_COMMAND = 'exec pi';
const FORK_PI_COMMAND = 'exec pi --fork "$PI_CMUX_JUNCTION_SOURCE_SESSION"';

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

const CMUX_TARGET_RESOLUTION_TIMEOUT_MS = 2_000;
const CMUX_TARGET_RESOLUTION_MAX_BUFFER_BYTES = 64 * 1024;

export async function resolveCmuxTarget(
  cwd: string,
  target: CmuxTarget,
  options: CmuxOptions = {},
): Promise<CmuxTargetResolution> {
  const env = options.env ?? process.env;
  const socketPath = normalizeTargetIdentity(target.socketPath);
  const workspaceId = normalizeTargetIdentity(target.workspaceId);
  const surfaceId = normalizeTargetIdentity(target.surfaceId);
  if (socketPath === null || workspaceId === null || surfaceId === null) {
    return {
      ok: false,
      reason: 'invalid-response',
      message: 'cmux target resolution requires nonblank target identities',
    };
  }

  const cmuxFile = await resolveCmuxExecutable(env);
  const args = [
    '--socket',
    socketPath,
    'rpc',
    'agent.resolve_delivery_target',
    JSON.stringify({ surface_id: surfaceId, workspace_id: workspaceId }),
  ];
  let result: Awaited<ReturnType<ProcessRunner>>;
  try {
    result = await run(
      cmuxFile,
      args,
      cwd,
      env,
      options.timeoutMs === undefined
        ? { ...options, timeoutMs: CMUX_TARGET_RESOLUTION_TIMEOUT_MS }
        : options,
      CMUX_TARGET_RESOLUTION_MAX_BUFFER_BYTES,
    );
  } catch {
    return {
      ok: false,
      reason: 'process-failed',
      message: 'cmux target resolution could not run',
    };
  }
  if (!processSucceeded(result)) {
    return {
      ok: false,
      reason: 'process-failed',
      message: `cmux target resolution failed: ${processError(result)}`,
    };
  }

  const resolved = parseResolvedTarget(result.stdout, surfaceId);
  if (resolved === null) {
    return {
      ok: false,
      reason: 'invalid-response',
      message: 'cmux returned an invalid delivery target',
    };
  }
  return { ok: true, ...resolved };
}

export function buildWorkspaceCreateArgs(
  branch: string,
  worktreePath: string,
  recipe: CmuxLaunchRecipe = { mode: 'fresh' },
): string[] {
  const launchArgs =
    recipe.mode === 'fork'
      ? ['--env', `${SOURCE_SESSION_ENV}=${recipe.sourceSessionFile}`, '--command', FORK_PI_COMMAND]
      : ['--command', FRESH_PI_COMMAND];

  return [
    'workspace',
    'create',
    '--name',
    branch,
    '--cwd',
    worktreePath,
    ...launchArgs,
    '--focus',
    'false',
  ];
}

export async function launchCmuxWorkspace(
  branch: string,
  worktreePath: string,
  options: CmuxOptions = {},
  recipe: CmuxLaunchRecipe = { mode: 'fresh' },
): Promise<CmuxLaunchResult> {
  const env = options.env ?? process.env;
  const cmuxFile = await resolveCmuxExecutable(env);
  const result = await run(
    cmuxFile,
    buildWorkspaceCreateArgs(branch, worktreePath, recipe),
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
  maxBufferBytes?: number,
) {
  return await (options.runner ?? defaultProcessRunner)(file, args, {
    cwd,
    env,
    shell: false,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(maxBufferBytes === undefined ? {} : { maxBufferBytes }),
  });
}

function parseResolvedTarget(
  stdout: string,
  claimedSurfaceId: string,
): { workspaceId: string; surfaceId: string } | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!isRecord(value) || value['source'] !== 'surface') return null;

  const workspaceId = normalizeTargetIdentity(value['workspace_id']);
  const surfaceId = normalizeTargetIdentity(value['surface_id']);
  if (workspaceId === null || surfaceId === null || surfaceId !== claimedSurfaceId) {
    return null;
  }
  return { workspaceId, surfaceId };
}

function normalizeTargetIdentity(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 256) return null;
  for (const character of normalized) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return null;
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
