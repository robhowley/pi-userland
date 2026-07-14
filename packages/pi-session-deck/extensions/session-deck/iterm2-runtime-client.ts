import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { homedir } from 'node:os';
import { getSessionDeckIterm2StatePath } from './iterm2/paths.js';
import { parseSessionDeckIterm2InstallState } from './iterm2/state.js';

const DEFAULT_RUNTIME_TIMEOUT_MS = 400;

export type Iterm2RuntimeOpenResult =
  | { ok: true; reason: 'requested'; message: string }
  | {
      ok: false;
      reason:
        | 'python-bridge-unavailable'
        | 'automation-denied'
        | 'terminal-target-missing'
        | 'open-failed';
      message: string;
      requestSent?: boolean;
    };

export type Iterm2RuntimeOpenRequest =
  | { tmuxAttachArgv: readonly string[] }
  | { itermSessionId: string };

export type Iterm2RuntimeInstallStateReader = (path: string) => Promise<unknown>;

type RuntimeSocket = NodeJS.ReadWriteStream & {
  destroy?: () => void;
  setEncoding?: (encoding: BufferEncoding) => void;
};

export interface Iterm2RuntimeClientOptions {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  installStatePath?: string;
  readInstallState?: Iterm2RuntimeInstallStateReader;
  socketPath?: string;
  timeoutMs?: number;
  createConnection?: (path: string) => RuntimeSocket;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export async function openWithIterm2Runtime(
  request: Iterm2RuntimeOpenRequest,
  options: Iterm2RuntimeClientOptions = {},
): Promise<Iterm2RuntimeOpenResult> {
  const validation = validateRuntimeOpenRequest(request);
  if (!validation.ok) {
    return validation.result;
  }

  const socketPathResult = await resolveIterm2RuntimeSocketPath(options);
  if (!socketPathResult.ok) {
    return {
      ok: false,
      reason: 'python-bridge-unavailable',
      message: socketPathResult.message,
      requestSent: false,
    };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_RUNTIME_TIMEOUT_MS;
  const createConnection =
    options.createConnection ?? ((path: string): RuntimeSocket => net.createConnection(path));
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;

  return new Promise<Iterm2RuntimeOpenResult>((resolve) => {
    let socket: RuntimeSocket;
    try {
      socket = createConnection(socketPathResult.socketPath);
    } catch (error) {
      resolve({
        ok: false,
        reason: 'python-bridge-unavailable',
        message: `iTerm2 runtime is unavailable: ${getErrorMessage(error)}`,
        requestSent: false,
      });
      return;
    }

    let settled = false;
    let requestSent = false;
    let buffer = '';

    const finish = (result: Iterm2RuntimeOpenResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimer(timeout);
      try {
        socket.end();
      } catch {
        // Best effort cleanup.
      }
      resolve(result);
    };

    const timeout = setTimer(() => {
      try {
        socket.destroy?.();
      } catch {
        // Best effort cleanup.
      }
      finish({
        ok: false,
        reason: 'python-bridge-unavailable',
        message: 'iTerm2 runtime did not respond before the timeout.',
        requestSent,
      });
    }, timeoutMs);

    socket.setEncoding?.('utf8');
    socket.on('connect', () => {
      try {
        socket.write(`${JSON.stringify(request)}\n`);
        requestSent = true;
      } catch (error) {
        finish({
          ok: false,
          reason: 'python-bridge-unavailable',
          message: `iTerm2 runtime could not send the request: ${getErrorMessage(error)}`,
          requestSent: false,
        });
      }
    });
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }
      const line = buffer.slice(0, newlineIndex);
      finish(parseRuntimeResponse(line, requestSent, validation.successMessage));
    });
    socket.on('error', (error) => {
      finish({
        ok: false,
        reason: 'python-bridge-unavailable',
        message: `iTerm2 runtime is unavailable: ${getErrorMessage(error)}`,
        requestSent,
      });
    });
    socket.on('close', () => {
      finish({
        ok: false,
        reason: 'python-bridge-unavailable',
        message: 'iTerm2 runtime closed before returning a response.',
        requestSent,
      });
    });
  });
}

export async function resolveIterm2RuntimeSocketPath(
  options: Iterm2RuntimeClientOptions = {},
): Promise<{ ok: true; socketPath: string } | { ok: false; message: string }> {
  const injectedSocketPath = trimNonEmpty(options.socketPath);
  if (injectedSocketPath !== undefined) {
    return { ok: true, socketPath: injectedSocketPath };
  }

  const installStatePath =
    options.installStatePath ?? getSessionDeckIterm2StatePath(options.homeDirectory ?? homedir());
  return readSocketPathFromInstallState(
    installStatePath,
    options.readInstallState ?? readJsonInstallState,
  );
}

