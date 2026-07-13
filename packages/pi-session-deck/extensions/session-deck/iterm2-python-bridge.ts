import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_BRIDGE_TIMEOUT_MS = 400;
const BRIDGE_SOCKET_ENV = 'PI_SESSION_DECK_ITERM2_BRIDGE_SOCKET';

export type Iterm2PythonBridgeOpenResult =
  | { ok: true; reason: 'requested'; message: string }
  | {
      ok: false;
      reason: 'python-bridge-unavailable' | 'automation-denied' | 'open-failed';
      message: string;
    };

export interface Iterm2PythonBridgeOpenRequest {
  attachCommand: string;
}

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
  if (!isTmuxAttachCommand(request.attachCommand)) {
    return {
      ok: false,
      reason: 'open-failed',
      message: 'Refusing to send a non-tmux attach command to the iTerm2 bridge.',
    };
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
      });
      return;
    }

    let settled = false;
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
      });
    }, timeoutMs);

    socket.setEncoding?.('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ command: request.attachCommand })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }
      const line = buffer.slice(0, newlineIndex);
      finish(parseBridgeResponse(line));
    });
    socket.on('error', (error) => {
      finish({
        ok: false,
        reason: 'python-bridge-unavailable',
        message: `iTerm2 Python bridge is unavailable: ${getErrorMessage(error)}`,
      });
    });
    socket.on('close', () => {
      finish({
        ok: false,
        reason: 'python-bridge-unavailable',
        message: 'iTerm2 Python bridge closed before returning a response.',
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

function parseBridgeResponse(line: string): Iterm2PythonBridgeOpenResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch (error) {
    return {
      ok: false,
      reason: 'open-failed',
      message: `iTerm2 Python bridge returned malformed JSON: ${getErrorMessage(error)}`,
    };
  }

  if (!isObject(parsed)) {
    return {
      ok: false,
      reason: 'open-failed',
      message: 'iTerm2 Python bridge returned a malformed response.',
    };
  }

  if (parsed['ok'] === true) {
    return {
      ok: true,
      reason: 'requested',
      message: 'Requested tmux attach in a new iTerm2 tab.',
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
  };
}

function normalizeBridgeFailureReason(
  reason: unknown,
): Extract<Iterm2PythonBridgeOpenResult, { ok: false }>['reason'] {
  switch (reason) {
    case 'python-bridge-unavailable':
    case 'automation-denied':
    case 'open-failed':
      return reason;
    default:
      return 'open-failed';
  }
}

function isTmuxAttachCommand(command: string): boolean {
  return command.startsWith('exec tmux ') && command.includes(' attach-session ');
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
