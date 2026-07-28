import { describe, expect, it, vi } from 'vitest';
import {
  openTerminalFocusTarget,
  openTerminalRevealUrl,
} from '../../extensions/session-deck/terminal-open.js';
import type { TerminalFocusTarget } from '../../extensions/session-deck/identity/terminal-focus.js';
import type { Iterm2RuntimeOpenRequest } from '../../extensions/session-deck/iterm2-runtime-client.js';

const REVEAL_URL = 'iterm2:///reveal?sessionid=w0t0p0%3Aabc';
const ITERM_TARGET: TerminalFocusTarget = {
  kind: 'iterm2-session',
  itermSessionId: 'w0t0p0:abc',
  revealUrl: REVEAL_URL,
};
const ABSOLUTE_TMUX_PATH = '/opt/homebrew/bin/tmux';
const TMUX_ATTACH_ARGV = [
  'tmux',
  '-S',
  '/tmp/tmux socket/default',
  'attach-session',
  '-E',
  '-t',
  '$1',
] as const;
const TMUX_ATTACH_COMMAND = `${ABSOLUTE_TMUX_PATH} -S '/tmp/tmux socket/default' attach-session -E -t '$1'`;
const TMUX_TARGET: TerminalFocusTarget = {
  kind: 'tmux-session',
  socketPath: '/tmp/tmux socket/default',
  sessionName: 'prod',
  sessionTarget: '$1',
};
const GHOSTTY_TERMINAL_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const GHOSTTY_TARGET: TerminalFocusTarget = {
  kind: 'ghostty-terminal',
  terminalId: GHOSTTY_TERMINAL_ID,
};
const HOSTED_TMUX_TARGET: TerminalFocusTarget = {
  ...TMUX_TARGET,
  host: GHOSTTY_TARGET,
};

function createTmuxAppleScriptExecFile(resolvedTmuxPath = ABSOLUTE_TMUX_PATH) {
  return vi.fn(async (file: string, _args: readonly string[], _options?: unknown) => ({
    stdout: file === '/usr/bin/which' ? `${resolvedTmuxPath}\n` : '',
    stderr: '',
  }));
}

describe('openTerminalRevealUrl', () => {
  it('uses macOS open with the reveal URL as one argument and no shell', async () => {
    const execFile = vi.fn(async (_file: string, _args: readonly string[], _options?: unknown) => ({
      stdout: '',
      stderr: '',
    }));

    const result = await openTerminalRevealUrl(REVEAL_URL, {
      platform: 'darwin',
      execFile,
    });

    expect(result).toMatchObject({ ok: true, reason: 'requested' });
    expect(result.message).toContain('Requested iTerm2 focus');
    expect(execFile).toHaveBeenCalledTimes(1);
    const [file, args, options] = vi.mocked(execFile).mock.calls[0] ?? [];
    expect(file).toBe('/usr/bin/open');
    expect(args).toEqual([REVEAL_URL]);
    expect((options as { shell?: unknown } | undefined)?.shell).not.toBe(true);
  });

  it('returns unsupported-platform without spawning outside macOS', async () => {
    const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));

    const result = await openTerminalRevealUrl(REVEAL_URL, {
      platform: 'linux',
      execFile,
    });

    expect(result).toMatchObject({ ok: false, reason: 'unsupported-platform' });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('converts open failures into soft open-failed results', async () => {
    const execFile = vi.fn(async () => {
      throw new Error('open rejected the URL');
    });

    const result = await openTerminalRevealUrl(REVEAL_URL, {
      platform: 'darwin',
      execFile,
    });

    expect(execFile).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, reason: 'open-failed' });
    expect(result.message).toContain('open rejected the URL');
  });
});

