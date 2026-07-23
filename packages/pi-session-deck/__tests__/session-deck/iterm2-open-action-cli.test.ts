import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  OPEN_TERMINAL_ACTION_BRIDGE_SOCKET_ENV,
  createOpenTerminalActionOpener,
  normalizeOpenTerminalActionRequest,
  runOpenTerminalAction,
  toBrowserSafeOpenTerminalActionResult,
  type OpenTerminalActionFailureReason,
} from '../../extensions/session-deck/iterm2/open-action-cli.js';
import type { SessionDeckOpenSelectedResult } from '../../extensions/session-deck/identity/open.js';

const SENSITIVE_STRINGS = [
  '/tmp/session-deck/private.sock',
  '/tmp/tmux socket/default',
  'prod-secret',
  'iterm2:///reveal?sessionid=w0t0p0%3Asecret',
  "exec tmux -S '/tmp/tmux socket/default' attach-session -E -t prod-secret",
  '/Users/example/.pi/session-deck/iterm2/install.json',
  '/package/dist/extensions/session-deck/iterm2/open-action-cli.js',
  'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
];

async function withRuntimeServer(
  handleLine: (line: string, socket: net.Socket) => void | Promise<void>,
  run: (fixture: { socketPath: string; requests: string[] }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'session-deck-open-action-'));
  const socketPath = join(directory, 'runtime.sock');
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
    await rm(directory, { recursive: true, force: true });
  }
}

function failureResult(reason: OpenTerminalActionFailureReason): SessionDeckOpenSelectedResult {
  return {
    ok: false,
    reason,
    message: `raw ${SENSITIVE_STRINGS.join(' ')}`,
    requestSent: true,
  } as SessionDeckOpenSelectedResult;
}

describe('open-terminal action helper request boundary', () => {
  it('accepts exact runtimeId payloads and rejects extra or unsafe fields', () => {
    expect(normalizeOpenTerminalActionRequest({ runtimeId: 'rt-123_ABC.def' })).toEqual({
      ok: true,
      request: { runtimeId: 'rt-123_ABC.def' },
    });

    for (const invalid of [
      null,
      [],
      {},
      { runtimeId: '' },
      { runtimeId: ' rt-1' },
      { runtimeId: 'rt 1' },
      { runtimeId: 'rt/1' },
      { runtimeId: 'rt\\1' },
      { runtimeId: 'rt\u00001' },
      { runtimeId: '.' },
      { runtimeId: '..' },
      { runtimeId: 'a'.repeat(257) },
      { runtimeId: 123 },
      { runtimeId: 'rt-1', extra: true },
      { runtimeId: 'rt-1', socketPath: '/tmp/private.sock' },
      { runtimeId: 'rt-1', terminalId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
      {
        runtimeId: 'rt-1',
        terminal: { host: { terminalId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' } },
      },
      { runtimeId: 'rt-1', terminal: { tmuxAttachArgv: ['tmux'] } },
      { runtimeId: 'rt-1', revealUrl: 'iterm2:///reveal?sessionid=secret' },
      { runtimeId: 'rt-1', attachCommand: 'exec tmux attach-session -t prod' },
      { runtimeId: 'rt-1', shell: '/bin/zsh' },
    ]) {
      expect(normalizeOpenTerminalActionRequest(invalid).ok).toBe(false);
    }
  });

  it('calls the opener with runtimeId only and maps success to a browser-safe request result', async () => {
    const opener = vi.fn(async (_runtimeId: string) => ({
      ok: true as const,
      reason: 'requested' as const,
      message: `raw success ${SENSITIVE_STRINGS.join(' ')}`,
    }));

    const result = await runOpenTerminalAction({ runtimeId: 'rt-1' }, opener);

    expect(opener).toHaveBeenCalledWith('rt-1');
    expect(opener.mock.calls[0]).toEqual(['rt-1']);
    expect(result).toEqual({
      ok: true,
      status: 'requested',
      message: 'Terminal open requested.',
    });
    for (const secret of SENSITIVE_STRINGS) {
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  it('maps lookup/open failures to safe copy without leaking raw opener messages', () => {
    const reasons: OpenTerminalActionFailureReason[] = [
      'identity-missing',
      'identity-read-error',
      'identity-malformed',
      'runtime-mismatch',
      'terminal-missing',
      'terminal-target-incomplete',
      'unsupported-platform',
      'tmux-target-missing',
      'tmux-preflight-failed',
      'python-bridge-disabled',
      'python-bridge-unavailable',
      'automation-denied',
      'terminal-api-unavailable',
      'terminal-target-missing',
      'open-failed',
    ];

    for (const reason of reasons) {
      const safe = toBrowserSafeOpenTerminalActionResult(failureResult(reason));
      expect(safe.ok).toBe(false);
      expect(safe).toMatchObject({ status: 'failed', reason, requestSent: true });
      expect(safe.message).not.toContain('raw');
      for (const secret of SENSITIVE_STRINGS) {
        expect(JSON.stringify(safe)).not.toContain(secret);
      }
    }
  });

  it('turns unexpected opener exceptions into safe open-failed results', async () => {
    const result = await runOpenTerminalAction({ runtimeId: 'rt-1' }, async () => {
      throw new Error(`boom ${SENSITIVE_STRINGS.join(' ')}`);
    });

    expect(result).toEqual({
      ok: false,
      status: 'failed',
      reason: 'open-failed',
      message: 'Could not request terminal open.',
    });
    for (const secret of SENSITIVE_STRINGS) {
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  it('uses the live bridge socket env for the default opener without exposing it', async () => {
    await withRuntimeServer(
      (line, socket) => {
        socket.end(`${JSON.stringify({ ok: true, message: 'raw runtime success' })}\n`);
        expect(JSON.parse(line)).toEqual({ itermSessionId: 'w0t0p0:abc' });
      },
      async ({ socketPath, requests }) => {
        const identityDirectory = await mkdtemp(join(tmpdir(), 'session-deck-open-identity-'));
        try {
          const runtimeId = 'rt-live-bridge';
          await mkdir(dirname(join(identityDirectory, `${runtimeId}.json`)), { recursive: true });
          await writeFile(
            join(identityDirectory, `${runtimeId}.json`),
            JSON.stringify({
              runtimeId,
              terminal: {
                kind: 'iterm2',
                sessionId: 'w0t0p0:abc',
                revealUrl: 'iterm2:///reveal?sessionid=w0t0p0%3Aabc',
              },
            }),
            'utf8',
          );

          const opener = createOpenTerminalActionOpener(
            { [OPEN_TERMINAL_ACTION_BRIDGE_SOCKET_ENV]: socketPath },
            { identityDirectory, platform: 'darwin' },
          );
          const result = await runOpenTerminalAction({ runtimeId }, opener);

          expect(result).toEqual({
            ok: true,
            status: 'requested',
            message: 'Terminal open requested.',
          });
          expect(requests).toHaveLength(1);
          expect(JSON.stringify(result)).not.toContain(socketPath);
          expect(JSON.stringify(result)).not.toContain('raw runtime success');
        } finally {
          await rm(identityDirectory, { recursive: true, force: true });
        }
      },
    );
  });
});
