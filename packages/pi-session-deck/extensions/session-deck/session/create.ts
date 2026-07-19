import { stat as defaultStat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, resolve } from 'node:path';
import { normalizeLaunchAgentDirSelection } from '../worktree/agent-dir.js';
import {
  launchDetachedTmuxPiForCwd,
  preflightDetachedTmuxPi,
  type LaunchDetachedTmuxPiOptions,
} from '../worktree/launch.js';
import type { CreateWorktreeLaunchAgentDir, LaunchPrereqFailure } from '../worktree/types.js';
import type {
  CreateSessionActionRequest,
  CreateSessionActionResult,
  CreateSessionFailureReason,
} from './types.js';

export interface CreateSessionCwdOptions {
  homeDir?: string;
}

export type LaunchCwdStat = (path: string) => Promise<{ isDirectory(): boolean }>;

export interface ValidateLaunchCwdOptions extends CreateSessionCwdOptions {
  stat?: LaunchCwdStat;
}

export interface OrchestrateCreateSessionOptions
  extends LaunchDetachedTmuxPiOptions, ValidateLaunchCwdOptions {}

export type NormalizedCreateSessionActionRequest = CreateSessionActionRequest & {
  cwd: string;
  launch: {
    mode: 'tmux-detached';
    agentDir: CreateWorktreeLaunchAgentDir;
  };
};

type CreateSessionValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: CreateSessionFailureReason; message: string };

const CREATE_SESSION_ALLOWED_FIELDS = new Set([
  'action',
  'cwd',
  'launch',
  'launch.mode',
  'launch.agentDir',
  'launch.agentDir.mode',
  'launch.agentDir.customDir',
]);

export function normalizeCreateSessionActionRequest(
  parsed: unknown,
  options: CreateSessionCwdOptions = {},
):
  | { ok: true; request: NormalizedCreateSessionActionRequest }
  | { ok: false; reason: CreateSessionFailureReason; message: string } {
  if (!isRecord(parsed)) {
    return { ok: false, reason: 'invalid-request', message: 'Request body must be a JSON object.' };
  }

  const disallowed = findDisallowedCreateSessionField(parsed);
  if (disallowed !== null) {
    return {
      ok: false,
      reason: 'invalid-request',
      message: `Field is not accepted by this action boundary: ${disallowed}`,
    };
  }

  if (parsed['action'] !== 'create-session') {
    return { ok: false, reason: 'invalid-request', message: 'action must be create-session.' };
  }

  const cwdValue = parsed['cwd'];
  if (typeof cwdValue !== 'string') {
    return { ok: false, reason: 'invalid-request', message: 'cwd is required.' };
  }

  const cwd = resolveLaunchCwd(cwdValue, options);
  if (!cwd.ok) {
    return cwd;
  }

  const launch = parsed['launch'];
  if (launch !== undefined && !isRecord(launch)) {
    return {
      ok: false,
      reason: 'invalid-request',
      message: 'launch must be an object when provided.',
    };
  }
  if (isRecord(launch) && launch['mode'] !== undefined && launch['mode'] !== 'tmux-detached') {
    return {
      ok: false,
      reason: 'invalid-request',
      message: 'launch.mode must be tmux-detached when provided.',
    };
  }

  const agentDir = normalizeLaunchAgentDirSelection(
    isRecord(launch) ? launch['agentDir'] : undefined,
    options,
  );
  if (!agentDir.ok) {
    return { ok: false, reason: 'invalid-request', message: agentDir.message };
  }

  return {
    ok: true,
    request: {
      action: 'create-session',
      cwd: cwd.value,
      launch: { mode: 'tmux-detached', agentDir: agentDir.agentDir },
    },
  };
}

export function resolveLaunchCwd(
  value: string,
  options: CreateSessionCwdOptions = {},
): CreateSessionValidationResult<string> {
  if (value.includes('\0') || /[\r\n]/u.test(value)) {
    return {
      ok: false,
      reason: 'invalid-cwd',
      message: 'Working directory must not contain newlines or NUL bytes.',
    };
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'invalid-cwd', message: 'Working directory is required.' };
  }

  const expanded = expandHome(trimmed, options);
  if (expanded === null || !isAbsolute(expanded)) {
    return {
      ok: false,
      reason: 'invalid-cwd',
      message: 'Working directory must be absolute, ~, or start with ~/.',
    };
  }

  return { ok: true, value: resolve(expanded) };
}