describe('openTerminalFocusTarget iTerm2 session support', () => {
  it('uses the iTerm2 runtime as the auto-mode primary opener for existing iTerm2 sessions', async () => {
    const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const iterm2RuntimeClient = vi.fn(async (_request: Iterm2RuntimeOpenRequest) => ({
      ok: true as const,
      reason: 'requested' as const,
      message: 'Requested iTerm2 focus for selected session.',
    }));

    const result = await openTerminalFocusTarget(ITERM_TARGET, {
      platform: 'darwin',
      execFile,
      iterm2RuntimeClient,
    });

    expect(result).toEqual({
      ok: true,
      reason: 'requested',
      message: 'Requested iTerm2 focus for selected session.',
    });
    expect(iterm2RuntimeClient).toHaveBeenCalledWith({ itermSessionId: 'w0t0p0:abc' });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('falls back to the reveal URL only when the iTerm2 runtime fails before sending the request', async () => {
    const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const iterm2RuntimeClient = vi.fn(async () => ({
      ok: false as const,
      reason: 'python-bridge-unavailable' as const,
      message: 'socket missing',
      requestSent: false,
    }));

    const result = await openTerminalFocusTarget(ITERM_TARGET, {
      platform: 'darwin',
      execFile,
      iterm2RuntimeClient,
    });

    expect(result).toMatchObject({ ok: true, reason: 'requested' });
    expect(iterm2RuntimeClient).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith('/usr/bin/open', [REVEAL_URL]);
  });

  it('does not fall back to the reveal URL when the iTerm2 runtime may have received the focus request', async () => {
    const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const iterm2RuntimeClient = vi.fn(async () => ({
      ok: false as const,
      reason: 'python-bridge-unavailable' as const,
      message: 'runtime closed after request',
      requestSent: true,
    }));

    const result = await openTerminalFocusTarget(ITERM_TARGET, {
      platform: 'darwin',
      execFile,
      iterm2RuntimeClient,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'python-bridge-unavailable',
      message: 'runtime closed after request',
      requestSent: true,
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('returns runtime target-missing failures without falling back to a blind URL open', async () => {
    const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const iterm2RuntimeClient = vi.fn(async () => ({
      ok: false as const,
      reason: 'terminal-target-missing' as const,
      message: 'iTerm2 session is no longer available.',
      requestSent: true,
    }));

    const result = await openTerminalFocusTarget(ITERM_TARGET, {
      platform: 'darwin',
      execFile,
      iterm2RuntimeClient,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'terminal-target-missing',
      message: 'iTerm2 session is no longer available.',
      requestSent: true,
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('requires the iTerm2 runtime in runtime-required mode for existing iTerm2 sessions', async () => {
    const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const iterm2RuntimeClient = vi.fn(async () => ({
      ok: false as const,
      reason: 'python-bridge-unavailable' as const,
      message: 'socket missing',
      requestSent: false,
    }));

    const result = await openTerminalFocusTarget(ITERM_TARGET, {
      platform: 'darwin',
      bridgeMode: 'iterm2-python',
      execFile,
      iterm2RuntimeClient,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'python-bridge-unavailable',
      message: 'socket missing',
      requestSent: false,
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('returns unsupported-platform for existing iTerm2 sessions before runtime or URL opening', async () => {
    const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const iterm2RuntimeClient = vi.fn(async () => ({
      ok: true as const,
      reason: 'requested' as const,
      message: 'should not be used',
    }));

    const result = await openTerminalFocusTarget(ITERM_TARGET, {
      platform: 'linux',
      execFile,
      iterm2RuntimeClient,
    });

    expect(result).toMatchObject({ ok: false, reason: 'unsupported-platform' });
    expect(iterm2RuntimeClient).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe('openTerminalFocusTarget Ghostty support', () => {
  it('uses osascript with the terminal id as argv and not script source', async () => {
    const execFile = vi.fn(async (_file: string, _args: readonly string[], _options?: unknown) => ({
      stdout: 'requested\n',
      stderr: '',
    }));

    const result = await openTerminalFocusTarget(GHOSTTY_TARGET, {
      platform: 'darwin',
      execFile,
    });

    expect(result).toEqual({
      ok: true,
      reason: 'requested',
      message: 'Requested Ghostty focus for selected session.',
    });
    expect(execFile).toHaveBeenCalledTimes(1);
    const call = vi.mocked(execFile).mock.calls[0];
    expect(call).toBeDefined();
    const [file, args, options] = call!;
    expect(file).toBe('/usr/bin/osascript');
    expect(args).toEqual([
      '-e',
      expect.stringContaining('terminal id targetId'),
      GHOSTTY_TERMINAL_ID,
    ]);
    expect(String(args?.[1] ?? '')).not.toContain(GHOSTTY_TERMINAL_ID);
    expect(String(args?.[1] ?? '')).not.toContain('activate');
    expect(options).toEqual({ timeout: 3000 });
  });

  it('returns unsupported-platform without spawning outside macOS', async () => {
    const execFile = vi.fn(async () => ({ stdout: 'requested\n', stderr: '' }));

    const result = await openTerminalFocusTarget(GHOSTTY_TARGET, {
      platform: 'linux',
      execFile,
    });

    expect(result).toMatchObject({ ok: false, reason: 'unsupported-platform' });
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each([
    [
      'Automation denied',
      'error\t-1743\tNot authorized to send Apple events to Ghostty\n',
      'automation-denied',
    ],
    [
      'API unavailable',
      'error\t-1708\tGhostty doesn’t understand the terminal id message\n',
      'terminal-api-unavailable',
    ],
    [
      'stale target',
      'missing\tCan’t get terminal id aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\n',
      'terminal-target-missing',
    ],
    ['app missing', 'missing\tGhostty is not running\n', 'terminal-target-missing'],
    [
      'post-focus target-looking error',
      'focus-error\t-1728\tCan’t get terminal id aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\n',
      'open-failed',
    ],
    [
      'unknown target-looking error',
      'error\t999\tCan’t get terminal id aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\n',
      'open-failed',
    ],
    ['malformed response', 'ok\n', 'open-failed'],
  ] as const)('maps Ghostty %s to %s', async (_label, stdout, reason) => {
    const execFile = vi.fn(async () => ({ stdout, stderr: '' }));

    const result = await openTerminalFocusTarget(GHOSTTY_TARGET, {
      platform: 'darwin',
      execFile,
    });

    expect(result).toMatchObject({ ok: false, reason });
    expect(JSON.stringify(result)).not.toContain(GHOSTTY_TERMINAL_ID);
  });

  it('maps rejected unknown osascript failures to open-failed without leaking UUIDs', async () => {
    const execFile = vi.fn(async () => {
      throw new Error(`boom ${GHOSTTY_TERMINAL_ID}`);
    });

    const result = await openTerminalFocusTarget(GHOSTTY_TARGET, {
      platform: 'darwin',
      execFile,
      ghosttyFocusTimeoutMs: 42,
    });

    expect(result).toMatchObject({ ok: false, reason: 'open-failed' });
    expect(JSON.stringify(result)).not.toContain(GHOSTTY_TERMINAL_ID);
    expect(execFile).toHaveBeenCalledWith('/usr/bin/osascript', expect.any(Array), {
      timeout: 42,
    });
  });
});

describe('openTerminalFocusTarget tmux support', () => {
  it('preflights tmux and uses the iTerm2 runtime as the auto-mode primary opener', async () => {
    const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const iterm2RuntimeClient = vi.fn(async (_request: Iterm2RuntimeOpenRequest) => ({
      ok: true as const,
      reason: 'requested' as const,
      message: 'Requested tmux attach in a new iTerm2 tab.',
    }));

    const result = await openTerminalFocusTarget(TMUX_TARGET, {
      platform: 'darwin',
      execFile,
      iterm2RuntimeClient,
    });

    expect(result).toEqual({
      ok: true,
      reason: 'requested',
      message: 'Requested tmux attach in a new iTerm2 tab.',
    });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith(
      'tmux',
      ['-S', '/tmp/tmux socket/default', 'has-session', '-t', '$1'],
      { timeout: 500 },
    );
    expect(iterm2RuntimeClient).toHaveBeenCalledWith({ tmuxAttachArgv: TMUX_ATTACH_ARGV });
    expect(Object.keys(iterm2RuntimeClient.mock.calls[0]?.[0] ?? {})).toEqual(['tmuxAttachArgv']);
    expect(JSON.stringify(execFile.mock.calls)).not.toContain('new-session');
  });

  it('focuses a captured Ghostty host before trying tmux attach', async () => {
    const execFile = vi.fn(async (_file: string, _args: readonly string[], _options?: unknown) => ({
      stdout: 'requested\n',
      stderr: '',
    }));
    const iterm2RuntimeClient = vi.fn(async () => ({
      ok: true as const,
      reason: 'requested' as const,
      message: 'should not be used',
    }));

    const result = await openTerminalFocusTarget(HOSTED_TMUX_TARGET, {
      platform: 'darwin',
      execFile,
      iterm2RuntimeClient,
    });

    expect(result).toEqual({
      ok: true,
      reason: 'requested',
      message: 'Requested Ghostty focus for selected session.',
    });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0]?.[0]).toBe('/usr/bin/osascript');
    expect(iterm2RuntimeClient).not.toHaveBeenCalled();
  });

  it('falls back to existing tmux attach only when the captured Ghostty host is stale', async () => {
    const execFile = vi.fn(async (file: string) => {
      if (file === '/usr/bin/osascript') {
        return { stdout: 'missing\tCan’t get terminal id\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const iterm2RuntimeClient = vi.fn(async (_request: Iterm2RuntimeOpenRequest) => ({
      ok: true as const,
      reason: 'requested' as const,
      message: 'Requested tmux attach in a new iTerm2 tab.',
    }));

    const result = await openTerminalFocusTarget(HOSTED_TMUX_TARGET, {
      platform: 'darwin',
      execFile,
      iterm2RuntimeClient,
    });

    expect(result).toEqual({
      ok: true,
      reason: 'requested',
      message: 'Requested tmux attach in a new iTerm2 tab.',
    });
    expect(execFile).toHaveBeenNthCalledWith(
      1,
      '/usr/bin/osascript',
      expect.arrayContaining([GHOSTTY_TERMINAL_ID]),
      { timeout: 3000 },
    );
    expect(execFile).toHaveBeenNthCalledWith(
      2,
      'tmux',
      ['-S', '/tmp/tmux socket/default', 'has-session', '-t', '$1'],
      { timeout: 500 },
    );
    expect(iterm2RuntimeClient).toHaveBeenCalledWith({ tmuxAttachArgv: TMUX_ATTACH_ARGV });
  });

  it.each([
    ['automation denial', 'error\t-1743\tNot authorized to control Ghostty\n', 'automation-denied'],
    [
      'API unavailable',
      'error\t-1708\tGhostty doesn’t understand terminal id\n',
      'terminal-api-unavailable',
    ],
    [
      'post-focus target-looking failure',
      'focus-error\t-1728\tCan’t get terminal id aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\n',
      'open-failed',
    ],
    [
      'unknown target-looking failure',
      'error\t999\tCan’t get terminal id aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\n',
      'open-failed',
    ],
    ['unknown failure', 'not-json\nextra\n', 'open-failed'],
  ] as const)(
    'does not fall back to tmux attach on Ghostty host %s',
    async (_label, stdout, reason) => {
      const execFile = vi.fn(
        async (_file: string, _args: readonly string[], _options?: unknown) => ({
          stdout,
          stderr: '',
        }),
      );
      const iterm2RuntimeClient = vi.fn(async () => ({
        ok: true as const,
        reason: 'requested' as const,
        message: 'should not be used',
      }));

      const result = await openTerminalFocusTarget(HOSTED_TMUX_TARGET, {
        platform: 'darwin',
        execFile,
        iterm2RuntimeClient,
      });

      expect(result).toMatchObject({ ok: false, reason });
      expect(execFile).toHaveBeenCalledTimes(1);
      expect(execFile.mock.calls[0]?.[0]).toBe('/usr/bin/osascript');
      expect(iterm2RuntimeClient).not.toHaveBeenCalled();
    },
  );

  it('uses an exact session-name target for preflight and attach when tmux ids are unavailable', async () => {
    const nameOnlyTarget: TerminalFocusTarget = {
      kind: 'tmux-session',
      socketName: 'managed',
      sessionName: 'name with spaces',
      sessionTarget: '=name with spaces',
    };
    const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const iterm2RuntimeClient = vi.fn(async () => ({
      ok: true as const,
      reason: 'requested' as const,
      message: 'Requested tmux attach in a new iTerm2 tab.',
    }));

    const result = await openTerminalFocusTarget(nameOnlyTarget, {
      platform: 'darwin',
      execFile,
      iterm2RuntimeClient,
    });

    expect(result).toMatchObject({ ok: true, reason: 'requested' });
    expect(execFile).toHaveBeenCalledWith(
      'tmux',
      ['-L', 'managed', 'has-session', '-t', '=name with spaces'],
      { timeout: 500 },
    );
    expect(iterm2RuntimeClient).toHaveBeenCalledWith({
      tmuxAttachArgv: ['tmux', '-L', 'managed', 'attach-session', '-E', '-t', '=name with spaces'],
    });
  });

  it('falls back to AppleScript in auto mode only when the iTerm2 runtime fails before sending the request', async () => {
    const execFile = createTmuxAppleScriptExecFile();
    const iterm2RuntimeClient = vi.fn(async () => ({
      ok: false as const,
      reason: 'python-bridge-unavailable' as const,
      message: 'socket missing',
      requestSent: false,
    }));

    const result = await openTerminalFocusTarget(TMUX_TARGET, {
      platform: 'darwin',
      execFile,
      iterm2RuntimeClient,
    });

    expect(result).toMatchObject({ ok: true, reason: 'requested' });
    expect(execFile).toHaveBeenCalledTimes(3);
    expect(execFile).toHaveBeenNthCalledWith(2, '/usr/bin/which', ['tmux'], undefined);
    expect(execFile).toHaveBeenNthCalledWith(3, '/usr/bin/osascript', [
      '-e',
      expect.stringContaining('create tab with default profile command commandText'),
      TMUX_ATTACH_COMMAND,
    ]);
    expect(JSON.stringify(execFile.mock.calls)).not.toContain('exec pi');
    expect(JSON.stringify(execFile.mock.calls)).not.toContain('new-session');
    expect(JSON.stringify(execFile.mock.calls)).not.toContain('exec tmux');
  });

  it('does not fall back to AppleScript when the iTerm2 runtime may have received the request', async () => {
    const execFile = vi.fn(async (_file: string, _args: readonly string[], _options?: unknown) => ({
      stdout: '',
      stderr: '',
    }));
    const iterm2RuntimeClient = vi.fn(async () => ({
      ok: false as const,
      reason: 'python-bridge-unavailable' as const,
      message: 'runtime closed after request',
      requestSent: true,
    }));

    const result = await openTerminalFocusTarget(TMUX_TARGET, {
      platform: 'darwin',
      execFile,
      iterm2RuntimeClient,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'python-bridge-unavailable',
      message: 'runtime closed after request',
      requestSent: true,
    });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0]?.[0]).toBe('tmux');
  });

  it('does not fall back to AppleScript when iTerm2 runtime request state is unknown', async () => {
    const execFile = vi.fn(async (_file: string, _args: readonly string[], _options?: unknown) => ({
      stdout: '',
      stderr: '',
    }));
    const iterm2RuntimeClient = vi.fn(async () => ({
      ok: false as const,
      reason: 'python-bridge-unavailable' as const,
      message: 'legacy client did not report request state',
    }));

    const result = await openTerminalFocusTarget(TMUX_TARGET, {
      platform: 'darwin',
      execFile,
      iterm2RuntimeClient,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'python-bridge-unavailable',
      message: 'legacy client did not report request state',
    });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0]?.[0]).toBe('tmux');
  });

  it('does not fall back to AppleScript in runtime-required mode', async () => {
    const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const iterm2RuntimeClient = vi.fn(async () => ({
      ok: false as const,
      reason: 'python-bridge-unavailable' as const,
      message: 'socket missing',
      requestSent: false,
    }));

    const result = await openTerminalFocusTarget(TMUX_TARGET, {
      platform: 'darwin',
      bridgeMode: 'iterm2-python',
      execFile,
      iterm2RuntimeClient,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'python-bridge-unavailable',
      message: 'socket missing',
      requestSent: false,
    });
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('uses AppleScript directly only when configured for AppleScript mode', async () => {
    const execFile = createTmuxAppleScriptExecFile();
    const iterm2RuntimeClient = vi.fn(async () => ({
      ok: true as const,
      reason: 'requested' as const,
      message: 'should not be used',
    }));

    const result = await openTerminalFocusTarget(TMUX_TARGET, {
      platform: 'darwin',
      bridgeMode: 'iterm2-applescript',
      execFile,
      iterm2RuntimeClient,
    });

    expect(result).toMatchObject({ ok: true, reason: 'requested' });
    expect(iterm2RuntimeClient).not.toHaveBeenCalled();
    expect(execFile).toHaveBeenCalledTimes(3);
    expect(execFile).toHaveBeenNthCalledWith(2, '/usr/bin/which', ['tmux'], undefined);
    expect(execFile).toHaveBeenNthCalledWith(3, '/usr/bin/osascript', [
      '-e',
      expect.stringContaining('create tab with default profile command commandText'),
      TMUX_ATTACH_COMMAND,
    ]);
  });

  it('passes the caller env through tmux preflight and AppleScript tmux resolution', async () => {
    const env: NodeJS.ProcessEnv = { PATH: '/custom/tmux/bin:/usr/bin' };
    const execFile = createTmuxAppleScriptExecFile();

    const result = await openTerminalFocusTarget(TMUX_TARGET, {
      platform: 'darwin',
      bridgeMode: 'iterm2-applescript',
      env,
      execFile,
    });

    expect(result).toMatchObject({ ok: true, reason: 'requested' });
    expect(execFile).toHaveBeenCalledTimes(3);
    expect(execFile).toHaveBeenNthCalledWith(
      1,
      'tmux',
      ['-S', '/tmp/tmux socket/default', 'has-session', '-t', '$1'],
      { timeout: 500, env },
    );
    expect(execFile).toHaveBeenNthCalledWith(2, '/usr/bin/which', ['tmux'], { env });
    expect((execFile.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env).toBe(env);
    expect((execFile.mock.calls[1]?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env).toBe(env);
  });

  it('returns open-failed without AppleScript UI mutation when /usr/bin/which cannot resolve tmux', async () => {
    const execFile = vi.fn(async (file: string) => {
      if (file === '/usr/bin/which') {
        throw Object.assign(new Error('tmux not found'), { code: 'ENOENT' });
      }

      return { stdout: '', stderr: '' };
    });

    const result = await openTerminalFocusTarget(TMUX_TARGET, {
      platform: 'darwin',
      bridgeMode: 'iterm2-applescript',
      execFile,
    });

    expect(result).toMatchObject({ ok: false, reason: 'open-failed' });
    expect(result.message).toContain(
      'Failed to resolve tmux for iTerm2 tab creation: tmux not found',
    );
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile).toHaveBeenNthCalledWith(2, '/usr/bin/which', ['tmux'], undefined);
    expect(execFile.mock.calls.some(([file]) => file === '/usr/bin/osascript')).toBe(false);
  });

  it('returns open-failed before AppleScript UI mutation when tmux cannot be resolved absolutely', async () => {
    const execFile = createTmuxAppleScriptExecFile('tmux');

    const result = await openTerminalFocusTarget(TMUX_TARGET, {
      platform: 'darwin',
      bridgeMode: 'iterm2-applescript',
      execFile,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'open-failed',
      message:
        'Failed to resolve tmux for iTerm2 tab creation: /usr/bin/which did not return an absolute path.',
    });
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile).toHaveBeenNthCalledWith(2, '/usr/bin/which', ['tmux'], undefined);
  });

  it('returns a disabled soft result when tmux terminal opening is disabled', async () => {
    const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const iterm2RuntimeClient = vi.fn(async () => ({
      ok: true as const,
      reason: 'requested' as const,
      message: 'should not be used',
    }));

    const result = await openTerminalFocusTarget(TMUX_TARGET, {
      platform: 'darwin',
      bridgeMode: 'none',
      execFile,
      iterm2RuntimeClient,
    });

    expect(result).toMatchObject({ ok: false, reason: 'python-bridge-disabled' });
    expect(iterm2RuntimeClient).not.toHaveBeenCalled();
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('rejects incomplete tmux targets before preflight or runtime opening', async () => {
    const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const iterm2RuntimeClient = vi.fn(async () => ({
      ok: true as const,
      reason: 'requested' as const,
      message: 'should not be used',
    }));

    const result = await openTerminalFocusTarget(
      { kind: 'tmux-session', sessionName: 'prod', sessionTarget: '$1' },
      {
        platform: 'darwin',
        execFile,
        iterm2RuntimeClient,
      },
    );

    expect(result).toMatchObject({ ok: false, reason: 'tmux-preflight-failed' });
    expect(execFile).not.toHaveBeenCalled();
    expect(iterm2RuntimeClient).not.toHaveBeenCalled();
  });

  it('returns tmux-target-missing for stale tmux sessions and does not open the runtime', async () => {
    const execFile = vi.fn(async () => {
      throw Object.assign(new Error('no such session'), { code: 1 });
    });
    const iterm2RuntimeClient = vi.fn(async () => ({
      ok: true as const,
      reason: 'requested' as const,
      message: 'should not be used',
    }));

    const result = await openTerminalFocusTarget(TMUX_TARGET, {
      platform: 'darwin',
      execFile,
      iterm2RuntimeClient,
    });

    expect(result).toMatchObject({ ok: false, reason: 'tmux-target-missing' });
    expect(iterm2RuntimeClient).not.toHaveBeenCalled();
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('returns tmux-preflight-failed for tmux spawn failures', async () => {
    const execFile = vi.fn(async () => {
      throw Object.assign(new Error('tmux not found'), { code: 'ENOENT' });
    });

    const result = await openTerminalFocusTarget(TMUX_TARGET, {
      platform: 'darwin',
      execFile,
      iterm2RuntimeClient: vi.fn(),
    });

    expect(result).toMatchObject({ ok: false, reason: 'tmux-preflight-failed' });
  });

  it('returns unsupported-platform without preflighting tmux outside macOS', async () => {
    const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));

    const result = await openTerminalFocusTarget(TMUX_TARGET, {
      platform: 'linux',
      execFile,
    });

    expect(result).toMatchObject({ ok: false, reason: 'unsupported-platform' });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('converts AppleScript automation failures into automation-denied', async () => {
    const execFile = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: `${ABSOLUTE_TMUX_PATH}\n`, stderr: '' })
      .mockRejectedValueOnce(new Error('Not authorized to send Apple events to iTerm2'));

    const result = await openTerminalFocusTarget(TMUX_TARGET, {
      platform: 'darwin',
      bridgeMode: 'iterm2-applescript',
      execFile,
    });

    expect(result).toMatchObject({ ok: false, reason: 'automation-denied' });
  });
});
