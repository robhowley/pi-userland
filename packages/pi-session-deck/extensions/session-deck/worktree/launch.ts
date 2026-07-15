import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { formatPosixCommand, quotePosixArg } from '../identity/terminal-focus.js';
import { defaultWorktreeExecFile, type WorktreeExecFile } from './git.js';
import { slugifyWorktreeLabel } from './create.js';
import type {
  CreateWorktreeLaunchFailure,
  CreateWorktreeLaunchSuccess,
  CreateWorktreeSuccess,
  LaunchPrereqFailureReason,
} from './types.js';

export interface LaunchDetachedTmuxPiOptions {
  execFile?: WorktreeExecFile;
}

interface TmuxCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type DetachedTmuxPiPreflightResult =
  | { ok: true }
  | {
      ok: false;
      reason: LaunchPrereqFailureReason;
    };

const TMUX_SESSION_NAME_LIMIT = 80;

export async function preflightDetachedTmuxPi(
  options: LaunchDetachedTmuxPiOptions = {},
): Promise<DetachedTmuxPiPreflightResult> {
  const tmuxPreflight = await run(options, 'tmux', ['-V']);
  if (tmuxPreflight.exitCode !== 0) {
    return { ok: false, reason: 'tmux-unavailable' };
  }

  const piPreflight = await run(options, 'which', ['pi']);
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
  const sessionName = buildManagedTmuxSessionName({
    repoName: worktree.repoName,
    worktreePath: worktree.path,
    label: displayName,
  });
  const tmuxTarget = `=${sessionName}`;
  const manualAttachCommand = formatPosixCommand(['tmux', 'attach-session', '-t', tmuxTarget]);
  const manualCommand = `cd ${quotePosixArg(worktree.path)} && ${buildPiLauncherCommand(displayName)}`;

  const preflight = await preflightDetachedTmuxPi(options);
  if (!preflight.ok) {
    return prereqLaunchFailure(preflight.reason, manualCommand);
  }

  const existing = await tmuxHasSession(sessionName, options);
  if (existing) {
    const cwd = await readTmuxSessionCwd(sessionName, options);
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

  const launchCommand = buildPiLauncherCommand(displayName);
  const launchResult = await run(options, 'tmux', [
    'new-session',
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

export function buildPiLauncherCommand(displayName: string): string {
  return `exec pi --name ${quotePosixArg(displayName)}`;
}

async function tmuxHasSession(
  sessionName: string,
  options: LaunchDetachedTmuxPiOptions,
): Promise<boolean> {
  const result = await run(options, 'tmux', ['has-session', '-t', `=${sessionName}`]);
  return result.exitCode === 0;
}

async function readTmuxSessionCwd(
  sessionName: string,
  options: LaunchDetachedTmuxPiOptions,
): Promise<string | null> {
  const result = await run(options, 'tmux', [
    'display-message',
    '-p',
    '-t',
    `=${sessionName}`,
    '#{pane_current_path}',
  ]);
  if (result.exitCode !== 0) {
    return null;
  }

  const cwd = result.stdout.trim();
  return cwd.length === 0 ? null : cwd;
}

async function run(
  options: LaunchDetachedTmuxPiOptions,
  file: string,
  args: readonly string[],
): Promise<TmuxCommandResult> {
  return await (options.execFile ?? defaultWorktreeExecFile)(file, args, { timeoutMs: 10_000 });
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

function safeTmuxWindowName(displayName: string): string {
  const slug = slugifyWorktreeLabel(displayName) ?? 'pi';
  return slug.slice(0, 32);
}

function sanitizeTmuxName(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return sanitized.length === 0 ? 'pi-session' : sanitized;
}

function formatCommandError(result: TmuxCommandResult): string {
  return (result.stderr || result.stdout).trim() || `exit ${result.exitCode}`;
}
