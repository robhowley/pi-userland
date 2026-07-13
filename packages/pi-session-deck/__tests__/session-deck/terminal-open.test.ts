import { describe, expect, it, vi } from 'vitest';
import {
  openTerminalFocusTarget,
  openTerminalRevealUrl,
} from '../../extensions/session-deck/terminal-open.js';
import type { TerminalFocusTarget } from '../../extensions/session-deck/identity/terminal-focus.js';

const REVEAL_URL = 'iterm2:///reveal?sessionid=w0t0p0%3Aabc';
const TMUX_TARGET: TerminalFocusTarget = {
  kind: 'tmux-session',
  socketPath: '/tmp/tmux socket/default',
  sessionName: 'prod',
  sessionTarget: '$1',
  attachCommand: "exec tmux -S '/tmp/tmux socket/default' attach-session -E -t '$1'",
};

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

describe('openTerminalFocusTarget tmux support', () => {
  it('preflights tmux and uses the Python bridge as the auto-mode primary opener', async () => {
    const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const pythonBridgeClient = vi.fn(async (_request: { attachCommand: string }) => ({
      ok: true as const,
      reason: 'requested' as const,
      message: 'Requested tmux attach in a new iTerm2 tab.',
    }));

    const result = await openTerminalFocusTarget(TMUX_TARGET, {
      platform: 'darwin',
      execFile,
      pythonBridgeClient,
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
    expect(pythonBridgeClient).toHaveBeenCalledWith({ attachCommand: TMUX_TARGET.attachCommand });
    expect(Object.keys(pythonBridgeClient.mock.calls[0]?.[0] ?? {})).toEqual(['attachCommand']);
    expect(JSON.stringify(execFile.mock.calls)).not.toContain('new-session');
  });

  it('uses an exact session-name target for preflight and attach when tmux ids are unavailable', async () => {
    const nameOnlyTarget: TerminalFocusTarget = {
      kind: 'tmux-session',
      socketName: 'managed',
      sessionName: 'name with spaces',
      sessionTarget: '=name with spaces',
      attachCommand: "exec tmux -L managed attach-session -E -t '=name with spaces'",
    };
    const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const pythonBridgeClient = vi.fn(async () => ({
      ok: true as const,
      reason: 'requested' as const,
      message: 'Requested tmux attach in a new iTerm2 tab.',
    }));

    const result = await openTerminalFocusTarget(nameOnlyTarget, {
      platform: 'darwin',
      execFile,
      pythonBridgeClient,
    });

    expect(result).toMatchObject({ ok: true, reason: 'requested' });
    expect(execFile).toHaveBeenCalledWith(
      'tmux',
      ['-L', 'managed', 'has-session', '-t', '=name with spaces'],
      { timeout: 500 },
    );
    expect(pythonBridgeClient).toHaveBeenCalledWith({
      attachCommand: nameOnlyTarget.attachCommand,
    });
  });

  it('falls back to AppleScript in auto mode only when the Python bridge is unavailable', async () => {
    const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const pythonBridgeClient = vi.fn(async () => ({
      ok: false as const,
      reason: 'python-bridge-unavailable' as const,
      message: 'socket missing',
    }));

    const result = await openTerminalFocusTarget(TMUX_TARGET, {
      platform: 'darwin',
      execFile,
      pythonBridgeClient,
    });

    expect(result).toMatchObject({ ok: true, reason: 'requested' });
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile).toHaveBeenNthCalledWith(2, '/usr/bin/osascript', [
      '-e',
      expect.stringContaining('create tab with default profile command commandText'),
      TMUX_TARGET.attachCommand,
    ]);
    expect(JSON.stringify(execFile.mock.calls)).not.toContain('exec pi');
    expect(JSON.stringify(execFile.mock.calls)).not.toContain('new-session');
  });

  it('does not fall back to AppleScript in Python-required mode', async () => {
    const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const pythonBridgeClient = vi.fn(async () => ({
      ok: false as const,
      reason: 'python-bridge-unavailable' as const,
      message: 'socket missing',
    }));

    const result = await openTerminalFocusTarget(TMUX_TARGET, {
      platform: 'darwin',
      bridgeMode: 'iterm2-python',
      execFile,
      pythonBridgeClient,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'python-bridge-unavailable',
      message: 'socket missing',
    });
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('uses AppleScript directly only when configured for AppleScript mode', async () => {
    const execFile = vi.fn(async (_file: string, _args: readonly string[]) => ({
      stdout: '',
      stderr: '',
    }));
    const pythonBridgeClient = vi.fn(async () => ({
      ok: true as const,
      reason: 'requested' as const,
      message: 'should not be used',
    }));

    const result = await openTerminalFocusTarget(TMUX_TARGET, {
      platform: 'darwin',
      bridgeMode: 'iterm2-applescript',
      execFile,
      pythonBridgeClient,
    });

    expect(result).toMatchObject({ ok: true, reason: 'requested' });
    expect(pythonBridgeClient).not.toHaveBeenCalled();
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile.mock.calls[1]?.[0]).toBe('/usr/bin/osascript');
  });

  it('returns a disabled soft result when tmux terminal opening is disabled', async () => {
    const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const pythonBridgeClient = vi.fn(async () => ({
      ok: true as const,
      reason: 'requested' as const,
      message: 'should not be used',
    }));

    const result = await openTerminalFocusTarget(TMUX_TARGET, {
      platform: 'darwin',
      bridgeMode: 'none',
      execFile,
      pythonBridgeClient,
    });

    expect(result).toMatchObject({ ok: false, reason: 'python-bridge-disabled' });
    expect(pythonBridgeClient).not.toHaveBeenCalled();
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('rejects non-attach tmux commands before preflight or bridge opening', async () => {
    const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const pythonBridgeClient = vi.fn(async () => ({
      ok: true as const,
      reason: 'requested' as const,
      message: 'should not be used',
    }));

    const result = await openTerminalFocusTarget(
      { ...TMUX_TARGET, attachCommand: 'exec tmux new-session -A -s prod' },
      {
        platform: 'darwin',
        execFile,
        pythonBridgeClient,
      },
    );

    expect(result).toMatchObject({ ok: false, reason: 'open-failed' });
    expect(execFile).not.toHaveBeenCalled();
    expect(pythonBridgeClient).not.toHaveBeenCalled();
  });

  it('returns tmux-target-missing for stale tmux sessions and does not open a bridge', async () => {
    const execFile = vi.fn(async () => {
      throw Object.assign(new Error('no such session'), { code: 1 });
    });
    const pythonBridgeClient = vi.fn(async () => ({
      ok: true as const,
      reason: 'requested' as const,
      message: 'should not be used',
    }));

    const result = await openTerminalFocusTarget(TMUX_TARGET, {
      platform: 'darwin',
      execFile,
      pythonBridgeClient,
    });

    expect(result).toMatchObject({ ok: false, reason: 'tmux-target-missing' });
    expect(pythonBridgeClient).not.toHaveBeenCalled();
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('returns tmux-preflight-failed for tmux spawn failures', async () => {
    const execFile = vi.fn(async () => {
      throw Object.assign(new Error('tmux not found'), { code: 'ENOENT' });
    });

    const result = await openTerminalFocusTarget(TMUX_TARGET, {
      platform: 'darwin',
      execFile,
      pythonBridgeClient: vi.fn(),
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
      .mockRejectedValueOnce(new Error('Not authorized to send Apple events to iTerm2'));

    const result = await openTerminalFocusTarget(TMUX_TARGET, {
      platform: 'darwin',
      bridgeMode: 'iterm2-applescript',
      execFile,
    });

    expect(result).toMatchObject({ ok: false, reason: 'automation-denied' });
  });
});
