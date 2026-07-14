import net from 'node:net';

export type JsonLineSocketClientSocket = NodeJS.ReadWriteStream & {
  destroy?: () => void;
  setEncoding?: (encoding: BufferEncoding) => void;
};

export type JsonLineSocketRequestResult =
  | { status: 'line'; line: string; requestSent: boolean }
  | { status: 'connect-error'; error: unknown; requestSent: false }
  | { status: 'send-error'; error: unknown; requestSent: false }
  | { status: 'timeout'; requestSent: boolean }
  | { status: 'socket-error'; error: unknown; requestSent: boolean }
  | { status: 'closed'; requestSent: boolean };

export interface JsonLineSocketRequestOptions {
  clearTimeout?: typeof clearTimeout | undefined;
  createConnection?: ((path: string) => JsonLineSocketClientSocket) | undefined;
  setTimeout?: typeof setTimeout | undefined;
  timeoutMs: number;
}

export function sendJsonLineSocketRequest(
  socketPath: string,
  request: unknown,
  options: JsonLineSocketRequestOptions,
): Promise<JsonLineSocketRequestResult> {
  const createConnection =
    options.createConnection ??
    ((path: string): JsonLineSocketClientSocket => net.createConnection(path));
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;

  return new Promise<JsonLineSocketRequestResult>((resolve) => {
    let socket: JsonLineSocketClientSocket;
    try {
      socket = createConnection(socketPath);
    } catch (error) {
      resolve({ status: 'connect-error', error, requestSent: false });
      return;
    }

    let settled = false;
    let requestSent = false;
    let buffer = '';

    const finish = (result: JsonLineSocketRequestResult): void => {
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
      finish({ status: 'timeout', requestSent });
    }, options.timeoutMs);

    socket.setEncoding?.('utf8');
    socket.on('connect', () => {
      try {
        socket.write(`${JSON.stringify(request)}\n`);
        requestSent = true;
      } catch (error) {
        finish({ status: 'send-error', error, requestSent: false });
      }
    });
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }
      finish({ status: 'line', line: buffer.slice(0, newlineIndex), requestSent });
    });
    socket.on('error', (error) => {
      finish({ status: 'socket-error', error, requestSent });
    });
    socket.on('close', () => {
      finish({ status: 'closed', requestSent });
    });
  });
}
