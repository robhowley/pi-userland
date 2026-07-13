import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  formatPosixCommand,
  lookupIdentityTerminalFocusTarget,
  quotePosixArg,
} from '../../extensions/session-deck/identity/terminal-focus.js';
import { lookupIdentityTerminalRevealUrl } from '../../extensions/session-deck/identity/terminal-reveal.js';

const IDENTITY_DIRECTORY = '/tmp/pi-session-deck-identity';
const RUNTIME_ID = 'rt-1';
const EXPECTED_PATH = join(IDENTITY_DIRECTORY, `${RUNTIME_ID}.json`);

function buildIdentitySidecar(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runtimeId: RUNTIME_ID,
    terminal: {
      kind: 'iterm2',
      sessionId: 'w0t0p0:abc',
      revealUrl: 'iterm2:///reveal?sessionid=stale',
    },
    ...overrides,
  };
}

function createReadFile(source: string) {
  return vi.fn(async (_filePath: string, _encoding: 'utf8') => source);
}

describe('lookupIdentityTerminalFocusTarget', () => {
  it('returns the normalized iTerm2 focus target from the selected runtime sidecar', async () => {
    const readFile = createReadFile(
      JSON.stringify(
        buildIdentitySidecar({
          terminal: {
            kind: 'iterm2',
            sessionId: '  w0t0p0:abc/def?x=1  ',
            revealUrl: 'iterm2:///reveal?sessionid=stale-url-should-be-ignored',
            termProgram: ' iTerm.app ',
          },
        }),
      ),
    );

    const result = await lookupIdentityTerminalFocusTarget(RUNTIME_ID, {
      identityDirectory: IDENTITY_DIRECTORY,
      readFile,
    });

    expect(readFile).toHaveBeenCalledWith(EXPECTED_PATH, 'utf8');
    expect(result).toEqual({
      ok: true,
      target: {
        kind: 'iterm2-session',
        itermSessionId: 'w0t0p0:abc/def?x=1',
        revealUrl: 'iterm2:///reveal?sessionid=w0t0p0%3Aabc%2Fdef%3Fx%3D1',
      },
    });
  });

  it('returns a bridge-neutral tmux target with a freshly quoted attach command', async () => {
    const result = await lookupIdentityTerminalFocusTarget(RUNTIME_ID, {
      identityDirectory: IDENTITY_DIRECTORY,
      readFile: createReadFile(
        JSON.stringify(
          buildIdentitySidecar({
            terminal: {
              kind: 'tmux',
              socketPath: '/tmp/tmux socket/default',
              socketName: 'ignored-when-socket-path-exists',
              sessionName: 'work; `echo nope`',
              sessionId: '$session 1',
              windowName: 'editor',
              paneId: '%12',
              attachCommand: 'exec pi',
            },
          }),
        ),
      ),
    });

    expect(result).toEqual({
      ok: true,
      target: {
        kind: 'tmux-session',
        socketPath: '/tmp/tmux socket/default',
        sessionName: 'work; `echo nope`',
        attachCommand: "exec tmux -S '/tmp/tmux socket/default' attach-session -E -t '$session 1'",
      },
    });
    expect(JSON.stringify(result)).not.toContain('paneId');
    expect(JSON.stringify(result)).not.toContain('attachCommand":"exec pi');
  });

  it('uses exact session-name attach when tmux session ids are unavailable', async () => {
    const result = await lookupIdentityTerminalFocusTarget(RUNTIME_ID, {
      identityDirectory: IDENTITY_DIRECTORY,
      readFile: createReadFile(
        JSON.stringify(
          buildIdentitySidecar({
            terminal: {
              kind: 'tmux',
              socketName: 'managed',
              sessionName: 'name with spaces',
            },
          }),
        ),
      ),
    });

    expect(result).toEqual({
      ok: true,
      target: {
        kind: 'tmux-session',
        socketName: 'managed',
        sessionName: 'name with spaces',
        attachCommand: "exec tmux -L managed attach-session -E -t '=name with spaces'",
      },
    });
  });

  it('returns identity-missing for a missing sidecar file', async () => {
    const readError = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    const readFile = vi.fn(async (_filePath: string, _encoding: 'utf8') => {
      throw readError;
    });

    const result = await lookupIdentityTerminalFocusTarget(RUNTIME_ID, {
      identityDirectory: IDENTITY_DIRECTORY,
      readFile,
    });

    expect(result).toMatchObject({ ok: false, reason: 'identity-missing' });
  });

  it('returns identity-read-error for non-ENOENT read failures', async () => {
    const readFile = vi.fn(async (_filePath: string, _encoding: 'utf8') => {
      throw new Error('permission denied');
    });

    const result = await lookupIdentityTerminalFocusTarget(RUNTIME_ID, {
      identityDirectory: IDENTITY_DIRECTORY,
      readFile,
    });

    expect(result).toMatchObject({ ok: false, reason: 'identity-read-error' });
  });

  it.each([
    ['invalid JSON', '{not-json'],
    ['non-object JSON', '"not an object"'],
    [
      'missing runtimeId',
      JSON.stringify({ terminal: { kind: 'iterm2', sessionId: 'w0t0p0:abc' } }),
    ],
    [
      'non-string runtimeId',
      JSON.stringify({ runtimeId: 123, terminal: { kind: 'iterm2', sessionId: 'w0t0p0:abc' } }),
    ],
  ] as const)('returns identity-malformed for %s', async (_label, source) => {
    const result = await lookupIdentityTerminalFocusTarget(RUNTIME_ID, {
      identityDirectory: IDENTITY_DIRECTORY,
      readFile: createReadFile(source),
    });

    expect(result).toMatchObject({ ok: false, reason: 'identity-malformed' });
  });

  it('returns runtime-mismatch before trusting terminal metadata', async () => {
    const result = await lookupIdentityTerminalFocusTarget(RUNTIME_ID, {
      identityDirectory: IDENTITY_DIRECTORY,
      readFile: createReadFile(
        JSON.stringify(
          buildIdentitySidecar({
            runtimeId: 'rt-other',
            terminal: { kind: 'tmux', socketPath: '/tmp/tmux/default', sessionName: 'prod' },
          }),
        ),
      ),
    });

    expect(result).toMatchObject({ ok: false, reason: 'runtime-mismatch' });
  });

  it.each([
    ['missing terminal', buildIdentitySidecar({ terminal: undefined })],
    ['non-object terminal', buildIdentitySidecar({ terminal: 'w0t0p0:abc' })],
    [
      'wrong terminal kind',
      buildIdentitySidecar({ terminal: { kind: 'terminal', sessionId: 'abc' } }),
    ],
    [
      'blank terminal session id',
      buildIdentitySidecar({ terminal: { kind: 'iterm2', sessionId: '  ' } }),
    ],
  ] as const)('returns terminal-missing for %s', async (_label, record) => {
    const result = await lookupIdentityTerminalFocusTarget(RUNTIME_ID, {
      identityDirectory: IDENTITY_DIRECTORY,
      readFile: createReadFile(JSON.stringify(record)),
    });

    expect(result).toMatchObject({ ok: false, reason: 'terminal-missing' });
  });

  it.each([
    ['missing sessionName', { kind: 'tmux', socketPath: '/tmp/tmux/default' }],
    ['missing socket selector', { kind: 'tmux', sessionName: 'prod' }],
  ] as const)(
    'returns terminal-target-incomplete for tmux metadata with %s',
    async (_label, terminal) => {
      const result = await lookupIdentityTerminalFocusTarget(RUNTIME_ID, {
        identityDirectory: IDENTITY_DIRECTORY,
        readFile: createReadFile(JSON.stringify(buildIdentitySidecar({ terminal }))),
      });

      expect(result).toMatchObject({ ok: false, reason: 'terminal-target-incomplete' });
    },
  );

  it('quotes POSIX argv values in exactly one place for attach commands', () => {
    expect(quotePosixArg('simple')).toBe('simple');
    expect(quotePosixArg("space quote ' dollar $ semi ; backtick `")).toBe(
      "'space quote '\\'' dollar $ semi ; backtick `'",
    );
    expect(
      formatPosixCommand(['exec', 'tmux', '-S', '/tmp/a b', 'attach-session', '-t', '=semi;`$']),
    ).toBe("exec tmux -S '/tmp/a b' attach-session -t '=semi;`$'");
  });
});

describe('lookupIdentityTerminalRevealUrl compatibility wrapper', () => {
  it('returns the normalized reveal URL for iTerm2 sidecars', async () => {
    const result = await lookupIdentityTerminalRevealUrl(RUNTIME_ID, {
      identityDirectory: IDENTITY_DIRECTORY,
      readFile: createReadFile(
        JSON.stringify(
          buildIdentitySidecar({
            terminal: {
              kind: 'iterm2',
              sessionId: '  w0t0p0:abc  ',
              revealUrl: 'iterm2:///reveal?sessionid=stale',
            },
          }),
        ),
      ),
    });

    expect(result).toEqual({
      ok: true,
      revealUrl: 'iterm2:///reveal?sessionid=w0t0p0%3Aabc',
    });
  });
});
