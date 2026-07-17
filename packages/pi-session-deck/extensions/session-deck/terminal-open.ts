import { execFile as execFileCallback } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import {
  buildTmuxAttachSessionArgv,
  buildTmuxHasSessionArgv,
  formatPosixCommand,
  type TerminalFocusTarget,
} from './identity/terminal-focus.js';
import {
  openWithIterm2Runtime,
  type Iterm2RuntimeOpenRequest,
  type Iterm2RuntimeOpenResult,
} from './iterm2-runtime-client.js';

const OPEN_COMMAND = '/usr/bin/open';
const OSASCRIPT_COMMAND = '/usr/bin/osascript';
const WHICH_COMMAND = '/usr/bin/which';
const DEFAULT_TMUX_PREFLIGHT_TIMEOUT_MS = 500;
const DEFAULT_GHOSTTY_FOCUS_TIMEOUT_MS = 3000;
const TERMINAL_BRIDGE_ENV = 'PI_SESSION_DECK_TERMINAL_BRIDGE';
const execFile = promisify(execFileCallback);

const GHOSTTY_FOCUS_SCRIPT = `
on run argv
  set targetId to item 1 of argv
  if application "Ghostty" is not running then return "missing" & tab & "Ghostty is not running"
  try
    tell application "Ghostty"
      set targetTerminal to terminal id targetId
    end tell
  on error errMsg number errNum
    if errNum is -1728 then return "missing" & tab & errMsg
    return "error" & tab & (errNum as text) & tab & errMsg
  end try
  try
    tell application "Ghostty"
      focus targetTerminal
    end tell
    return "requested"
  on error errMsg number errNum
    return "focus-error" & tab & (errNum as text) & tab & errMsg
  end try
end run
`;

export type TerminalBridgeMode = 'auto' | 'iterm2-python' | 'iterm2-applescript' | 'none';

export type TerminalOpenFailureReason =
  | 'unsupported-platform'
  | 'tmux-target-missing'
  | 'tmux-preflight-failed'
  | 'python-bridge-disabled'
  | 'python-bridge-unavailable'
  | 'automation-denied'
  | 'terminal-api-unavailable'
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

interface TerminalOpenExecOptions {
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}

export type TerminalOpenExecFile = (
  file: string,
  args: readonly string[],
  options?: TerminalOpenExecOptions,
) => Promise<unknown>;

export type TerminalRevealExecFile = TerminalOpenExecFile;

export type TerminalIterm2RuntimeClient = (
  request: Iterm2RuntimeOpenRequest,
) => Promise<Iterm2RuntimeOpenResult>;

export interface TerminalOpenOptions {
  platform?: NodeJS.Platform;
  execFile?: TerminalOpenExecFile;
  env?: NodeJS.ProcessEnv;
  bridgeMode?: TerminalBridgeMode;
  iterm2RuntimeClient?: TerminalIterm2RuntimeClient;
  pythonBridgeClient?: TerminalIterm2RuntimeClient;
  tmuxPreflightTimeoutMs?: number;
  ghosttyFocusTimeoutMs?: number;
}

export type TerminalRevealOpenOptions = TerminalOpenOptions;

export async function openTerminalFocusTarget(
  target: TerminalFocusTarget,
  options: TerminalOpenOptions = {},
): Promise<TerminalOpenResult> {
  switch (target.kind) {
    case 'iterm2-session':
      return openIterm2SessionTarget(target, options);
    case 'ghostty-terminal':
      return openGhosttyTerminalTarget(target, options);
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
    const runtimeResult = await openIterm2SessionWithRuntime(target.itermSessionId, options);
    if (runtimeResult.ok || mode === 'iterm2-python') {
      return runtimeResult;
    }

    if (
      runtimeResult.reason !== 'python-bridge-unavailable' ||
      runtimeResult.requestSent !== false
    ) {
      return runtimeResult;
    }
  }

  return openTerminalRevealUrl(target.revealUrl, options);
}

