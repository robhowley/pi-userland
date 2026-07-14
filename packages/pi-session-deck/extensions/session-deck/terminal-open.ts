import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import {
  buildTmuxAttachSessionArgv,
  buildTmuxHasSessionArgv,
  formatPosixCommand,
  type TerminalFocusTarget,
} from './identity/terminal-focus.js';
import {
  openWithIterm2PythonBridge,
  type Iterm2PythonBridgeOpenRequest,
  type Iterm2PythonBridgeOpenResult,
} from './iterm2-python-bridge.js';

const OPEN_COMMAND = '/usr/bin/open';
const OSASCRIPT_COMMAND = '/usr/bin/osascript';
const DEFAULT_TMUX_PREFLIGHT_TIMEOUT_MS = 500;
const TERMINAL_BRIDGE_ENV = 'PI_SESSION_DECK_TERMINAL_BRIDGE';
const execFile = promisify(execFileCallback);

export type TerminalBridgeMode = 'auto' | 'iterm2-python' | 'iterm2-applescript' | 'none';

export type TerminalOpenFailureReason =
  | 'unsupported-platform'
  | 'tmux-target-missing'
  | 'tmux-preflight-failed'
  | 'python-bridge-disabled'
  | 'python-bridge-unavailable'
  | 'automation-denied'
  | 'terminal-target-missing'
  | 'open-failed';

export type TerminalOpenResult =
  | { ok: true; reason: 'requested'; message: string }
  | {
      ok: false;
      reason: TerminalOpenFailureReason;
      message: string;
      requestSent?: boolean;
    };

export type TerminalRevealOpenResult = TerminalOpenResult;

export type TerminalOpenExecFile = (
  file: string,
  args: readonly string[],
  options?: { timeout?: number },
) => Promise<unknown>;

export type TerminalRevealExecFile = TerminalOpenExecFile;

export type TerminalPythonBridgeClient = (
  request: Iterm2PythonBridgeOpenRequest,
) => Promise<Iterm2PythonBridgeOpenResult>;

export interface TerminalOpenOptions {
  platform?: NodeJS.Platform;
  execFile?: TerminalOpenExecFile;
  env?: NodeJS.ProcessEnv;
  bridgeMode?: TerminalBridgeMode;
  pythonBridgeClient?: TerminalPythonBridgeClient;
  tmuxPreflightTimeoutMs?: number;
}

export type TerminalRevealOpenOptions = TerminalOpenOptions;

export async function openTerminalFocusTarget(
  target: TerminalFocusTarget,
  options: TerminalOpenOptions = {},
): Promise<TerminalOpenResult> {
  switch (target.kind) {
    case 'iterm2-session':
      return openIterm2SessionTarget(target, options);
    case 'tmux-session':
      return openTmuxTerminalTarget(target, options);
  }
}

export async function openTerminalRevealUrl(
  revealUrl: string,
  options: TerminalRevealOpenOptions = {},
): Promise<TerminalRevealOpenResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    return {
      ok: false,
      reason: 'unsupported-platform',
      message: 'iTerm2 focus requests are only supported on macOS.',
    };
  }

  const execFileImpl = options.execFile ?? defaultExecFile;
  try {
    await execFileImpl(OPEN_COMMAND, [revealUrl]);
  } catch (error) {
    return {
      ok: false,
      reason: 'open-failed',
      message: `Failed to request iTerm2 focus: ${getErrorMessage(error)}`,
    };
  }

  return {
    ok: true,
    reason: 'requested',
    message: 'Requested iTerm2 focus for selected session.',
  };
}

async function openIterm2SessionTarget(
  target: Extract<TerminalFocusTarget, { kind: 'iterm2-session' }>,
  options: TerminalOpenOptions,
): Promise<TerminalOpenResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    return {
      ok: false,
      reason: 'unsupported-platform',
      message: 'iTerm2 focus requests are only supported on macOS.',
    };
  }

  const mode = resolveBridgeMode(options);
  if (mode === 'auto' || mode === 'iterm2-python') {
    const pythonResult = await openIterm2SessionWithPythonBridge(target.itermSessionId, options);
    if (pythonResult.ok || mode === 'iterm2-python') {
      return pythonResult;
    }

    if (pythonResult.reason !== 'python-bridge-unavailable' || pythonResult.requestSent !== false) {
      return pythonResult;
    }
  }

  return openTerminalRevealUrl(target.revealUrl, options);
}

