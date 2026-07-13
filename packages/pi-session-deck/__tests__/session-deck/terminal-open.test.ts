import { describe, expect, it, vi } from 'vitest';
import { openTerminalRevealUrl } from '../../extensions/session-deck/terminal-open.js';

const REVEAL_URL = 'iterm2:///reveal?sessionid=w0t0p0%3Aabc';

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
