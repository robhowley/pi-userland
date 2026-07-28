import { describe, expect, it, vi } from 'vitest';
import { collectSessionTerminalMetadata } from '../../extensions/session-deck/identity/terminal-collect.js';

const SEP = '\u001f';
const GHOSTTY_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const GHOSTTY_ID_UPPER = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';

function makeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...overrides,
  };
}

function tmuxDisplay(overrides: Record<string, string> = {}): string {
  return [
    overrides['sessionName'] ?? 'prod session',
    overrides['sessionId'] ?? '$1',
    overrides['windowName'] ?? 'editor',
    overrides['windowId'] ?? '@2',
    overrides['paneId'] ?? '%12',
    overrides['windowIndex'] ?? '3',
    overrides['paneIndex'] ?? '4',
    overrides['panePid'] ?? '12345',
    overrides['socketPath'] ?? '/tmp/tmux socket/default',
  ].join(SEP);
}

function ghosttyOk(id = GHOSTTY_ID_UPPER, version = '1.3.1'): string {
  return `ok\t${version}\t${id}\n`;
}

const ghosttySkipCases: Array<{
  name: string;
  platform: NodeJS.Platform;
  stdout: string;
  calls: number;
  termProgram?: string;
  enable?: boolean;
}> = [
  { name: 'non-macOS', platform: 'linux', stdout: ghosttyOk(), calls: 0 },
  {
    name: 'non-Ghostty TERM_PROGRAM',
    platform: 'darwin',
    termProgram: 'iTerm.app',
    stdout: ghosttyOk(),
    calls: 0,
  },
  {
    name: 'headless UI gate',
    platform: 'darwin',
    stdout: ghosttyOk(),
    calls: 0,
    enable: false,
  },
  { name: 'not frontmost', platform: 'darwin', stdout: 'not-frontmost\n', calls: 1 },
  {
    name: 'invalid UUID',
    platform: 'darwin',
    stdout: 'ok\t1.3.1\tnot-a-uuid\n',
    calls: 1,
  },
  {
    name: 'old Ghostty API version',
    platform: 'darwin',
    stdout: `ok\t1.2.3\t${GHOSTTY_ID}\n`,
    calls: 1,
  },
  {
    name: 'script error',
    platform: 'darwin',
    stdout: 'error\t-1708\tdoes not understand\n',
    calls: 1,
  },
];

