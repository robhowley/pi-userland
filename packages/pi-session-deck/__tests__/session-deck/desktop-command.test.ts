import { describe, expect, it, vi } from 'vitest';
import {
  getSessionDeckDesktopCommandCompletions,
  isSessionDeckDesktopCommand,
  parseSessionDeckDesktopCommandArgs,
  runSessionDeckDesktopCommand,
  SESSION_DECK_DESKTOP_COMMAND_USAGE,
} from '../../extensions/session-deck/desktop/command.js';

const SHA256 = 'a'.repeat(64);

describe('session-deck desktop command', () => {
  it('detects the desktop subcommand without stealing normal flag mode', () => {
    expect(isSessionDeckDesktopCommand('desktop')).toBe(true);
    expect(isSessionDeckDesktopCommand('desktop install')).toBe(true);
    expect(isSessionDeckDesktopCommand('  desktop doctor')).toBe(true);
    expect(isSessionDeckDesktopCommand('--all')).toBe(false);
    expect(isSessionDeckDesktopCommand('')).toBe(false);
  });

  it('parses install, open, doctor, and uninstall actions', () => {
    expect(parseSessionDeckDesktopCommandArgs('desktop install')).toEqual({
      ok: true,
      action: 'install',
    });
    expect(
      parseSessionDeckDesktopCommandArgs(
        `desktop install --from-path "/tmp/Session Deck.app" --version 0.9.0 --sha256 ${SHA256}`,
      ),
    ).toEqual({
      ok: true,
      action: 'install',
      fromPath: '/tmp/Session Deck.app',
      version: '0.9.0',
      sha256: SHA256,
    });
    expect(parseSessionDeckDesktopCommandArgs('desktop open')).toEqual({
      ok: true,
      action: 'open',
    });
    expect(parseSessionDeckDesktopCommandArgs('desktop doctor')).toEqual({
      ok: true,
      action: 'doctor',
    });
    expect(parseSessionDeckDesktopCommandArgs('desktop uninstall')).toEqual({
      ok: true,
      action: 'uninstall',
    });
  });

  it('returns explicit usage errors for malformed desktop arguments', () => {
    expect(parseSessionDeckDesktopCommandArgs('desktop')).toEqual({
      ok: false,
      message: `Missing desktop action. ${SESSION_DECK_DESKTOP_COMMAND_USAGE}`,
    });
    expect(parseSessionDeckDesktopCommandArgs('desktop launch')).toEqual({
      ok: false,
      message: `Unsupported desktop action: launch. ${SESSION_DECK_DESKTOP_COMMAND_USAGE}`,
    });
    expect(parseSessionDeckDesktopCommandArgs('desktop install --from-path')).toEqual({
      ok: false,
      message: `Missing value for --from-path. ${SESSION_DECK_DESKTOP_COMMAND_USAGE}`,
    });
    expect(
      parseSessionDeckDesktopCommandArgs('desktop install --from-path /tmp/a --from-path /tmp/b'),
    ).toEqual({
      ok: false,
      message: `Duplicate flag: --from-path. ${SESSION_DECK_DESKTOP_COMMAND_USAGE}`,
    });
    expect(parseSessionDeckDesktopCommandArgs('desktop install --sha256 abc')).toEqual({
      ok: false,
      message: `--sha256 must be a lowercase SHA-256 hash. ${SESSION_DECK_DESKTOP_COMMAND_USAGE}`,
    });
    expect(
      parseSessionDeckDesktopCommandArgs('desktop install --from-path "/tmp/Session Deck.app'),
    ).toEqual({
      ok: false,
      message: `Unterminated quoted argument. ${SESSION_DECK_DESKTOP_COMMAND_USAGE}`,
    });
    expect(parseSessionDeckDesktopCommandArgs('desktop doctor --from-path /tmp/app')).toEqual({
      ok: false,
      message: `--from-path is only supported for desktop install. ${SESSION_DECK_DESKTOP_COMMAND_USAGE}`,
    });
  });

  it('offers subcommand and install flag completions', () => {
    expect(getSessionDeckDesktopCommandCompletions('')).toEqual([
      { value: 'desktop', label: 'desktop' },
    ]);
    expect(getSessionDeckDesktopCommandCompletions('des')).toEqual([
      { value: 'desktop', label: 'desktop' },
    ]);
    expect(getSessionDeckDesktopCommandCompletions('desktop ')).toEqual([
      { value: 'desktop install', label: 'install' },
      { value: 'desktop open', label: 'open' },
      { value: 'desktop uninstall', label: 'uninstall' },
      { value: 'desktop doctor', label: 'doctor' },
    ]);
    expect(getSessionDeckDesktopCommandCompletions('desktop d')).toEqual([
      { value: 'desktop doctor', label: 'doctor' },
    ]);
    expect(getSessionDeckDesktopCommandCompletions('desktop install ')).toEqual([
      { value: 'desktop install --from-path', label: '--from-path' },
      { value: 'desktop install --version', label: '--version' },
      { value: 'desktop install --sha256', label: '--sha256' },
    ]);
    expect(getSessionDeckDesktopCommandCompletions('desktop install --from-path')).toBeNull();
    expect(getSessionDeckDesktopCommandCompletions('desktop open ')).toBeNull();
    expect(getSessionDeckDesktopCommandCompletions('zzz')).toBeNull();
  });

  it('dispatches to install, open, uninstall, and doctor handlers', async () => {
    const install = vi.fn(async () => ({ level: 'info' as const, message: 'installed' }));
    const open = vi.fn(async () => ({ level: 'info' as const, message: 'opened' }));
    const uninstall = vi.fn(async () => ({ level: 'warning' as const, message: 'uninstalled' }));
    const doctor = vi.fn(async () => ({ level: 'error' as const, message: 'doctor' }));

    await expect(
      runSessionDeckDesktopCommand(`desktop install --from-path /tmp/app --sha256 ${SHA256}`, {
        install,
        open,
        uninstall,
        doctor,
      }),
    ).resolves.toEqual({ level: 'info', message: 'installed' });
    expect(install).toHaveBeenCalledWith({ fromPath: '/tmp/app', sha256: SHA256 });

    await expect(
      runSessionDeckDesktopCommand('desktop open', { install, open, uninstall, doctor }),
    ).resolves.toEqual({ level: 'info', message: 'opened' });
    expect(open).toHaveBeenCalledWith({});

    await expect(
      runSessionDeckDesktopCommand('desktop uninstall', { install, open, uninstall, doctor }),
    ).resolves.toEqual({ level: 'warning', message: 'uninstalled' });
    expect(uninstall).toHaveBeenCalledWith({});

    await expect(
      runSessionDeckDesktopCommand('desktop doctor', { install, open, uninstall, doctor }),
    ).resolves.toEqual({ level: 'error', message: 'doctor' });
    expect(doctor).toHaveBeenCalledWith({});
  });
});