async function openTmuxTerminalTarget(
  target: Extract<TerminalFocusTarget, { kind: 'tmux-session' }>,
  options: TerminalOpenOptions,
): Promise<TerminalOpenResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    return {
      ok: false,
      reason: 'unsupported-platform',
      message: 'Opening tmux sessions in iTerm2 is only supported on macOS.',
    };
  }

  const tmuxAttachArgv = buildTmuxAttachSessionArgv(target);
  if (tmuxAttachArgv === null) {
    return {
      ok: false,
      reason: 'tmux-preflight-failed',
      message: 'Tmux terminal metadata is incomplete for the selected session.',
    };
  }

  const preflight = await preflightTmuxTarget(target, options);
  if (!preflight.ok) {
    return preflight;
  }

  const mode = resolveBridgeMode(options);
  if (mode === 'none') {
    return {
      ok: false,
      reason: 'python-bridge-disabled',
      message: 'Terminal opening is disabled for tmux sessions.',
    };
  }

  if (mode === 'auto' || mode === 'iterm2-python') {
    const pythonResult = await openWithPythonBridge(tmuxAttachArgv, options);
    if (pythonResult.ok || mode === 'iterm2-python') {
      return pythonResult;
    }

    if (pythonResult.reason !== 'python-bridge-unavailable' || pythonResult.requestSent !== false) {
      return pythonResult;
    }
  }

  return openWithAppleScript(formatPosixCommand(['exec', ...tmuxAttachArgv]), options);
}

async function preflightTmuxTarget(
  target: Extract<TerminalFocusTarget, { kind: 'tmux-session' }>,
  options: TerminalOpenOptions,
): Promise<TerminalOpenResult | { ok: true }> {
  const argv = buildTmuxHasSessionArgv(target);
  if (argv === null) {
    return {
      ok: false,
      reason: 'tmux-preflight-failed',
      message: 'Tmux terminal metadata is incomplete for the selected session.',
    };
  }

  const [file, ...args] = argv;
  const execFileImpl = options.execFile ?? defaultExecFile;
  try {
    await execFileImpl(file!, args, {
      timeout: options.tmuxPreflightTimeoutMs ?? DEFAULT_TMUX_PREFLIGHT_TIMEOUT_MS,
    });
  } catch (error) {
    if (isNonZeroExit(error)) {
      return {
        ok: false,
        reason: 'tmux-target-missing',
        message: `Tmux session "${target.sessionName}" is no longer available.`,
      };
    }

    return {
      ok: false,
      reason: 'tmux-preflight-failed',
      message: `Failed to verify tmux session before opening: ${getErrorMessage(error)}`,
    };
  }

  return { ok: true };
}

async function openIterm2SessionWithPythonBridge(
  itermSessionId: string,
  options: TerminalOpenOptions,
): Promise<TerminalOpenResult> {
  const bridgeClient = getPythonBridgeClient(options);
  return bridgeClient({ itermSessionId });
}

async function openWithPythonBridge(
  tmuxAttachArgv: readonly string[],
  options: TerminalOpenOptions,
): Promise<TerminalOpenResult> {
  const bridgeClient = getPythonBridgeClient(options);
  return bridgeClient({ tmuxAttachArgv });
}

function getPythonBridgeClient(options: TerminalOpenOptions): TerminalPythonBridgeClient {
  return (
    options.pythonBridgeClient ??
    ((request: Iterm2PythonBridgeOpenRequest) =>
      openWithIterm2PythonBridge(request, {
        ...(options.env === undefined ? {} : { env: options.env }),
      }))
  );
}

async function openWithAppleScript(
  attachCommand: string,
  options: TerminalOpenOptions,
): Promise<TerminalOpenResult> {
  const execFileImpl = options.execFile ?? defaultExecFile;
  const script = `
on run argv
  set commandText to item 1 of argv
  tell application "iTerm2"
    activate
    if (count of windows) is 0 then
      create window with default profile command commandText
    else
      tell current window
        create tab with default profile command commandText
      end tell
    end if
  end tell
end run
`;

  try {
    await execFileImpl(OSASCRIPT_COMMAND, ['-e', script, attachCommand]);
  } catch (error) {
    const message = getErrorMessage(error);
    return {
      ok: false,
      reason: looksLikeAutomationDenied(message) ? 'automation-denied' : 'open-failed',
      message: looksLikeAutomationDenied(message)
        ? `iTerm2 automation is not authorized: ${message}`
        : `Failed to request tmux attach tab: ${message}`,
    };
  }

  return {
    ok: true,
    reason: 'requested',
    message: 'Requested tmux attach in a new iTerm2 tab.',
  };
}

function resolveBridgeMode(options: TerminalOpenOptions): TerminalBridgeMode {
  const env = options.env ?? process.env;
  const rawMode = options.bridgeMode ?? env[TERMINAL_BRIDGE_ENV];
  switch (rawMode) {
    case 'iterm2-python':
    case 'iterm2-applescript':
    case 'none':
    case 'auto':
      return rawMode;
    default:
      return 'auto';
  }
}

const defaultExecFile: TerminalOpenExecFile = async (file, args, options) => {
  await execFile(file, [...args], options);
};

function isNonZeroExit(error: unknown): boolean {
  return isObject(error) && typeof error['code'] === 'number';
}

function looksLikeAutomationDenied(message: string): boolean {
  return /not authorized|not permitted|automation|privilege/i.test(message);
}

function isObject(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}