export async function validateLaunchCwd(
  value: string,
  options: ValidateLaunchCwdOptions = {},
): Promise<CreateSessionValidationResult<string>> {
  const cwd = resolveLaunchCwd(value, options);
  if (!cwd.ok) {
    return cwd;
  }

  let stats: { isDirectory(): boolean };
  try {
    stats = await (options.stat ?? defaultStat)(cwd.value);
  } catch (error) {
    return {
      ok: false,
      reason: isMissingPathError(error) ? 'cwd-not-found' : 'cwd-unavailable',
      message: isMissingPathError(error)
        ? `Working directory does not exist: ${cwd.value}`
        : `Working directory could not be checked: ${cwd.value}`,
    };
  }

  if (!stats.isDirectory()) {
    return {
      ok: false,
      reason: 'cwd-not-directory',
      message: `Working directory is not a directory: ${cwd.value}`,
    };
  }

  return cwd;
}

export async function orchestrateCreateSession(
  request: CreateSessionActionRequest,
  options: OrchestrateCreateSessionOptions = {},
): Promise<CreateSessionActionResult> {
  const normalized = normalizeCreateSessionActionRequest(request, options);
  if (!normalized.ok) {
    return validationFailure(normalized.reason, normalized.message);
  }

  const cwd = await validateLaunchCwd(normalized.request.cwd, options);
  if (!cwd.ok) {
    return validationFailure(cwd.reason, cwd.message);
  }

  const launchOptions = buildLaunchOptions(options, normalized.request.launch.agentDir);
  const preflight = await preflightDetachedTmuxPi(launchOptions);
  if (!preflight.ok) {
    return {
      ok: false,
      status: 'preflight-failed',
      failurePhase: 'preflight',
      preflight: toPreflightFailure(preflight.reason),
      launch: { requested: false, mode: 'tmux-detached', status: 'not-started' },
    };
  }

  const displayName = basename(cwd.value) || 'No repo';
  const launch = await launchDetachedTmuxPiForCwd(
    { cwd: cwd.value, repoName: null },
    displayName,
    launchOptions,
  );
  if (!launch.ok) {
    return {
      ok: false,
      status: 'launch-failed',
      failurePhase: 'launch',
      cwd: cwd.value,
      launch,
    };
  }

  return {
    ok: true,
    status: launch.status === 'reused-existing' ? 'reused-existing' : 'launched',
    cwd: cwd.value,
    launch,
  };
}

function buildLaunchOptions(
  options: OrchestrateCreateSessionOptions,
  agentDir: CreateWorktreeLaunchAgentDir,
): LaunchDetachedTmuxPiOptions {
  return {
    ...(options.execFile === undefined ? {} : { execFile: options.execFile }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.postLaunchVerifyDelayMs === undefined
      ? {}
      : { postLaunchVerifyDelayMs: options.postLaunchVerifyDelayMs }),
    agentDir,
  };
}

function validationFailure(
  reason: CreateSessionFailureReason,
  message: string,
): Extract<CreateSessionActionResult, { status: 'failed' }> {
  return {
    ok: false,
    status: 'failed',
    failurePhase: 'validation',
    reason,
    message,
    recoverable: true,
  };
}

function toPreflightFailure(reason: LaunchPrereqFailure['reason']): LaunchPrereqFailure {
  return {
    reason,
    recoverable: true,
    message:
      reason === 'tmux-unavailable'
        ? 'New Pi session requires tmux on PATH; no session was launched.'
        : 'New Pi session requires the pi executable on PATH; no session was launched.',
  };
}

function findDisallowedCreateSessionField(value: unknown, prefix = ''): string | null {
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const path = prefix.length === 0 ? String(index) : `${prefix}.${index}`;
      if (!CREATE_SESSION_ALLOWED_FIELDS.has(path)) {
        return path;
      }
      const nested = findDisallowedCreateSessionField(child, path);
      if (nested !== null) {
        return nested;
      }
    }
    return null;
  }

  if (!isRecord(value)) {
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    const path = prefix.length === 0 ? key : `${prefix}.${key}`;
    if (!CREATE_SESSION_ALLOWED_FIELDS.has(path)) {
      return path;
    }
    const nested = findDisallowedCreateSessionField(child, path);
    if (nested !== null) {
      return nested;
    }
  }

  return null;
}

function expandHome(value: string, options: CreateSessionCwdOptions): string | null {
  if (value === '~') {
    return getHomeDir(options);
  }
  if (value.startsWith('~/')) {
    return resolve(getHomeDir(options), value.slice(2));
  }
  if (value.startsWith('~')) {
    return null;
  }
  return value;
}

function getHomeDir(options: CreateSessionCwdOptions): string {
  return resolve(options.homeDir ?? process.env['HOME'] ?? homedir());
}

function isMissingPathError(error: unknown): boolean {
  return isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}
