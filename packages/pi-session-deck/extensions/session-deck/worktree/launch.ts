import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { basename } from 'node:path';
import { formatPosixCommand, quotePosixArg } from '../identity/terminal-focus.js';
import { readJoinedSessionView, type ReadJoinedSessionViewOptions } from '../identity/reader.js';
import type { JoinedSessionRecord } from '../identity/types.js';
import { readPresenceView, type ReadPresenceViewOptions } from '../presence/reader.js';
import { defaultWorktreeExecFile, type WorktreeExecFile } from './git.js';
import { slugifyWorktreeLabel } from './create.js';
import type { CreateWorktreeLaunchResult, CreateWorktreePhaseResult } from './types.js';

export interface LaunchDetachedTmuxPiOptions {
  execFile?: WorktreeExecFile;
  identityDirectory?: ReadJoinedSessionViewOptions['identityDirectory'];
  now?: Date;
  observeTimeoutMs?: number;
  pollIntervalMs?: number;
  presenceDirectory?: ReadPresenceViewOptions['directory'];
  readFile?: ReadPresenceViewOptions['readFile'];
  readdir?: ReadPresenceViewOptions['readdir'];
}

interface TmuxCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const DEFAULT_OBSERVE_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const TMUX_SESSION_NAME_LIMIT = 80;

export async function launchDetachedTmuxPi(
  worktree: Extract<CreateWorktreePhaseResult, { ok: true }>,
  displayName: string,
  options: LaunchDetachedTmuxPiOptions = {},
): Promise<CreateWorktreeLaunchResult> {
  const sessionName = buildManagedTmuxSessionName({
    repoName: worktree.repoName,
    worktreePath: worktree.path,
    label: displayName,
  });
  const tmuxTarget = `=${sessionName}`;
  const manualAttachCommand = formatPosixCommand(['tmux', 'attach-session', '-t', tmuxTarget]);
  const manualCommand = `cd ${quotePosixArg(worktree.path)} && ${buildPiLauncherCommand(displayName)}`;

  const tmuxPreflight = await run(options, 'tmux', ['-V']);
  if (tmuxPreflight.exitCode !== 0) {
    return {
      requested: true,
      ok: false,
      mode: 'tmux-detached',
      status: 'failed',
      reason: 'tmux-unavailable',
      recoverable: true,
      message: 'Created worktree, but tmux is not available on PATH.',
      manualCommand,
    };
  }

  const piPreflight = await run(options, 'which', ['pi']);
  if (piPreflight.exitCode !== 0) {
    return {
      requested: true,
      ok: false,
      mode: 'tmux-detached',
      status: 'failed',
      reason: 'pi-command-unavailable',
      recoverable: true,
      message: 'Created worktree, but the pi executable is not available on PATH.',
      manualCommand,
    };
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

    return await observeLaunchedSession(worktree.path, displayName, sessionName, {
      status: 'reused-existing',
      message: 'Reused an existing detached tmux Pi session.',
      manualAttachCommand,
      options,
    });
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

  return await observeLaunchedSession(worktree.path, displayName, sessionName, {
    status: 'launched',
    message: 'Started a detached tmux Pi session.',
    manualAttachCommand,
    options,
  });
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

async function observeLaunchedSession(
  worktreePath: string,
  displayName: string,
  tmuxSessionName: string,
  input: {
    status: 'launched' | 'reused-existing';
    message: string;
    manualAttachCommand: string;
    options: LaunchDetachedTmuxPiOptions;
  },
): Promise<CreateWorktreeLaunchResult> {
  const observed = await observeSessionDeckRuntime(
    worktreePath,
    displayName,
    tmuxSessionName,
    input.options,
  );
  if (observed !== null) {
    return {
      requested: true,
      ok: true,
      mode: 'tmux-detached',
      status: input.status,
      tmuxSessionName,
      tmuxTarget: `=${tmuxSessionName}`,
      runtimeId: observed.runtimeId,
      sessionId: observed.sessionId,
      message: `${input.message} Session ready · press o to attach.`,
      manualAttachCommand: input.manualAttachCommand,
    };
  }

  if (await tmuxHasSession(tmuxSessionName, input.options)) {
    return {
      requested: true,
      ok: true,
      mode: 'tmux-detached',
      status: 'requested-unobserved',
      tmuxSessionName,
      tmuxTarget: `=${tmuxSessionName}`,
      message: 'Started tmux Pi session, but Session Deck has not observed it yet.',
      warning: 'Press r to refresh; attach may be available once identity metadata is written.',
      manualAttachCommand: input.manualAttachCommand,
    };
  }

  return {
    requested: true,
    ok: false,
    mode: 'tmux-detached',
    status: 'failed',
    reason: 'presence-timeout',
    recoverable: true,
    message:
      'Created worktree, but the tmux Pi session disappeared before Session Deck observed it.',
  };
}

async function observeSessionDeckRuntime(
  worktreePath: string,
  displayName: string,
  tmuxSessionName: string,
  options: LaunchDetachedTmuxPiOptions,
): Promise<Pick<JoinedSessionRecord, 'runtimeId' | 'sessionId'> | null> {
  const timeoutMs = options.observeTimeoutMs ?? DEFAULT_OBSERVE_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const presenceView = await readPresenceView({
      ...(options.presenceDirectory === undefined ? {} : { directory: options.presenceDirectory }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.readdir === undefined ? {} : { readdir: options.readdir }),
      ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
    });
    const joined = await readJoinedSessionView({
      presenceView,
      ...(options.identityDirectory === undefined
        ? {}
        : { identityDirectory: options.identityDirectory }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.readdir === undefined ? {} : { readdir: options.readdir }),
      ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
    });
    const match = joined.records.find((record) =>
      matchesLaunchedSession(record, worktreePath, displayName, tmuxSessionName),
    );
    if (match !== undefined) {
      return { runtimeId: match.runtimeId, sessionId: match.sessionId };
    }

    if (Date.now() > deadline) {
      break;
    }
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }

  return null;
}

function matchesLaunchedSession(
  record: JoinedSessionRecord,
  worktreePath: string,
  displayName: string,
  tmuxSessionName: string,
): boolean {
  if (record.cwd !== worktreePath) {
    return false;
  }

  if (record.terminal?.kind === 'tmux' && record.terminal.sessionName === tmuxSessionName) {
    return true;
  }

  return record.sessionName === displayName;
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
