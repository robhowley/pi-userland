import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openWithIterm2Runtime } from '../../extensions/session-deck/iterm2-runtime-client.js';

const VALID_TMUX_ATTACH_ARGV = [
  'tmux',
  '-S',
  '/tmp/tmux socket/default',
  'attach-session',
  '-E',
  '-t',
  '$1',
] as const;

interface RuntimeServerFixture {
  socketPath: string;
  requests: string[];
}

function createInstallState(bridgeSocketPath: string): unknown {
  return {
    schemaVersion: 1,
    product: 'pi-session-deck-iterm2',
    packageVersion: '1.2.3',
    installedAt: '2026-07-14T00:00:00.000Z',
    scriptsDir: '/tmp/session-deck-iterm2-scripts',
    script: {
      path: '/tmp/session-deck-iterm2-scripts/AutoLaunch/session_deck_iterm2.py',
      sha256: 'a'.repeat(64),
    },
    runtime: {
      nodeExecutablePath: '/usr/local/bin/node',
      snapshotHelperPath: '/tmp/session-deck-iterm2-snapshot-cli.js',
      webRootPath: '/tmp/session-deck-iterm2-web',
      bridgeSocketPath,
    },
  };
}

async function withRuntimeServer(
  handleLine: (line: string, socket: net.Socket) => void | Promise<void>,
  run: (fixture: RuntimeServerFixture) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-session-deck-runtime-test-'));
  const socketPath = join(dir, 'runtime.sock');
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

describe('openWithIterm2Runtime', () => {
  it('sends exact iTerm2 session id and accepts a success response from the default socket client', async () => {
    let parsedRequest: unknown;

    await withRuntimeServer(
      (line, socket) => {
        parsedRequest = JSON.parse(line) as unknown;
        socket.end(`${JSON.stringify({ ok: true })}\n`);
      },
      async ({ socketPath }) => {
        const result = await openWithIterm2Runtime(
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

  it('uses runtime-provided success messages when present', async () => {
    await withRuntimeServer(
      (_line, socket) => {
        socket.end(`${JSON.stringify({ ok: true, message: 'focused by runtime' })}\n`);
      },
      async ({ socketPath }) => {
        const result = await openWithIterm2Runtime(
          { itermSessionId: 'w0t0p0:abc' },
          { socketPath },
        );

        expect(result).toEqual({
          ok: true,
          reason: 'requested',
          message: 'focused by runtime',
        });
      },
    );
  });

  it('rejects invalid iTerm2 session ids before creating a socket', async () => {
    const createConnection = vi.fn(() => {
      throw new Error('should not connect');
    });

    const result = await openWithIterm2Runtime(
      { itermSessionId: '  ' },
      { socketPath: '/tmp/unused.sock', createConnection },
    );

    expect(result).toEqual({
      ok: false,
      reason: 'open-failed',
      message: 'Refusing to send an invalid iTerm2 session id to the iTerm2 runtime.',
      requestSent: false,
    });
    expect(createConnection).not.toHaveBeenCalled();
  });

  it('sends exact tmux argv and accepts a success response from the default socket client', async () => {
    let parsedRequest: unknown;

    await withRuntimeServer(
      (line, socket) => {
        parsedRequest = JSON.parse(line) as unknown;
        socket.end(`${JSON.stringify({ ok: true })}\n`);
      },
      async ({ socketPath }) => {
        const result = await openWithIterm2Runtime(
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

  it('returns runtime failure responses as post-send failures', async () => {
    await withRuntimeServer(
      (_line, socket) => {
        socket.end(
          `${JSON.stringify({ ok: false, reason: 'terminal-target-missing', message: 'missing' })}\n`,
        );
      },
      async ({ socketPath }) => {
        const result = await openWithIterm2Runtime(
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

  it('treats malformed runtime responses as post-send open failures', async () => {
    await withRuntimeServer(
      (_line, socket) => {
        socket.end('not-json\n');
      },
      async ({ socketPath }) => {
        const result = await openWithIterm2Runtime(
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

    const result = await openWithIterm2Runtime(
      {
        tmuxAttachArgv: ['tmux', '-L', 'bad/name', 'attach-session', '-E', '-t', 'prod'],
      },
      { socketPath: '/tmp/unused.sock', createConnection },
    );

    expect(result).toEqual({
      ok: false,
      reason: 'open-failed',
      message: 'Refusing to send an invalid tmux attach argv to the iTerm2 runtime.',
      requestSent: false,
    });
    expect(createConnection).not.toHaveBeenCalled();
  });

  it('resolves the socket from install state runtime.bridgeSocketPath when no direct socket is injected', async () => {
    let parsedRequest: unknown;

    await withRuntimeServer(
      (line, socket) => {
        parsedRequest = JSON.parse(line) as unknown;
        socket.end(`${JSON.stringify({ ok: true })}\n`);
      },
      async ({ socketPath }) => {
        const readInstallState = vi.fn(async () => createInstallState(socketPath));

        const result = await openWithIterm2Runtime(
          { itermSessionId: 'w0t0p0:abc' },
          {
            env: { PI_SESSION_DECK_ITERM2_BRIDGE_SOCKET: '/tmp/wrong-runtime.sock' },
            installStatePath: '/state/install.json',
            readInstallState,
          },
        );

        expect(result).toMatchObject({ ok: true, reason: 'requested' });
        expect(readInstallState).toHaveBeenCalledWith('/state/install.json');
      },
    );

    expect(parsedRequest).toEqual({ itermSessionId: 'w0t0p0:abc' });
  });

  it('does not invent a TMPDIR socket when install state is invalid', async () => {
    const createConnection = vi.fn(() => {
      throw new Error('should not connect');
    });

    const result = await openWithIterm2Runtime(
      { tmuxAttachArgv: VALID_TMUX_ATTACH_ARGV },
      {
        createConnection,
        installStatePath: '/state/install.json',
        readInstallState: async () => ({ schemaVersion: 2, artifacts: {} }),
      },
    );

    expect(result).toEqual({
      ok: false,
      reason: 'python-bridge-unavailable',
      message:
        'iTerm2 runtime install state is invalid at /state/install.json: State has an invalid shape. Run /session-deck iterm2 install.',
      requestSent: false,
    });
    expect(createConnection).not.toHaveBeenCalled();
  });

  it('marks connection failures before connect as fallback-safe', async () => {
    const createConnection = vi.fn(() => {
      throw new Error('socket missing');
    });

    const result = await openWithIterm2Runtime(
      { tmuxAttachArgv: VALID_TMUX_ATTACH_ARGV },
      { socketPath: '/tmp/missing.sock', createConnection },
    );

    expect(result).toEqual({
      ok: false,
      reason: 'python-bridge-unavailable',
      message: 'iTerm2 runtime is unavailable: socket missing',
      requestSent: false,
    });
    expect(createConnection).toHaveBeenCalledWith('/tmp/missing.sock');
  });

  it('marks post-send runtime close as not fallback-safe', async () => {
    await withRuntimeServer(
      (_line, socket) => {
        socket.destroy();
      },
      async ({ socketPath, requests }) => {
        const result = await openWithIterm2Runtime(
          { tmuxAttachArgv: VALID_TMUX_ATTACH_ARGV },
          { socketPath },
        );

        expect(requests).toHaveLength(1);
        expect(result).toEqual({
          ok: false,
          reason: 'python-bridge-unavailable',
          message: 'iTerm2 runtime closed before returning a response.',
          requestSent: true,
        });
      },
    );
  });

  it('marks post-send runtime timeout as not fallback-safe', async () => {
    await withRuntimeServer(
      () => {
        // Keep the socket open until the client timeout fires.
      },
      async ({ socketPath, requests }) => {
        const result = await openWithIterm2Runtime(
          { tmuxAttachArgv: VALID_TMUX_ATTACH_ARGV },
          { socketPath, timeoutMs: 10 },
        );

        expect(requests).toHaveLength(1);
        expect(result).toEqual({
          ok: false,
          reason: 'python-bridge-unavailable',
          message: 'iTerm2 runtime did not respond before the timeout.',
          requestSent: true,
        });
      },
    );
  });
});