async function readSocketPathFromInstallState(
  installStatePath: string,
  readInstallState: Iterm2RuntimeInstallStateReader,
): Promise<{ ok: true; socketPath: string } | { ok: false; message: string }> {
  let installState: unknown;
  try {
    installState = await readInstallState(installStatePath);
  } catch (error) {
    if (isMissingError(error)) {
      return {
        ok: false,
        message: `iTerm2 runtime install state was not found at ${installStatePath}. Run /session-deck iterm2 install.`,
      };
    }

    return {
      ok: false,
      message: `Could not read iTerm2 runtime install state at ${installStatePath}: ${getErrorMessage(error)}`,
    };
  }

  try {
    const state = parseSessionDeckIterm2InstallState(installState);
    return { ok: true, socketPath: state.runtime.bridgeSocketPath };
  } catch (error) {
    return {
      ok: false,
      message: `iTerm2 runtime install state is invalid at ${installStatePath}: ${getErrorMessage(error)} Run /session-deck iterm2 install.`,
    };
  }
}

async function readJsonInstallState(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

function parseRuntimeResponse(
  line: string,
  requestSent: boolean,
  successMessage: string,
): Iterm2RuntimeOpenResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch (error) {
    return {
      ok: false,
      reason: 'open-failed',
      message: `iTerm2 runtime returned malformed JSON: ${getErrorMessage(error)}`,
      requestSent,
    };
  }

  if (!isObject(parsed)) {
    return {
      ok: false,
      reason: 'open-failed',
      message: 'iTerm2 runtime returned a malformed response.',
      requestSent,
    };
  }

  if (parsed['ok'] === true) {
    return {
      ok: true,
      reason: 'requested',
      message: typeof parsed['message'] === 'string' ? parsed['message'] : successMessage,
    };
  }

  const reason = normalizeRuntimeFailureReason(parsed['reason']);
  return {
    ok: false,
    reason,
    message:
      typeof parsed['message'] === 'string' && parsed['message'].length > 0
        ? parsed['message']
        : 'iTerm2 runtime failed to open the requested terminal target.',
    requestSent,
  };
}

function normalizeRuntimeFailureReason(
  reason: unknown,
): Extract<Iterm2RuntimeOpenResult, { ok: false }>['reason'] {
  switch (reason) {
    case 'python-bridge-unavailable':
    case 'automation-denied':
    case 'terminal-target-missing':
    case 'open-failed':
      return reason;
    default:
      return 'open-failed';
  }
}

function validateRuntimeOpenRequest(
  request: Iterm2RuntimeOpenRequest,
): { ok: true; successMessage: string } | { ok: false; result: Iterm2RuntimeOpenResult } {
  if ('tmuxAttachArgv' in request) {
    if (isValidTmuxAttachArgv(request.tmuxAttachArgv)) {
      return { ok: true, successMessage: 'Requested tmux attach in a new iTerm2 tab.' };
    }

    return {
      ok: false,
      result: {
        ok: false,
        reason: 'open-failed',
        message: 'Refusing to send an invalid tmux attach argv to the iTerm2 runtime.',
        requestSent: false,
      },
    };
  }

  if (isNonBlankString(request.itermSessionId)) {
    return { ok: true, successMessage: 'Requested iTerm2 focus for selected session.' };
  }

  return {
    ok: false,
    result: {
      ok: false,
      reason: 'open-failed',
      message: 'Refusing to send an invalid iTerm2 session id to the iTerm2 runtime.',
      requestSent: false,
    },
  };
}

function isValidTmuxAttachArgv(argv: unknown): argv is readonly string[] {
  if (!Array.isArray(argv) || argv.length !== 7 || !argv.every(isNonBlankString)) {
    return false;
  }

  const [command, selectorFlag, selectorValue, attachSession, keepEnvironment, targetFlag] =
    argv as [string, string, string, string, string, string, string];
  if (command !== 'tmux') {
    return false;
  }

  if (selectorFlag === '-L' && selectorValue.includes('/')) {
    return false;
  }

  if (selectorFlag !== '-S' && selectorFlag !== '-L') {
    return false;
  }

  return attachSession === 'attach-session' && keepEnvironment === '-E' && targetFlag === '-t';
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function trimNonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isObject(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null;
}

function isMissingError(error: unknown): boolean {
  return isObject(error) && error['code'] === 'ENOENT';
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}
