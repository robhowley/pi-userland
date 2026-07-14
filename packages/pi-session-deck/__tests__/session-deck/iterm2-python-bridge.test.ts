import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openWithIterm2PythonBridge } from '../../extensions/session-deck/iterm2-python-bridge.js';

const VALID_TMUX_ATTACH_ARGV = [
  'tmux',
  '-S',
  '/tmp/tmux socket/default',
  'attach-session',
  '-E',
  '-t',
  '$1',
] as const;

interface BridgeServerFixture {
  socketPath: string;
  requests: string[];
}

async function withBridgeServer(
  handleLine: (line: string, socket: net.Socket) => void | Promise<void>,
  run: (fixture: BridgeServerFixture) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-session-deck-bridge-test-'));
  const socketPath = join(dir, 'bridge.sock');
  const requests: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.on('close', () => sockets.delete(socket));

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }

      const line = buffer.slice(0, newlineIndex);
      requests.push(line);
      void Promise.resolve(handleLine(line, socket)).catch(() => socket.destroy());
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });

    await run({ socketPath, requests });
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await rm(dir, { recursive: true, force: true });
  }
}

describe('openWithIterm2PythonBridge', () => {
  it('sends exact iTerm2 session id and accepts a success response from the default socket client', async () => {
    let parsedRequest: unknown;

    await withBridgeServer(
      (line, socket) => {
        parsedRequest = JSON.parse(line) as unknown;
        socket.end(`${JSON.stringify({ ok: true })}\n`);
      },
      async ({ socketPath }) => {
        const result = await openWithIterm2PythonBridge(
          { itermSessionId: 'w0t0p0:abc' },
          { socketPath },
        );

        expect(result).toEqual({
          ok: true,
          reason: 'requested',
          message: 'Requested iTerm2 focus for selected session.',
        });
      },
    );

    expect(parsedRequest).toEqual({ itermSessionId: 'w0t0p0:abc' });
  });

  it('uses bridge-provided success messages when present', async () => {
    await withBridgeServer(
      (_line, socket) => {
        socket.end(`${JSON.stringify({ ok: true, message: 'focused by bridge' })}\n`);
      },
      async ({ socketPath }) => {
        const result = await openWithIterm2PythonBridge(
          { itermSessionId: 'w0t0p0:abc' },
          { socketPath },
        );

        expect(result).toEqual({
          ok: true,
          reason: 'requested',
          message: 'focused by bridge',
        });
      },
    );
  });

  it('rejects invalid iTerm2 session ids before creating a socket', async () => {
    const createConnection = vi.fn(() => {
      throw new Error('should not connect');
    });

    const result = await openWithIterm2PythonBridge(
      { itermSessionId: '  ' },
      { socketPath: '/tmp/unused.sock', createConnection },
    );

    expect(result).toEqual({
      ok: false,
      reason: 'open-failed',
      message: 'Refusing to send an invalid iTerm2 session id to the iTerm2 bridge.',
      requestSent: false,
    });
    expect(createConnection).not.toHaveBeenCalled();
  });

  it('sends exact tmux argv and accepts a success response from the default socket client', async () => {
    let parsedRequest: unknown;

    await withBridgeServer(
      (line, socket) => {
        parsedRequest = JSON.parse(line) as unknown;
        socket.end(`${JSON.stringify({ ok: true })}\n`);
      },
      async ({ socketPath }) => {
        const result = await openWithIterm2PythonBridge(
          { tmuxAttachArgv: VALID_TMUX_ATTACH_ARGV },
          { socketPath },
        );

        expect(result).toEqual({
          ok: true,
          reason: 'requested',
          message: 'Requested tmux attach in a new iTerm2 tab.',
        });
      },
    );

    expect(parsedRequest).toEqual({ tmuxAttachArgv: VALID_TMUX_ATTACH_ARGV });
  });

  it('returns bridge failure responses as post-send failures', async () => {
    await withBridgeServer(
      (_line, socket) => {
        socket.end(
          `${JSON.stringify({ ok: false, reason: 'terminal-target-missing', message: 'missing' })}\n`,
        );
      },
      async ({ socketPath }) => {
        const result = await openWithIterm2PythonBridge(
          { tmuxAttachArgv: VALID_TMUX_ATTACH_ARGV },
          { socketPath },
        );

        expect(result).toEqual({
          ok: false,
          reason: 'terminal-target-missing',
          message: 'missing',
          requestSent: true,
        });
      },
    );
  });

  it('treats malformed bridge responses as post-send open failures', async () => {
    await withBridgeServer(
      (_line, socket) => {
        socket.end('not-json\n');
      },
      async ({ socketPath }) => {
        const result = await openWithIterm2PythonBridge(
          { tmuxAttachArgv: VALID_TMUX_ATTACH_ARGV },
          { socketPath },
        );

        expect(result).toMatchObject({
          ok: false,
          reason: 'open-failed',
          requestSent: true,
        });
        expect(result.message).toContain('malformed JSON');
      },
    );
  });

  it('rejects invalid tmux argv before creating a socket', async () => {
    const createConnection = vi.fn(() => {
      throw new Error('should not connect');
    });

    const result = await openWithIterm2PythonBridge(
      {
        tmuxAttachArgv: ['tmux', '-L', 'bad/name', 'attach-session', '-E', '-t', 'prod'],
      },
      { socketPath: '/tmp/unused.sock', createConnection },
    );

    expect(result).toEqual({
      ok: false,
      reason: 'open-failed',
      message: 'Refusing to send an invalid tmux attach argv to the iTerm2 bridge.',
      requestSent: false,
    });
    expect(createConnection).not.toHaveBeenCalled();
  });

  it('marks connection failures before connect as fallback-safe', async () => {
    const createConnection = vi.fn(() => {
      throw new Error('socket missing');
    });

    const result = await openWithIterm2PythonBridge(
      { tmuxAttachArgv: VALID_TMUX_ATTACH_ARGV },
      { socketPath: '/tmp/missing.sock', createConnection },
    );

    expect(result).toEqual({
      ok: false,
      reason: 'python-bridge-unavailable',
      message: 'iTerm2 Python bridge is unavailable: socket missing',
      requestSent: false,
    });
    expect(createConnection).toHaveBeenCalledWith('/tmp/missing.sock');
  });

  it('marks post-send bridge close as not fallback-safe', async () => {
    await withBridgeServer(
      (_line, socket) => {
        socket.destroy();
      },
      async ({ socketPath, requests }) => {
        const result = await openWithIterm2PythonBridge(
          { tmuxAttachArgv: VALID_TMUX_ATTACH_ARGV },
          { socketPath },
        );

        expect(requests).toHaveLength(1);
        expect(result).toEqual({
          ok: false,
          reason: 'python-bridge-unavailable',
          message: 'iTerm2 Python bridge closed before returning a response.',
          requestSent: true,
        });
      },
    );
  });

  it('marks post-send bridge timeout as not fallback-safe', async () => {
    await withBridgeServer(
      () => {
        // Keep the socket open until the client timeout fires.
      },
      async ({ socketPath, requests }) => {
        const result = await openWithIterm2PythonBridge(
          { tmuxAttachArgv: VALID_TMUX_ATTACH_ARGV },
          { socketPath, timeoutMs: 10 },
        );

        expect(requests).toHaveLength(1);
        expect(result).toEqual({
          ok: false,
          reason: 'python-bridge-unavailable',
          message: 'iTerm2 Python bridge did not respond before the timeout.',
          requestSent: true,
        });
      },
    );
  });
});
