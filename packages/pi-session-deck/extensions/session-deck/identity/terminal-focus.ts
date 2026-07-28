import { readFile } from 'node:fs/promises';
import { normalizeSessionTerminalMetadata } from './metadata.js';
import { getIdentityRecordPath } from './store.js';
import type { IdentityFileReader } from './reader.js';
import type { SessionTerminalMetadata, SessionTmuxTerminalMetadata } from './types.js';

export interface TerminalGhosttyFocusTarget {
  kind: 'ghostty-terminal';
  terminalId: string;
}

export type IdentityTerminalFocusLookupFailureReason =
  | 'identity-missing'
  | 'identity-read-error'
  | 'identity-malformed'
  | 'runtime-mismatch'
  | 'terminal-missing'
  | 'terminal-target-incomplete';

export type TerminalFocusTarget =
  | {
      kind: 'iterm2-session';
      itermSessionId: string;
      revealUrl: string;
    }
  | TerminalGhosttyFocusTarget
  | {
      kind: 'tmux-session';
      socketName?: string;
      socketPath?: string;
      sessionName: string;
      sessionTarget: string;
      host?: TerminalGhosttyFocusTarget;
    };

export type IdentityTerminalFocusLookupResult =
  | { ok: true; target: TerminalFocusTarget }
  | {
      ok: false;
      reason: IdentityTerminalFocusLookupFailureReason;
      message: string;
    };

export interface IdentityTerminalFocusLookupOptions {
  identityDirectory?: string;
  readFile?: IdentityFileReader;
}

export async function lookupIdentityTerminalFocusTarget(
  runtimeId: string,
  options: IdentityTerminalFocusLookupOptions = {},
): Promise<IdentityTerminalFocusLookupResult> {
  const filePath = getIdentityRecordPath(runtimeId, options.identityDirectory);
  const readFileImpl = (options.readFile ?? readFile) as IdentityFileReader;

  let source: string;
  try {
    source = await readFileImpl(filePath, 'utf8');
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === 'ENOENT') {
      return {
        ok: false,
        reason: 'identity-missing',
        message: 'No identity metadata is available for the selected session.',
      };
    }

    return {
      ok: false,
      reason: 'identity-read-error',
      message: `Failed to read identity metadata: ${getErrorMessage(error)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    return {
      ok: false,
      reason: 'identity-malformed',
      message: `Identity metadata is malformed: ${getErrorMessage(error)}`,
    };
  }

  if (!isRecord(parsed)) {
    return {
      ok: false,
      reason: 'identity-malformed',
      message: 'Identity metadata is malformed for the selected session.',
    };
  }

  const loadedRuntimeId = parsed['runtimeId'];
  if (typeof loadedRuntimeId !== 'string' || loadedRuntimeId.length === 0) {
    return {
      ok: false,
      reason: 'identity-malformed',
      message: 'Identity metadata is missing a runtime id for the selected session.',
    };
  }

  if (loadedRuntimeId !== runtimeId) {
    return {
      ok: false,
      reason: 'runtime-mismatch',
      message: 'Identity metadata did not match the selected session.',
    };
  }

  const rawTerminal = parsed['terminal'];
  const terminal = normalizeSessionTerminalMetadata(rawTerminal);
  if (terminal === undefined) {
    return {
      ok: false,
      reason:
        isRecord(rawTerminal) && rawTerminal['kind'] === 'tmux'
          ? 'terminal-target-incomplete'
          : 'terminal-missing',
      message:
        isRecord(rawTerminal) && rawTerminal['kind'] === 'tmux'
          ? 'Tmux terminal metadata is incomplete for the selected session.'
          : 'No terminal metadata is available for the selected session.',
    };
  }

  const target = toTerminalFocusTarget(terminal);
  if (target === null) {
    return {
      ok: false,
      reason: 'terminal-target-incomplete',
      message: 'Terminal metadata is incomplete for the selected session.',
    };
  }

  return { ok: true, target };
}

export function toTerminalFocusTarget(
  terminal: SessionTerminalMetadata,
): TerminalFocusTarget | null {
  switch (terminal.kind) {
    case 'iterm2':
      return {
        kind: 'iterm2-session',
        itermSessionId: terminal.sessionId,
        revealUrl: terminal.revealUrl,
      };
    case 'ghostty':
      return {
        kind: 'ghostty-terminal',
        terminalId: terminal.terminalId,
      };
    case 'tmux': {
      const sessionTarget = buildTmuxSessionTarget(terminal);
      const target = {
        kind: 'tmux-session' as const,
        ...(terminal.socketPath === undefined ? {} : { socketPath: terminal.socketPath }),
        ...(terminal.socketPath !== undefined || terminal.socketName === undefined
          ? {}
          : { socketName: terminal.socketName }),
        sessionName: terminal.sessionName,
        sessionTarget,
        ...(terminal.host === undefined
          ? {}
          : {
              host: {
                kind: 'ghostty-terminal' as const,
                terminalId: terminal.host.terminalId,
              },
            }),
      };

      return buildTmuxAttachSessionArgv(target) === null ? null : target;
    }
  }
}

export function buildTmuxAttachArgv(terminal: SessionTmuxTerminalMetadata): string[] | null {
  return buildTmuxAttachSessionArgv({
    ...(terminal.socketPath === undefined ? {} : { socketPath: terminal.socketPath }),
    ...(terminal.socketPath !== undefined || terminal.socketName === undefined
      ? {}
      : { socketName: terminal.socketName }),
    sessionTarget: buildTmuxSessionTarget(terminal),
  });
}

export function buildTmuxAttachSessionArgv(target: {
  socketName?: string;
  socketPath?: string;
  sessionTarget: string;
}): string[] | null {
  const socketSelector = buildTmuxSocketSelector(target);
  if (socketSelector === null || !isNonBlankString(target.sessionTarget)) {
    return null;
  }

  return ['tmux', ...socketSelector, 'attach-session', '-E', '-t', target.sessionTarget];
}

export function buildTmuxHasSessionArgv(target: {
  socketName?: string;
  socketPath?: string;
  sessionTarget: string;
}): string[] | null {
  const socketSelector = buildTmuxSocketSelector(target);
  if (socketSelector === null || !isNonBlankString(target.sessionTarget)) {
    return null;
  }

  return ['tmux', ...socketSelector, 'has-session', '-t', target.sessionTarget];
}

function buildTmuxSessionTarget(target: { sessionId?: string; sessionName: string }): string {
  return target.sessionId ?? `=${target.sessionName}`;
}

export function formatPosixCommand(argv: readonly string[]): string {
  return argv.map(quotePosixArg).join(' ');
}

export function quotePosixArg(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) {
    return arg;
  }

  return `'${arg.replaceAll("'", "'\\''")}'`;
}

function buildTmuxSocketSelector(target: {
  socketName?: string;
  socketPath?: string;
}): string[] | null {
  if (target.socketPath !== undefined) {
    return isNonBlankString(target.socketPath) ? ['-S', target.socketPath] : null;
  }

  if (target.socketName !== undefined) {
    return isNonBlankString(target.socketName) && !target.socketName.includes('/')
      ? ['-L', target.socketName]
      : null;
  }

  return null;
}

function isNonBlankString(value: string): boolean {
  return value.trim().length > 0;
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}
