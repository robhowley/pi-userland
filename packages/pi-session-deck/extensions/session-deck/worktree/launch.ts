import { createHash, randomUUID as nodeRandomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  PI_SESSION_DECK_RUNTIME_ID_ENV,
  PI_SESSION_DECK_RUNTIME_STARTED_AT_ENV,
  PI_SESSION_DECK_SESSION_FILE_ENV,
  PI_SESSION_DECK_SESSION_ID_ENV,
} from '../identity/runtime-signals.js';
import { formatPosixCommand, quotePosixArg } from '../identity/terminal-focus.js';
import { PI_SESSION_DECK_ASSIGNED_RUNTIME_ID_ENV } from '../presence/constants.js';
import { isValidAssignedPresenceRuntimeId } from '../presence/store.js';
import { buildLaunchAgentDirEnvPlan, normalizeLaunchAgentDirSelection } from './agent-dir.js';
import { defaultWorktreeExecFile, type ExecFileResult, type WorktreeExecFile } from './git.js';
import { slugifyWorktreeLabel } from './create.js';
import type {
  CreateWorktreeLaunchAgentDir,
  CreateWorktreeLaunchFailure,
  CreateWorktreeLaunchSuccess,
  CreateWorktreeSuccess,
  FreshDetachedTmuxPiCleanupFailure,
  FreshDetachedTmuxPiLaunchResult,
  LaunchPrereqFailureReason,
} from './types.js';

export interface LaunchDetachedTmuxPiOptions {
  execFile?: WorktreeExecFile;
  env?: NodeJS.ProcessEnv;
  postLaunchVerifyDelayMs?: number;
  agentDir?: CreateWorktreeLaunchAgentDir;
  randomUUID?: () => string;
}

export interface DetachedTmuxPiLaunchTarget {
  cwd: string;
  repoName: string | null;
}

type DetachedTmuxPiLaunchCopyMode = 'worktree' | 'session';
type DetachedTmuxPiLaunchPolicy = { kind: 'managed' } | { kind: 'fresh'; runtimeId: string };

interface ResolvedLaunchDetachedTmuxPiOptions extends LaunchDetachedTmuxPiOptions {
  env: NodeJS.ProcessEnv;
  postLaunchVerifyDelayMs: number;
  agentDir: CreateWorktreeLaunchAgentDir;
}

export type DetachedTmuxPiPreflightResult =
  | { ok: true }
  | {
      ok: false;
      reason: LaunchPrereqFailureReason;
    };

const TMUX_SESSION_NAME_LIMIT = 80;
const POST_LAUNCH_VERIFY_DELAY_MS = 1_000;
const DECK_HANDOFF_ENV_KEYS = [
  PI_SESSION_DECK_RUNTIME_ID_ENV,
  PI_SESSION_DECK_SESSION_ID_ENV,
  PI_SESSION_DECK_SESSION_FILE_ENV,
  PI_SESSION_DECK_RUNTIME_STARTED_AT_ENV,
] as const;

export async function preflightDetachedTmuxPi(
  options: LaunchDetachedTmuxPiOptions = {},
): Promise<DetachedTmuxPiPreflightResult> {
  const resolvedOptions = resolveLaunchOptions(options);
  const tmuxPreflight = await run(resolvedOptions, 'tmux', ['-V']);
  if (tmuxPreflight.exitCode !== 0) {
    return { ok: false, reason: 'tmux-unavailable' };
  }

  const piPreflight = await run(resolvedOptions, 'which', ['pi']);
  if (piPreflight.exitCode !== 0) {
    return { ok: false, reason: 'pi-command-unavailable' };
  }

  return { ok: true };
}

export async function launchDetachedTmuxPi(
  worktree: CreateWorktreeSuccess,
  displayName: string,
  options: LaunchDetachedTmuxPiOptions = {},
): Promise<CreateWorktreeLaunchSuccess | CreateWorktreeLaunchFailure> {
  return await launchDetachedTmuxPiForTarget(
    { cwd: worktree.path, repoName: worktree.repoName },
    displayName,
    options,
    'worktree',
    { kind: 'managed' },
  );
}

