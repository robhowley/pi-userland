import { describe, expect, it, vi } from 'vitest';
import { collectSessionTerminalMetadata } from '../../extensions/session-deck/identity/terminal-collect.js';

const SEP = '\u001f';

function makeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...overrides,
  };
}

describe('collectSessionTerminalMetadata', () => {
  it('validates the exact live tmux pane and prefers tmux over iTerm2 metadata', async () => {
    const execFile = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args.includes('list-panes')) {
        return { stdout: `%11\t0\n%12\t0\n%13\t1\n` };
      }
      if (args.includes('display-message')) {
        return {
          stdout: [
            'prod session',
            '$1',
            'editor',
            '@2',
            '%12',
            '3',
            '4',
            '12345',
            '/tmp/tmux socket/default',
          ].join(SEP),
        };
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
      ['-S', '/tmp/tmux socket/default', 'list-panes', '-a', '-F', '#{pane_id}\t#{pane_dead}'],
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

  it.each([
    ['missing TMUX', { TMUX: undefined, TMUX_PANE: '%12' }, []],
    ['missing TMUX_PANE', { TMUX: '/tmp/tmux/default,123,0', TMUX_PANE: undefined }, []],
  ] as const)('falls back to iTerm2 when tmux env is %s', async (_name, envOverrides, _calls) => {
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
    const execFile = vi.fn(async () => ({ stdout: `%11\t0\n%12\t1\n` }));

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
        return { stdout: `%12\t0\n` };
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
