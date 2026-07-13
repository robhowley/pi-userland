import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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

describe('lookupIdentityTerminalRevealUrl', () => {
  it('returns the normalized reveal URL from the selected runtime sidecar', async () => {
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

    const result = await lookupIdentityTerminalRevealUrl(RUNTIME_ID, {
      identityDirectory: IDENTITY_DIRECTORY,
      readFile,
    });

    expect(readFile).toHaveBeenCalledWith(EXPECTED_PATH, 'utf8');
    expect(result).toMatchObject({
      ok: true,
      revealUrl: 'iterm2:///reveal?sessionid=w0t0p0%3Aabc%2Fdef%3Fx%3D1',
    });
  });

  it('returns identity-missing for a missing sidecar file', async () => {
    const readError = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    const readFile = vi.fn(async (_filePath: string, _encoding: 'utf8') => {
      throw readError;
    });

    const result = await lookupIdentityTerminalRevealUrl(RUNTIME_ID, {
      identityDirectory: IDENTITY_DIRECTORY,
      readFile,
    });

    expect(result).toMatchObject({ ok: false, reason: 'identity-missing' });
  });

  it('returns identity-read-error for non-ENOENT read failures', async () => {
    const readFile = vi.fn(async (_filePath: string, _encoding: 'utf8') => {
      throw new Error('permission denied');
    });

    const result = await lookupIdentityTerminalRevealUrl(RUNTIME_ID, {
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
    const result = await lookupIdentityTerminalRevealUrl(RUNTIME_ID, {
      identityDirectory: IDENTITY_DIRECTORY,
      readFile: createReadFile(source),
    });

    expect(result).toMatchObject({ ok: false, reason: 'identity-malformed' });
  });

  it('returns runtime-mismatch before trusting terminal metadata', async () => {
    const result = await lookupIdentityTerminalRevealUrl(RUNTIME_ID, {
      identityDirectory: IDENTITY_DIRECTORY,
      readFile: createReadFile(
        JSON.stringify(
          buildIdentitySidecar({
            runtimeId: 'rt-other',
            terminal: { kind: 'terminal', sessionId: '' },
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
    const result = await lookupIdentityTerminalRevealUrl(RUNTIME_ID, {
      identityDirectory: IDENTITY_DIRECTORY,
      readFile: createReadFile(JSON.stringify(record)),
    });

    expect(result).toMatchObject({ ok: false, reason: 'terminal-missing' });
  });
});