async function openGhosttyTerminalTarget(
  target: Extract<TerminalFocusTarget, { kind: 'ghostty-terminal' }>,
  options: TerminalOpenOptions,
): Promise<TerminalOpenResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    return {
      ok: false,
      reason: 'unsupported-platform',
      message: 'Ghostty focus requests are only supported on macOS.',
    };
  }

  const execFileImpl = options.execFile ?? defaultExecFile;
  const execOptions = {
    timeout: options.ghosttyFocusTimeoutMs ?? DEFAULT_GHOSTTY_FOCUS_TIMEOUT_MS,
    ...(options.env === undefined ? {} : { env: options.env }),
  };

  let result: unknown;
  try {
    result = await execFileImpl(
      OSASCRIPT_COMMAND,
      ['-e', GHOSTTY_FOCUS_SCRIPT, target.terminalId],
      execOptions,
    );
  } catch (error) {
    return classifyGhosttyOpenFailure('', getErrorMessage(error));
  }

  return parseGhosttyFocusResult(result);
}

async function openTmuxTerminalTarget(
  target: Extract<TerminalFocusTarget, { kind: 'tmux-session' }>,
  options: TerminalOpenOptions,
): Promise<TerminalOpenResult> {
  if (target.host !== undefined) {
    const hostResult = await openGhosttyTerminalTarget(target.host, options);
    if (hostResult.ok) {
      return hostResult;
    }
    if (hostResult.reason !== 'terminal-target-missing') {
      return hostResult;
    }
  }

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
    const runtimeResult = await openWithIterm2RuntimeClient(tmuxAttachArgv, options);
    if (runtimeResult.ok || mode === 'iterm2-python') {
      return runtimeResult;
    }

    if (
      runtimeResult.reason !== 'python-bridge-unavailable' ||
      runtimeResult.requestSent !== false
    ) {
      return runtimeResult;
    }
  }

  const appleScriptCommand = await buildAppleScriptTmuxAttachCommand(tmuxAttachArgv, options);
  if (!appleScriptCommand.ok) {
    return appleScriptCommand.result;
  }

  return openWithAppleScript(appleScriptCommand.attachCommand, options);
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
      ...(options.env === undefined ? {} : { env: options.env }),
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

async function openIterm2SessionWithRuntime(
  itermSessionId: string,
  options: TerminalOpenOptions,
): Promise<TerminalOpenResult> {
  const runtimeClient = getIterm2RuntimeClient(options);
  return runtimeClient({ itermSessionId });
}

async function openWithIterm2RuntimeClient(
  tmuxAttachArgv: readonly string[],
  options: TerminalOpenOptions,
): Promise<TerminalOpenResult> {
  const runtimeClient = getIterm2RuntimeClient(options);
  return runtimeClient({ tmuxAttachArgv });
}

function getIterm2RuntimeClient(options: TerminalOpenOptions): TerminalIterm2RuntimeClient {
  return (
    options.iterm2RuntimeClient ??
    options.pythonBridgeClient ??
    ((request: Iterm2RuntimeOpenRequest) =>
      openWithIterm2Runtime(request, {
        ...(options.env === undefined ? {} : { env: options.env }),
      }))
  );
}

