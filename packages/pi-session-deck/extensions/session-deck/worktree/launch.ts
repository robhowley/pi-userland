import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  PI_SESSION_DECK_RUNTIME_ID_ENV,
  PI_SESSION_DECK_RUNTIME_STARTED_AT_ENV,
  PI_SESSION_DECK_SESSION_FILE_ENV,
  PI_SESSION_DECK_SESSION_ID_ENV,
} from '../identity/runtime-signals.js';
import { formatPosixCommand, quotePosixArg } from '../identity/terminal-focus.js';
import { buildLaunchAgentDirEnvPlan, normalizeLaunchAgentDirSelection } from './agent-dir.js';
import { defaultWorktreeExecFile, type ExecFileResult, type WorktreeExecFile } from './git.js';
import { slugifyWorktreeLabel } from './create.js';
import type {
  CreateWorktreeLaunchAgentDir,
  CreateWorktreeLaunchFailure,
  CreateWorktreeLaunchSuccess,
  CreateWorktreeSuccess,
  LaunchPrereqFailureReason,
} from './types.js';

export interface LaunchDetachedTmuxPiOptions {
  execFile?: WorktreeExecFile;
  env?: NodeJS.ProcessEnv;
  postLaunchVerifyDelayMs?: number;
  agentDir?: CreateWorktreeLaunchAgentDir;
}

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
  const resolvedOptions = resolveLaunchOptions(options);
  const launchCommand = buildPiLauncherCommand(
    displayName,
    resolvedOptions.env['PATH'] ?? '',
    resolvedOptions.agentDir,
  );
  const deckHandoffEnvArgs = buildTmuxEnvironmentArgs(resolvedOptions.env);
  const sessionName = buildManagedTmuxSessionName({
    repoName: worktree.repoName,
    worktreePath: worktree.path,
    label: displayName,
  });
  const tmuxTarget = `=${sessionName}`;
  const manualAttachCommand = formatPosixCommand(['tmux', 'attach-session', '-t', tmuxTarget]);
  const manualCommand = `cd ${quotePosixArg(worktree.path)} && ${launchCommand}`;

  const preflight = await preflightDetachedTmuxPi(resolvedOptions);
  if (!preflight.ok) {
    return prereqLaunchFailure(preflight.reason, manualCommand);
  }

  const existing = await tmuxHasSession(sessionName, resolvedOptions);
  if (existing) {
    const cwd = await readTmuxSessionCwd(sessionName, resolvedOptions);
    if (cwd !== worktree.path) {
      return {
        requested: true,
        ok: false,
        mode: 'tmux-detached',
        status: 'failed',
        reason: 'tmux-name-collision',
        recoverable: true,
        message: `Created worktree, but tmux session ${sessionName} already exists for a different cwd.`,
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
        message: `Created worktree, but existing tmux session ${sessionName} cannot be verified against the requested Pi config.`,
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
    ...deckHandoffEnvArgs,
    '-d',
    '-s',
    sessionName,
    '-c',
    worktree.path,
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
      message: `Created worktree, but tmux could not start Pi: ${formatCommandError(launchResult)}`,
      manualCommand,
    };
  }

  const verification = await verifyLaunchedTmuxSession(sessionName, worktree.path, resolvedOptions);
  if (!verification.ok) {
    return postLaunchVerificationFailure(verification.observedCwd, manualCommand);
  }

  return {
    requested: true,
    ok: true,
    mode: 'tmux-detached',
    status: 'launched',
    tmuxSessionName: sessionName,
    tmuxTarget,
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

export function buildPiLauncherCommand(
  displayName: string,
  pathValue: string,
  agentDir: CreateWorktreeLaunchAgentDir = { mode: 'ambient' },
): string {
  const normalized = normalizeLaunchAgentDirSelection(agentDir);
  if (!normalized.ok) {
    throw new Error(normalized.message);
  }
  const envPlan = buildLaunchAgentDirEnvPlan(normalized.agentDir);
  const envArgs =
    envPlan.envAction === 'unset'
      ? ['-u', 'PI_CODING_AGENT_DIR', `PATH=${pathValue}`]
      : [
          `PATH=${pathValue}`,
          ...(envPlan.envAssignment === undefined ? [] : [envPlan.envAssignment]),
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
): CreateWorktreeLaunchFailure {
  return {
    requested: true,
    ok: false,
    mode: 'tmux-detached',
    status: 'failed',
    reason,
    recoverable: true,
    message:
      reason === 'tmux-unavailable'
        ? 'Created worktree, but tmux is not available on PATH.'
        : 'Created worktree, but the pi executable is not available on PATH.',
    manualCommand,
  };
}

function postLaunchVerificationFailure(
  observedCwd: string | null,
  manualCommand: string,
): CreateWorktreeLaunchFailure {
  return {
    requested: true,
    ok: false,
    mode: 'tmux-detached',
    status: 'failed',
    reason: 'presence-timeout',
    recoverable: true,
    message:
      observedCwd === null
        ? 'Created worktree, but Pi did not remain running in tmux.'
        : 'Created worktree, but the launched tmux pane is not in the worktree.',
    manualCommand,
  };
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