export async function launchDetachedTmuxPiForCwd(
  target: DetachedTmuxPiLaunchTarget,
  displayName: string,
  options: LaunchDetachedTmuxPiOptions = {},
): Promise<CreateWorktreeLaunchSuccess | CreateWorktreeLaunchFailure> {
  return await launchDetachedTmuxPiForTarget(target, displayName, options, 'session', {
    kind: 'managed',
  });
}

export async function launchFreshDetachedTmuxPiForCwd(
  target: DetachedTmuxPiLaunchTarget,
  displayName: string,
  options: LaunchDetachedTmuxPiOptions = {},
): Promise<FreshDetachedTmuxPiLaunchResult> {
  const runtimeId = (options.randomUUID ?? nodeRandomUUID)();
  if (!isValidAssignedPresenceRuntimeId(runtimeId)) {
    throw new Error('Fresh runtime identity generator must return a safe UUID v4.');
  }

  return await launchDetachedTmuxPiForTarget(target, displayName, options, 'session', {
    kind: 'fresh',
    runtimeId,
  });
}

async function launchDetachedTmuxPiForTarget(
  target: DetachedTmuxPiLaunchTarget,
  displayName: string,
  options: LaunchDetachedTmuxPiOptions,
  copyMode: DetachedTmuxPiLaunchCopyMode,
  policy: { kind: 'fresh'; runtimeId: string },
): Promise<FreshDetachedTmuxPiLaunchResult>;
async function launchDetachedTmuxPiForTarget(
  target: DetachedTmuxPiLaunchTarget,
  displayName: string,
  options: LaunchDetachedTmuxPiOptions,
  copyMode: DetachedTmuxPiLaunchCopyMode,
  policy: { kind: 'managed' },
): Promise<CreateWorktreeLaunchSuccess | CreateWorktreeLaunchFailure>;
async function launchDetachedTmuxPiForTarget(
  target: DetachedTmuxPiLaunchTarget,
  displayName: string,
  options: LaunchDetachedTmuxPiOptions,
  copyMode: DetachedTmuxPiLaunchCopyMode,
  policy: DetachedTmuxPiLaunchPolicy,
): Promise<
  CreateWorktreeLaunchSuccess | CreateWorktreeLaunchFailure | FreshDetachedTmuxPiCleanupFailure
