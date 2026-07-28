import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeGhosttyTerminalId, normalizeSessionTerminalMetadata } from './metadata.js';
import type { SessionTerminalMetadata, SessionTmuxTerminalMetadata } from './types.js';

const TMUX_COMMAND = 'tmux';
const OSASCRIPT_COMMAND = '/usr/bin/osascript';
const FIELD_SEPARATOR = '\u001f';
const DEFAULT_TMUX_TIMEOUT_MS = 500;
const DEFAULT_GHOSTTY_TIMEOUT_MS = 1000;
const MIN_GHOSTTY_APPLESCRIPT_VERSION = { major: 1, minor: 3 };
const execFile = promisify(execFileCallback);

const GHOSTTY_FOCUSED_TERMINAL_SCRIPT = `
on run argv
  if application "Ghostty" is not running then return "not-running"
  try
    tell application "Ghostty"
      if not frontmost then return "not-frontmost"
      if (count of windows) is 0 then return "no-window"
      set focusedTerminal to focused terminal of selected tab of front window
      return "ok" & tab & (version as text) & tab & (id of focusedTerminal as text)
    end tell
  on error errMsg number errNum
    return "error" & tab & (errNum as text) & tab & errMsg
  end try
end run
`;

export type TerminalCollectExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number },
) => Promise<{ stdout?: string | Buffer } | string | Buffer | unknown>;

export interface CollectSessionTerminalMetadataOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  execFile?: TerminalCollectExecFile;
  tmuxTimeoutMs?: number;
  ghosttyTimeoutMs?: number;
  enableFocusedGhosttyCapture?: boolean;
}

export async function collectSessionTerminalMetadata(
  options: CollectSessionTerminalMetadataOptions = {},
): Promise<SessionTerminalMetadata | undefined> {
  const env = options.env ?? process.env;
  const iterm2Terminal = collectIterm2TerminalMetadataFromEnv(env);

  if (hasTmuxEnv(env)) {
    const ghosttyHost = shouldAttemptFocusedGhosttyCapture(env, options)
      ? await collectFocusedGhosttyTerminalMetadata(options)
      : undefined;
    const tmuxCollection = await collectTmuxTerminalMetadataFromEnv(env, options);
    if (tmuxCollection?.terminal === undefined) {
      return iterm2Terminal;
    }
    const tmuxTerminal = tmuxCollection.terminal;

    if (tmuxCollection.activeAttachedPane && ghosttyHost !== undefined) {
      return (
        normalizeSessionTerminalMetadata({ ...tmuxTerminal, host: ghosttyHost }) ?? tmuxTerminal
      );
    }

    return tmuxTerminal;
  }

  if (isGhosttyTermProgram(env)) {
    return shouldAttemptFocusedGhosttyCapture(env, options)
      ? await collectFocusedGhosttyTerminalMetadata(options)
      : undefined;
  }

  return iterm2Terminal;
}

export function collectIterm2TerminalMetadataFromEnv(
  env: NodeJS.ProcessEnv,
): SessionTerminalMetadata | undefined {
  return normalizeSessionTerminalMetadata({
    kind: 'iterm2',
    sessionId: env['ITERM_SESSION_ID'],
    termProgram: env['TERM_PROGRAM'],
    lcTerminal: env['LC_TERMINAL'],
    lcTerminalVersion: env['LC_TERMINAL_VERSION'],
  });
}

interface TmuxTerminalCollection {
  terminal?: SessionTmuxTerminalMetadata;
  activeAttachedPane: boolean;
}

async function collectTmuxTerminalMetadataFromEnv(
  env: NodeJS.ProcessEnv,
  options: CollectSessionTerminalMetadataOptions,
): Promise<TmuxTerminalCollection | undefined> {
  const targetPane = trimNonEmpty(env['TMUX_PANE']);
  const envSocketPath = parseTmuxSocketPath(env['TMUX']);
  if (targetPane === undefined || envSocketPath === undefined) {
    return undefined;
  }

  const execFileImpl = options.execFile ?? defaultExecFile;
  const timeout = options.tmuxTimeoutMs ?? DEFAULT_TMUX_TIMEOUT_MS;
  const tmuxPrefix = ['-S', envSocketPath] as const;

  try {
    const paneRows = await execTmux(
      execFileImpl,
      [
        ...tmuxPrefix,
        'list-panes',
        '-a',
        '-F',
        '#{pane_id}\t#{pane_dead}\t#{pane_active}\t#{window_active}\t#{session_attached}',
      ],
      timeout,
    );
    const paneFacts = findTargetPaneFacts(paneRows, targetPane);
    if (paneFacts === undefined || !paneFacts.live) {
      return { activeAttachedPane: false };
    }

    const format = [
      '#{session_name}',
      '#{session_id}',
      '#{window_name}',
      '#{window_id}',
      '#{pane_id}',
      '#{window_index}',
      '#{pane_index}',
      '#{pane_pid}',
      '#{socket_path}',
    ].join(FIELD_SEPARATOR);
    const display = await execTmux(
      execFileImpl,
      [...tmuxPrefix, 'display-message', '-p', '-t', targetPane, format],
      timeout,
    );
    const fields = display.trimEnd().split(FIELD_SEPARATOR);
    const [
      sessionName,
      sessionId,
      windowName,
      windowId,
      paneId,
      windowIndex,
      paneIndex,
      panePid,
      displaySocketPath,
    ] = fields;

    if (trimNonEmpty(paneId) !== targetPane) {
      return { activeAttachedPane: false };
    }

    const terminal = normalizeSessionTerminalMetadata({
      kind: 'tmux',
      socketPath: trimNonEmpty(displaySocketPath) ?? envSocketPath,
      sessionName,
      sessionId,
      windowName,
      windowId,
      paneId,
      windowIndex,
      paneIndex,
      panePid,
    });

    return {
      ...(terminal?.kind === 'tmux' ? { terminal } : {}),
      activeAttachedPane: paneFacts.activeAttached,
    };
  } catch {
    return { activeAttachedPane: false };
  }
}