async function buildAppleScriptTmuxAttachCommand(
  tmuxAttachArgv: readonly string[],
  options: TerminalOpenOptions,
): Promise<{ ok: true; attachCommand: string } | { ok: false; result: TerminalOpenResult }> {
  if (tmuxAttachArgv[0] !== 'tmux') {
    return {
      ok: false,
      result: {
        ok: false,
        reason: 'open-failed',
        message: 'Refusing to open an invalid tmux attach command.',
      },
    };
  }

  const execFileImpl = options.execFile ?? defaultExecFile;
  let resolvedTmuxPath: string | null;
  try {
    const whichResult = await execFileImpl(
      WHICH_COMMAND,
      ['tmux'],
      options.env === undefined ? undefined : { env: options.env },
    );
    resolvedTmuxPath = parseResolvedExecutablePath(whichResult);
  } catch (error) {
    return {
      ok: false,
      result: {
        ok: false,
        reason: 'open-failed',
        message: `Failed to resolve tmux for iTerm2 tab creation: ${getErrorMessage(error)}`,
      },
    };
  }

  if (resolvedTmuxPath === null) {
    return {
      ok: false,
      result: {
        ok: false,
        reason: 'open-failed',
        message:
          'Failed to resolve tmux for iTerm2 tab creation: /usr/bin/which did not return an absolute path.',
      },
    };
  }

  return {
    ok: true,
    attachCommand: formatPosixCommand([resolvedTmuxPath, ...tmuxAttachArgv.slice(1)]),
  };
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

function parseGhosttyFocusResult(result: unknown): TerminalOpenResult {
  const output = parseExecFileStdout(result).trimEnd();
  if (output === 'requested') {
    return {
      ok: true,
      reason: 'requested',
      message: 'Requested Ghostty focus for selected session.',
    };
  }

  if (output.length === 0 || /\r|\n/u.test(output)) {
    return {
      ok: false,
      reason: 'open-failed',
      message: 'Failed to request Ghostty focus: terminal app returned an invalid response.',
    };
  }

  const [status, code, ...messageParts] = output.split('\t');
  const message = messageParts.join('\t');
  if (status === 'missing') {
    return {
      ok: false,
      reason: 'terminal-target-missing',
      message: 'The terminal target is no longer available.',
    };
  }

  if (
    (status !== 'error' && status !== 'focus-error') ||
    code === undefined ||
    message.length === 0
  ) {
    return {
      ok: false,
      reason: 'open-failed',
      message: 'Failed to request Ghostty focus: terminal app returned an invalid response.',
    };
  }

  return classifyGhosttyOpenFailure(code, message);
}

function classifyGhosttyOpenFailure(code: string, message: string): TerminalOpenResult {
  const safeMessage = redactUuid(message);
  if (code === '-1743' || looksLikeAutomationDenied(safeMessage)) {
    return {
      ok: false,
      reason: 'automation-denied',
      message: `Terminal automation is not authorized: ${safeMessage}`,
    };
  }

  if (code === '-1708' || looksLikeTerminalApiUnavailable(safeMessage)) {
    return {
      ok: false,
      reason: 'terminal-api-unavailable',
      message: `Terminal app scripting is unavailable: ${safeMessage}`,
    };
  }

  return {
    ok: false,
    reason: 'open-failed',
    message:
      safeMessage.length === 0
        ? 'Failed to request Ghostty focus.'
        : `Failed to request Ghostty focus: ${safeMessage}`,
  };
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

const defaultExecFile: TerminalOpenExecFile = (file, args, options) =>
  execFile(file, [...args], options);

function isNonZeroExit(error: unknown): boolean {
  return isObject(error) && typeof error['code'] === 'number';
}

function parseResolvedExecutablePath(result: unknown): string | null {
  if (!isObject(result)) {
    return null;
  }

  const stdout = result['stdout'];
  const renderedStdout =
    typeof stdout === 'string' ? stdout : Buffer.isBuffer(stdout) ? stdout.toString('utf8') : null;
  if (renderedStdout === null) {
    return null;
  }

  for (const line of renderedStdout.split(/\r?\n/u)) {
    const trimmedLine = trimNonEmpty(line);
    if (trimmedLine === undefined) {
      continue;
    }

    return isAbsolute(trimmedLine) ? trimmedLine : null;
  }

  return null;
}

function looksLikeAutomationDenied(message: string): boolean {
  return /not authorized|not permitted|automation|privilege/i.test(message);
}

function looksLikeTerminalApiUnavailable(message: string): boolean {
  return /doesn.?t understand|does not understand|not scriptable|scripting (?:is )?unavailable|dictionary|AppleScript (?:is )?(?:not enabled|disabled)|macos-applescript|syntax error/i.test(
    message,
  );
}

function redactUuid(message: string): string {
  return message.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu,
    '[terminal id]',
  );
}

function trimNonEmpty(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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