> {
  const resolvedOptions = resolveLaunchOptions(options);
  const launchCommand = buildPiLauncherCommand(
    displayName,
    resolvedOptions.env['PATH'] ?? '',
    resolvedOptions.agentDir,
    policy.kind === 'fresh' ? policy.runtimeId : undefined,
  );
  const deckHandoffEnvArgs = buildTmuxEnvironmentArgs(resolvedOptions.env);
  const sessionName =
    policy.kind === 'fresh'
      ? buildFreshTmuxSessionName({
          cwd: target.cwd,
          label: displayName,
          runtimeId: policy.runtimeId,
        })
      : buildManagedTmuxSessionName({
          repoName: target.repoName,
          worktreePath: target.cwd,
          label: displayName,
        });
  const tmuxTarget = `=${sessionName}`;
  const manualAttachCommand = formatPosixCommand(['tmux', 'attach-session', '-t', tmuxTarget]);
  const manualCommand = `cd ${quotePosixArg(target.cwd)} && ${launchCommand}`;

  const preflight = await preflightDetachedTmuxPi(resolvedOptions);
  if (!preflight.ok) {
    return prereqLaunchFailure(preflight.reason, manualCommand, copyMode);
  }

  const existing = await tmuxHasSession(sessionName, resolvedOptions);
  if (existing) {
    if (policy.kind === 'fresh') {
      return {
        requested: true,
        ok: false,
        mode: 'tmux-detached',
        status: 'failed',
        reason: 'tmux-name-collision',
        recoverable: true,
        message: nameCollisionMessage(sessionName, copyMode),
        manualCommand,
      };
    }

    const cwd = await readTmuxSessionCwd(sessionName, resolvedOptions);
    if (cwd !== target.cwd) {
      return {
        requested: true,
        ok: false,
        mode: 'tmux-detached',
        status: 'failed',
        reason: 'tmux-name-collision',
        recoverable: true,
        message: nameCollisionMessage(sessionName, copyMode),
        manualCommand,
      };
    }

    if (resolvedOptions.agentDir.mode !== 'ambient') {
      return {
        requested: true,
        ok: false,
        mode: 'tmux-detached',
        status: 'failed',
        reason: 'launch-context-mismatch',
        recoverable: true,
        message: launchContextMismatchMessage(sessionName, copyMode),
        manualCommand,
      };
    }

    return {
      requested: true,
      ok: true,
      mode: 'tmux-detached',
      status: 'reused-existing',
      tmuxSessionName: sessionName,
      tmuxTarget,
      message: 'Reused an existing detached tmux Pi session.',
      manualAttachCommand,
    };
  }

  const launchResult = await run(resolvedOptions, 'tmux', [
    'new-session',
    ...(policy.kind === 'fresh' ? ['-P', '-F', '#{session_id}'] : []),
    ...deckHandoffEnvArgs,
    '-d',
    '-s',
    sessionName,
    '-c',
    target.cwd,
    '-n',
    safeTmuxWindowName(displayName),
    launchCommand,
  ]);
  if (launchResult.exitCode !== 0) {
    return {
      requested: true,
      ok: false,
      mode: 'tmux-detached',
      status: 'failed',
      reason: 'spawn-failed',
      recoverable: true,
      message: spawnFailureMessage(launchResult, copyMode),
      manualCommand,
    };
  }

  const freshTmuxSessionId =
    policy.kind === 'fresh' ? parseTmuxSessionId(launchResult.stdout) : null;
  const verification = await verifyLaunchedTmuxSession(sessionName, target.cwd, resolvedOptions);
  if (!verification.ok) {
    if (policy.kind === 'fresh') {
      const cleanupTarget = freshTmuxSessionId ?? `=${sessionName}`;
      const cleanupConfirmed = await killTmuxSession(cleanupTarget, resolvedOptions);
      if (!cleanupConfirmed) {
        return postLaunchCleanupFailure(policy.runtimeId, manualCommand, copyMode);
      }
    }
    return postLaunchVerificationFailure(verification.observedCwd, manualCommand, copyMode);
  }

  return {
    requested: true,
    ok: true,
    mode: 'tmux-detached',
    status: 'launched',
    tmuxSessionName: sessionName,
    tmuxTarget,
    ...(policy.kind === 'fresh' ? { runtimeId: policy.runtimeId } : {}),
    message: 'Started a detached tmux Pi session.',
    manualAttachCommand,
  };
}

export function buildManagedTmuxSessionName(input: {
  repoName: string | null;
  worktreePath: string;
  label: string;
}): string {
  const repoSlug = slugifyWorktreeLabel(input.repoName ?? basename(input.worktreePath)) ?? 'repo';
  const labelSlug = slugifyWorktreeLabel(input.label) ?? 'worktree';
  const hash = createHash('sha256')
    .update(`${input.worktreePath}\0${input.label}`)
    .digest('hex')
    .slice(0, 8);
  const prefix = sanitizeTmuxName(`pi-${repoSlug}-${labelSlug}`);
  const boundedPrefix = prefix.slice(0, Math.max(1, TMUX_SESSION_NAME_LIMIT - hash.length - 1));
  return `${boundedPrefix}-${hash}`;
}

export function buildFreshTmuxSessionName(input: {
  cwd: string;
  label: string;
  runtimeId: string;
}): string {
  const cwdSlug = slugifyWorktreeLabel(basename(input.cwd)) ?? 'cwd';
  const labelSlug = slugifyWorktreeLabel(input.label) ?? 'session';
  const prefix = sanitizeTmuxName(`pi-${cwdSlug}-${labelSlug}`);
  const boundedPrefix = prefix.slice(
    0,
    Math.max(1, TMUX_SESSION_NAME_LIMIT - input.runtimeId.length - 1),
  );
  return `${boundedPrefix}-${input.runtimeId}`;
}

