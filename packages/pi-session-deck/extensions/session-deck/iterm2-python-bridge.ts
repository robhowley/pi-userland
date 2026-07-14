import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_BRIDGE_TIMEOUT_MS = 400;
const BRIDGE_SOCKET_ENV = 'PI_SESSION_DECK_ITERM2_BRIDGE_SOCKET';

export type Iterm2PythonBridgeOpenResult =
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

export type Iterm2PythonBridgeOpenRequest =
  | { tmuxAttachArgv: readonly string[] }
  | { itermSessionId: string };

type BridgeSocket = NodeJS.ReadWriteStream & {
  destroy?: () => void;
  setEncoding?: (encoding: BufferEncoding) => void;
};

export interface Iterm2PythonBridgeClientOptions {
  env?: NodeJS.ProcessEnv;
  socketPath?: string;
  timeoutMs?: number;
  createConnection?: (path: string) => BridgeSocket;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export async function openWithIterm2PythonBridge(
  request: Iterm2PythonBridgeOpenRequest,
  options: Iterm2PythonBridgeClientOptions = {},
): Promise<Iterm2PythonBridgeOpenResult> {
  const validation = validateBridgeOpenRequest(request);
  if (!validation.ok) {
    return validation.result;
  }

  const socketPath = options.socketPath ?? getIterm2PythonBridgeSocketPath(options.env);
  const timeoutMs = options.timeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS;
  const createConnection =
    options.createConnection ?? ((path: string): BridgeSocket => net.createConnection(path));
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;

  return new Promise<Iterm2PythonBridgeOpenResult>((resolve) => {
    let socket: BridgeSocket;
    try {
      socket = createConnection(socketPath);
    } catch (error) {
      resolve({
        ok: false,
        reason: 'python-bridge-unavailable',
        message: `iTerm2 Python bridge is unavailable: ${getErrorMessage(error)}`,
        requestSent: false,
      });
      return;
    }

    let settled = false;
    let requestSent = false;
    let buffer = '';

    const finish = (result: Iterm2PythonBridgeOpenResult) => {
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
        message: 'iTerm2 Python bridge did not respond before the timeout.',
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
          message: `iTerm2 Python bridge could not send the request: ${getErrorMessage(error)}`,
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
      finish(parseBridgeResponse(line, requestSent, validation.successMessage));
    });
    socket.on('error', (error) => {
      finish({
        ok: false,
        reason: 'python-bridge-unavailable',
        message: `iTerm2 Python bridge is unavailable: ${getErrorMessage(error)}`,
        requestSent,
      });
    });
    socket.on('close', () => {
      finish({
        ok: false,
        reason: 'python-bridge-unavailable',
        message: 'iTerm2 Python bridge closed before returning a response.',
        requestSent,
      });
    });
  });
}

export function getIterm2PythonBridgeSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = trimNonEmpty(env[BRIDGE_SOCKET_ENV]);
  if (configured !== undefined) {
    return configured;
  }

  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return join(tmpdir(), `pi-session-deck-${uid}`, 'iterm2-python-bridge.sock');
}

function parseBridgeResponse(
  line: string,
  requestSent: boolean,
  successMessage: string,
): Iterm2PythonBridgeOpenResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch (error) {
    return {
      ok: false,
      reason: 'open-failed',
      message: `iTerm2 Python bridge returned malformed JSON: ${getErrorMessage(error)}`,
      requestSent,
    };
  }

  if (!isObject(parsed)) {
    return {
      ok: false,
      reason: 'open-failed',
      message: 'iTerm2 Python bridge returned a malformed response.',
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

  const reason = normalizeBridgeFailureReason(parsed['reason']);
  return {
    ok: false,
    reason,
    message:
      typeof parsed['message'] === 'string' && parsed['message'].length > 0
        ? parsed['message']
        : 'iTerm2 Python bridge failed to open the tmux attach tab.',
    requestSent,
  };
}

function normalizeBridgeFailureReason(
  reason: unknown,
): Extract<Iterm2PythonBridgeOpenResult, { ok: false }>['reason'] {
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

function validateBridgeOpenRequest(
  request: Iterm2PythonBridgeOpenRequest,
): { ok: true; successMessage: string } | { ok: false; result: Iterm2PythonBridgeOpenResult } {
  if ('tmuxAttachArgv' in request) {
    if (isValidTmuxAttachArgv(request.tmuxAttachArgv)) {
      return { ok: true, successMessage: 'Requested tmux attach in a new iTerm2 tab.' };
    }

    return {
      ok: false,
      result: {
        ok: false,
        reason: 'open-failed',
        message: 'Refusing to send an invalid tmux attach argv to the iTerm2 bridge.',
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
      message: 'Refusing to send an invalid iTerm2 session id to the iTerm2 bridge.',
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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}