describe('collectSessionTerminalMetadata', () => {
  it('validates the exact live tmux pane and prefers tmux over iTerm2 metadata', async () => {
    const execFile = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args.includes('list-panes')) {
        return { stdout: `%11\t0\t0\t0\t1\n%12\t0\t1\t1\t1\n%13\t1\t0\t0\t0\n` };
      }
      if (args.includes('display-message')) {
        return { stdout: tmuxDisplay() };
      }
      throw new Error(`unexpected args ${args.join(' ')}`);
    });

    const terminal = await collectSessionTerminalMetadata({
      env: makeEnv({
        TMUX: '/tmp/tmux socket/default,123,0',
        TMUX_PANE: '%12',
        ITERM_SESSION_ID: 'w0t0p0:iterm',
      }),
      execFile,
    });

    expect(terminal).toEqual({
      kind: 'tmux',
      socketPath: '/tmp/tmux socket/default',
      sessionName: 'prod session',
      sessionId: '$1',
      windowName: 'editor',
      windowId: '@2',
      paneId: '%12',
      windowIndex: 3,
      paneIndex: 4,
      panePid: 12345,
    });
    expect(execFile).toHaveBeenNthCalledWith(
      1,
      'tmux',
      [
        '-S',
        '/tmp/tmux socket/default',
        'list-panes',
        '-a',
        '-F',
        '#{pane_id}\t#{pane_dead}\t#{pane_active}\t#{window_active}\t#{session_attached}',
      ],
      { timeout: 500 },
    );
    expect(execFile).toHaveBeenNthCalledWith(
      2,
      'tmux',
      expect.arrayContaining(['display-message', '-p', '-t', '%12']),
      { timeout: 500 },
    );
    expect(JSON.stringify(terminal)).not.toContain('attachCommand');
  });

  it('captures a frontmost focused Ghostty terminal on macOS without persisting extra fields', async () => {
    const execFile = vi.fn(async () => ({ stdout: ghosttyOk() }));

    const terminal = await collectSessionTerminalMetadata({
      env: makeEnv({ TERM_PROGRAM: 'ghostty' }),
      platform: 'darwin',
      execFile,
    });

    expect(terminal).toEqual({ kind: 'ghostty', terminalId: GHOSTTY_ID });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith(
      '/usr/bin/osascript',
      ['-e', expect.stringContaining('focused terminal')],
      { timeout: 1000 },
    );
    expect(JSON.stringify(terminal)).not.toContain('version');
    expect(JSON.stringify(terminal)).not.toContain('window');
  });

  it.each(ghosttySkipCases)('does not persist Ghostty metadata for $name', async (fixture) => {
    const execFile = vi.fn(async () => ({ stdout: fixture.stdout }));

    const terminal = await collectSessionTerminalMetadata({
      env: makeEnv({ TERM_PROGRAM: fixture.termProgram ?? 'ghostty' }),
      platform: fixture.platform,
      execFile,
      ...(fixture.enable === undefined ? {} : { enableFocusedGhosttyCapture: fixture.enable }),
    });

    expect(terminal).toBeUndefined();
    expect(execFile).toHaveBeenCalledTimes(fixture.calls);
  });

  it('swallows Ghostty collection timeouts and falls back closed', async () => {
    const execFile = vi.fn(async () => {
      throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    });

    await expect(
      collectSessionTerminalMetadata({
        env: makeEnv({ TERM_PROGRAM: 'ghostty' }),
        platform: 'darwin',
        execFile,
        ghosttyTimeoutMs: 50,
      }),
    ).resolves.toBeUndefined();
    expect(execFile).toHaveBeenCalledWith('/usr/bin/osascript', expect.any(Array), {
      timeout: 50,
    });
  });

  it.each([
    ['script error', 'error\t-1708\tdoes not understand\n'],
    ['invalid UUID', 'ok\t1.3.1\tnot-a-uuid\n'],
  ] as const)(
    'does not fall back to inherited iTerm2 metadata for Ghostty %s',
    async (_name, stdout) => {
      const execFile = vi.fn(async () => ({ stdout }));

      const terminal = await collectSessionTerminalMetadata({
        env: makeEnv({ TERM_PROGRAM: 'ghostty', ITERM_SESSION_ID: 'w0t0p0:inherited' }),
        platform: 'darwin',
        execFile,
      });

      expect(terminal).toBeUndefined();
      expect(execFile).toHaveBeenCalledTimes(1);
    },
  );

  it('attaches a private Ghostty host only for a live active tmux pane in Ghostty', async () => {
    const execFile = vi.fn(async (file: string, args: readonly string[]) => {
      if (file === '/usr/bin/osascript') {
        return { stdout: ghosttyOk() };
      }
      if (args.includes('list-panes')) {
        return { stdout: `%12\t0\t1\t1\t1\n` };
      }
      if (args.includes('display-message')) {
        return { stdout: tmuxDisplay() };
      }
      throw new Error(`unexpected args ${args.join(' ')}`);
    });

    const terminal = await collectSessionTerminalMetadata({
      env: makeEnv({
        TMUX: '/tmp/tmux socket/default,123,0',
        TMUX_PANE: '%12',
        TERM_PROGRAM: 'ghostty',
      }),
      platform: 'darwin',
      execFile,
    });

    expect(terminal).toEqual({
      kind: 'tmux',
      socketPath: '/tmp/tmux socket/default',
      sessionName: 'prod session',
      sessionId: '$1',
      windowName: 'editor',
      windowId: '@2',
      paneId: '%12',
      windowIndex: 3,
      paneIndex: 4,
      panePid: 12345,
      host: { kind: 'ghostty', terminalId: GHOSTTY_ID },
    });
    expect(execFile).toHaveBeenCalledTimes(3);
    expect(execFile.mock.calls[0]?.[0]).toBe('/usr/bin/osascript');
    expect(execFile.mock.calls[1]?.[0]).toBe('tmux');
    expect(execFile.mock.calls[2]?.[0]).toBe('tmux');
  });

  it.each([
    ['detached session', '%12\t0\t1\t1\t0\n'],
    ['inactive pane', '%12\t0\t0\t1\t1\n'],
    ['inactive window', '%12\t0\t1\t0\t1\n'],
  ])('does not capture a random Ghostty host for %s', async (_name, listPanes) => {
    const execFile = vi.fn(async (file: string, args: readonly string[]) => {
      if (file === '/usr/bin/osascript') {
        return { stdout: ghosttyOk() };
      }
      if (args.includes('list-panes')) {
        return { stdout: listPanes };
      }
      if (args.includes('display-message')) {
        return { stdout: tmuxDisplay() };
      }
      throw new Error(`unexpected args ${args.join(' ')}`);
    });

    const terminal = await collectSessionTerminalMetadata({
      env: makeEnv({
        TMUX: '/tmp/tmux socket/default,123,0',
        TMUX_PANE: '%12',
        TERM_PROGRAM: 'ghostty',
      }),
      platform: 'darwin',
      execFile,
    });

    expect(terminal).toMatchObject({ kind: 'tmux', paneId: '%12' });
    expect(terminal).not.toHaveProperty('host');
    expect(execFile).toHaveBeenCalledTimes(3);
    expect(execFile.mock.calls[0]?.[0]).toBe('/usr/bin/osascript');
    expect(execFile.mock.calls[1]?.[0]).toBe('tmux');
    expect(execFile.mock.calls[2]?.[0]).toBe('tmux');
  });

  it('keeps tmux+iTerm2 behavior as tmux-only metadata', async () => {
    const execFile = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args.includes('list-panes')) {
        return { stdout: `%12\t0\t1\t1\t1\n` };
      }
      if (args.includes('display-message')) {
        return { stdout: tmuxDisplay() };
      }
      throw new Error(`unexpected args ${args.join(' ')}`);
    });

    const terminal = await collectSessionTerminalMetadata({
      env: makeEnv({
        TMUX: '/tmp/tmux socket/default,123,0',
        TMUX_PANE: '%12',
        TERM_PROGRAM: 'iTerm.app',
        ITERM_SESSION_ID: 'w0t0p0:iterm',
      }),
      platform: 'darwin',
      execFile,
    });

    expect(terminal).toMatchObject({ kind: 'tmux', paneId: '%12' });
    expect(terminal).not.toHaveProperty('host');
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['missing TMUX', { TMUX: undefined, TMUX_PANE: '%12' }],
    ['missing TMUX_PANE', { TMUX: '/tmp/tmux/default,123,0', TMUX_PANE: undefined }],
  ] as const)('falls back to iTerm2 when tmux env is %s', async (_name, envOverrides) => {
    const execFile = vi.fn(async () => ({ stdout: '' }));

    const terminal = await collectSessionTerminalMetadata({
      env: makeEnv({
        ...envOverrides,
        ITERM_SESSION_ID: 'w0t0p0:iterm',
      }),
      execFile,
    });

    expect(terminal).toEqual({
      kind: 'iterm2',
      sessionId: 'w0t0p0:iterm',
      revealUrl: 'iterm2:///reveal?sessionid=w0t0p0%3Aiterm',
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('falls back to iTerm2 when the target pane is missing or dead', async () => {
    const execFile = vi.fn(async () => ({ stdout: `%11\t0\t0\t0\t1\n%12\t1\t0\t0\t0\n` }));

    const terminal = await collectSessionTerminalMetadata({
      env: makeEnv({
        TMUX: '/tmp/tmux/default,123,0',
        TMUX_PANE: '%12',
        ITERM_SESSION_ID: 'w0t0p0:iterm',
      }),
      execFile,
    });

    expect(terminal).toEqual({
      kind: 'iterm2',
      sessionId: 'w0t0p0:iterm',
      revealUrl: 'iterm2:///reveal?sessionid=w0t0p0%3Aiterm',
    });
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('falls back to iTerm2 when tmux commands fail or return incomplete facts', async () => {
    const throwingExecFile = vi.fn(async () => {
      throw new Error('stale socket');
    });

    await expect(
      collectSessionTerminalMetadata({
        env: makeEnv({
          TMUX: '/tmp/tmux/default,123,0',
          TMUX_PANE: '%12',
          ITERM_SESSION_ID: 'w0t0p0:iterm',
        }),
        execFile: throwingExecFile,
      }),
    ).resolves.toMatchObject({ kind: 'iterm2' });

    const incompleteExecFile = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args.includes('list-panes')) {
        return { stdout: `%12\t0\t1\t1\t1\n` };
      }
      return { stdout: ['', '$1', 'editor', '@2', '%99', '', '', '', ''].join(SEP) };
    });

    await expect(
      collectSessionTerminalMetadata({
        env: makeEnv({
          TMUX: '/tmp/tmux/default,123,0',
          TMUX_PANE: '%12',
          ITERM_SESSION_ID: 'w0t0p0:iterm',
        }),
        execFile: incompleteExecFile,
      }),
    ).resolves.toMatchObject({ kind: 'iterm2' });
  });

  it('returns undefined when tmux fails and no iTerm2 fallback exists', async () => {
    const terminal = await collectSessionTerminalMetadata({
      env: makeEnv({ TMUX: '/tmp/tmux/default,123,0', TMUX_PANE: '%12' }),
      execFile: vi.fn(async () => {
        throw new Error('stale socket');
      }),
    });

    expect(terminal).toBeUndefined();
  });
});