export function buildPiLauncherCommand(
  displayName: string,
  pathValue: string,
  agentDir: CreateWorktreeLaunchAgentDir = { mode: 'ambient' },
  assignedRuntimeId?: string,
): string {
  const normalized = normalizeLaunchAgentDirSelection(agentDir);
  if (!normalized.ok) {
    throw new Error(normalized.message);
  }
  const envPlan = buildLaunchAgentDirEnvPlan(normalized.agentDir);
  const assignedRuntimeEnv =
    assignedRuntimeId === undefined
      ? []
      : [`${PI_SESSION_DECK_ASSIGNED_RUNTIME_ID_ENV}=${assignedRuntimeId}`];
  const envArgs =
    envPlan.envAction === 'unset'
      ? ['-u', 'PI_CODING_AGENT_DIR', `PATH=${pathValue}`, ...assignedRuntimeEnv]
      : [
          `PATH=${pathValue}`,
          ...(envPlan.envAssignment === undefined ? [] : [envPlan.envAssignment]),
          ...assignedRuntimeEnv,
        ];
  return `exec ${formatPosixCommand(['/usr/bin/env', ...envArgs, 'pi', '--name', displayName])}`;
}

export function buildTmuxEnvironmentArgs(env: NodeJS.ProcessEnv): string[] {
  return DECK_HANDOFF_ENV_KEYS.flatMap((key) => {
    const value = trimNonEmpty(env[key]);
    return value === undefined ? [] : ['-e', `${key}=${value}`];
  });
}

async function tmuxHasSession(
  sessionName: string,
  options: ResolvedLaunchDetachedTmuxPiOptions,
): Promise<boolean> {
  const result = await run(options, 'tmux', ['has-session', '-t', `=${sessionName}`]);
  return result.exitCode === 0;
}

function parseTmuxSessionId(value: string): string | null {
  const sessionId = value.trim();
  return /^\$[0-9]+$/u.test(sessionId) ? sessionId : null;
}