async function collectFocusedGhosttyTerminalMetadata(
  options: CollectSessionTerminalMetadataOptions,
): Promise<SessionTerminalMetadata | undefined> {
  const execFileImpl = options.execFile ?? defaultExecFile;
  const timeout = options.ghosttyTimeoutMs ?? DEFAULT_GHOSTTY_TIMEOUT_MS;

  let result: unknown;
  try {
    result = await execFileImpl(OSASCRIPT_COMMAND, ['-e', GHOSTTY_FOCUSED_TERMINAL_SCRIPT], {
      timeout,
    });
  } catch {
    return undefined;
  }

  const output = parseExecFileStdout(result).trimEnd();
  if (output.length === 0 || /\r|\n/u.test(output)) {
    return undefined;
  }

  const [status, appVersion, terminalId, ...extraFields] = output.split('\t');
  if (
    status !== 'ok' ||
    appVersion === undefined ||
    terminalId === undefined ||
    extraFields.length > 0 ||
    !isSupportedGhosttyAppleScriptVersion(appVersion)
  ) {
    return undefined;
  }

  return normalizeSessionTerminalMetadata({
    kind: 'ghostty',
    terminalId: normalizeGhosttyTerminalId(terminalId),
  });
}

async function execTmux(
  execFileImpl: TerminalCollectExecFile,
  args: readonly string[],
  timeout: number,
): Promise<string> {
  const result = await execFileImpl(TMUX_COMMAND, args, { timeout });
  return parseExecFileStdout(result);
}

interface TmuxPaneFacts {
  live: boolean;
  activeAttached: boolean;
}

function findTargetPaneFacts(source: string, targetPane: string): TmuxPaneFacts | undefined {
  for (const line of source.split('\n').map((row) => row.trimEnd())) {
    const [paneId, paneDead, paneActive, windowActive, sessionAttached] = line.split('\t');
    if (paneId !== targetPane) {
      continue;
    }

    const attachedCount = normalizeNonNegativeInteger(sessionAttached);
    const live = paneDead === '0';
    return {
      live,
      activeAttached:
        live &&
        paneActive === '1' &&
        windowActive === '1' &&
        attachedCount !== undefined &&
        attachedCount > 0,
    };
  }

  return undefined;
}

function shouldAttemptFocusedGhosttyCapture(
  env: NodeJS.ProcessEnv,
  options: CollectSessionTerminalMetadataOptions,
): boolean {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin' || options.enableFocusedGhosttyCapture === false) {
    return false;
  }

  return isGhosttyTermProgram(env);
}

function isGhosttyTermProgram(env: NodeJS.ProcessEnv): boolean {
  return trimNonEmpty(env['TERM_PROGRAM'])?.toLowerCase() === 'ghostty';
}

function hasTmuxEnv(env: NodeJS.ProcessEnv): boolean {
  return (
    trimNonEmpty(env['TMUX_PANE']) !== undefined && parseTmuxSocketPath(env['TMUX']) !== undefined
  );
}

function parseTmuxSocketPath(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  return trimNonEmpty(value.split(',')[0]);
}

function isSupportedGhosttyAppleScriptVersion(version: string): boolean {
  const match = /^\s*(\d+)\.(\d+)(?:\.(\d+))?/u.exec(version);
  if (match === null) {
    return false;
  }

  const major = Number.parseInt(match[1]!, 10);
  const minor = Number.parseInt(match[2]!, 10);
  return (
    major > MIN_GHOSTTY_APPLESCRIPT_VERSION.major ||
    (major === MIN_GHOSTTY_APPLESCRIPT_VERSION.major &&
      minor >= MIN_GHOSTTY_APPLESCRIPT_VERSION.minor)
  );
}

function parseExecFileStdout(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }

  if (Buffer.isBuffer(result)) {
    return result.toString('utf8');
  }

  if (isObject(result)) {
    const stdout = result['stdout'];
    if (typeof stdout === 'string') {
      return stdout;
    }
    if (Buffer.isBuffer(stdout)) {
      return stdout.toString('utf8');
    }
  }

  return '';
}

function normalizeNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function trimNonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const defaultExecFile: TerminalCollectExecFile = async (file, args, options) => {
  const result = await execFile(file, [...args], options);
  return result as { stdout?: string | Buffer };
};

function isObject(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null;
}