async function killTmuxSession(
  target: string,
  options: ResolvedLaunchDetachedTmuxPiOptions,
): Promise<boolean> {
  try {
    const result = await run(options, 'tmux', ['kill-session', '-t', target]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function verifyLaunchedTmuxSession(
  sessionName: string,
  expectedCwd: string,
  options: ResolvedLaunchDetachedTmuxPiOptions,
): Promise<{ ok: true } | { ok: false; observedCwd: string | null }> {
  if (options.postLaunchVerifyDelayMs > 0) {
    await sleep(options.postLaunchVerifyDelayMs);
  }

  const observedCwd = await readTmuxSessionCwd(sessionName, options);
  return observedCwd === expectedCwd ? { ok: true } : { ok: false, observedCwd };
}

async function readTmuxSessionCwd(
  sessionName: string,
  options: ResolvedLaunchDetachedTmuxPiOptions,
): Promise<string | null> {
  const result = await run(options, 'tmux', [
    'display-message',
    '-p',
    '-t',
    `=${sessionName}:0.0`,
    '#{pane_current_path}',
  ]);
  if (result.exitCode !== 0) {
    return null;
  }

  const cwd = result.stdout.trim();
  return cwd.length === 0 ? null : cwd;
}

async function run(
  options: ResolvedLaunchDetachedTmuxPiOptions,
  file: string,
  args: readonly string[],
): Promise<ExecFileResult> {
  return await (options.execFile ?? defaultWorktreeExecFile)(file, args, {
    env: options.env,
    timeoutMs: 10_000,
  });
}

function resolveLaunchOptions(
  options: LaunchDetachedTmuxPiOptions,
): ResolvedLaunchDetachedTmuxPiOptions {
  const agentDir = normalizeLaunchAgentDirSelection(options.agentDir);
  if (!agentDir.ok) {
    throw new Error(agentDir.message);
  }
  return {
    ...options,
    env: options.env ?? process.env,
    postLaunchVerifyDelayMs: options.postLaunchVerifyDelayMs ?? POST_LAUNCH_VERIFY_DELAY_MS,
    agentDir: agentDir.agentDir,
  };
}

function prereqLaunchFailure(
  reason: LaunchPrereqFailureReason,
  manualCommand: string,
  copyMode: DetachedTmuxPiLaunchCopyMode,
): CreateWorktreeLaunchFailure {
  return {
    requested: true,
    ok: false,
    mode: 'tmux-detached',
    status: 'failed',
    reason,
    recoverable: true,
    message: prereqFailureMessage(reason, copyMode),
    manualCommand,
  };
}

function postLaunchVerificationFailure(
  observedCwd: string | null,
  manualCommand: string,
  copyMode: DetachedTmuxPiLaunchCopyMode,
): CreateWorktreeLaunchFailure {
  return {
    requested: true,
    ok: false,
    mode: 'tmux-detached',
    status: 'failed',
    reason: 'presence-timeout',
    recoverable: true,
    message: postLaunchVerificationMessage(observedCwd, copyMode),
    manualCommand,
  };
}

function postLaunchCleanupFailure(
  runtimeId: string,
  manualCommand: string,
  copyMode: DetachedTmuxPiLaunchCopyMode,
): FreshDetachedTmuxPiCleanupFailure {
  return {
    requested: true,
    ok: false,
    mode: 'tmux-detached',
    status: 'failed',
    reason: 'cleanup-failed',
    recoverable: false,
    runtimeId,
    message:
      copyMode === 'session'
        ? 'Pi launch verification failed and tmux cleanup could not be confirmed.'
        : 'Created worktree, but tmux cleanup after launch verification could not be confirmed.',
    manualCommand,
  };
}

function prereqFailureMessage(
  reason: LaunchPrereqFailureReason,
  copyMode: DetachedTmuxPiLaunchCopyMode,
): string {
  if (copyMode === 'session') {
    return reason === 'tmux-unavailable'
      ? 'New Pi session requires tmux on PATH; no session was launched.'
      : 'New Pi session requires the pi executable on PATH; no session was launched.';
  }

  return reason === 'tmux-unavailable'
    ? 'Created worktree, but tmux is not available on PATH.'
    : 'Created worktree, but the pi executable is not available on PATH.';
}

function nameCollisionMessage(sessionName: string, copyMode: DetachedTmuxPiLaunchCopyMode): string {
  return copyMode === 'session'
    ? 'Pi did not start because the generated tmux session name is already in use for a different cwd.'
    : `Created worktree, but tmux session ${sessionName} already exists for a different cwd.`;
}

function launchContextMismatchMessage(
  sessionName: string,
  copyMode: DetachedTmuxPiLaunchCopyMode,
): string {
  return copyMode === 'session'
    ? 'Existing managed tmux session cannot be verified against the requested Pi config.'
    : `Created worktree, but existing tmux session ${sessionName} cannot be verified against the requested Pi config.`;
}

function spawnFailureMessage(
  result: ExecFileResult,
  copyMode: DetachedTmuxPiLaunchCopyMode,
): string {
  return copyMode === 'session'
    ? 'tmux could not start Pi.'
    : `Created worktree, but tmux could not start Pi: ${formatCommandError(result)}`;
}

function postLaunchVerificationMessage(
  observedCwd: string | null,
  copyMode: DetachedTmuxPiLaunchCopyMode,
): string {
  if (copyMode === 'session') {
    return observedCwd === null
      ? 'Pi did not remain running in tmux.'
      : 'The launched tmux pane is not in the requested cwd.';
  }

  return observedCwd === null
    ? 'Created worktree, but Pi did not remain running in tmux.'
    : 'Created worktree, but the launched tmux pane is not in the worktree.';
}

function safeTmuxWindowName(displayName: string): string {
  const slug = slugifyWorktreeLabel(displayName) ?? 'pi';
  return slug.slice(0, 32);
}

function sanitizeTmuxName(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return sanitized.length === 0 ? 'pi-session' : sanitized;
}

function formatCommandError(result: ExecFileResult): string {
  return (result.stderr || result.stdout).trim() || `exit ${result.exitCode}`;
}

function trimNonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
