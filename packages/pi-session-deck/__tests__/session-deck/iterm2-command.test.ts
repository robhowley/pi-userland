import { describe, expect, it, vi } from 'vitest';
import {
  getSessionDeckIterm2CommandCompletions,
  isSessionDeckIterm2Command,
  parseSessionDeckIterm2CommandArgs,
  runSessionDeckIterm2Command,
  SESSION_DECK_ITERM2_COMMAND_USAGE,
} from '../../extensions/session-deck/iterm2/command.js';

describe('session-deck iterm2 command', () => {
  it('detects the iterm2 subcommand without stealing normal flag mode', () => {
    expect(isSessionDeckIterm2Command('iterm2')).toBe(true);
    expect(isSessionDeckIterm2Command('iterm2 install')).toBe(true);
    expect(isSessionDeckIterm2Command('  iterm2 doctor')).toBe(true);
    expect(isSessionDeckIterm2Command('--all')).toBe(false);
    expect(isSessionDeckIterm2Command('')).toBe(false);
  });

  it('parses install with an optional scripts dir and keeps doctor/uninstall state-authoritative', () => {
    expect(parseSessionDeckIterm2CommandArgs('iterm2 install')).toEqual({
      ok: true,
      action: 'install',
    });
    expect(parseSessionDeckIterm2CommandArgs('iterm2 install --scripts-dir /tmp/scripts')).toEqual({
      ok: true,
      action: 'install',
      scriptsDir: '/tmp/scripts',
    });
    expect(parseSessionDeckIterm2CommandArgs('iterm2 uninstall')).toEqual({
      ok: true,
      action: 'uninstall',
    });
    expect(parseSessionDeckIterm2CommandArgs('iterm2 doctor')).toEqual({
      ok: true,
      action: 'doctor',
    });
  });

  it('returns explicit usage errors for malformed iterm2 arguments', () => {
    expect(parseSessionDeckIterm2CommandArgs('iterm2')).toEqual({
      ok: false,
      message: `Missing iterm2 action. ${SESSION_DECK_ITERM2_COMMAND_USAGE}`,
    });
    expect(parseSessionDeckIterm2CommandArgs('iterm2 launch')).toEqual({
      ok: false,
      message: `Unsupported iterm2 action: launch. ${SESSION_DECK_ITERM2_COMMAND_USAGE}`,
    });
    expect(parseSessionDeckIterm2CommandArgs('iterm2 install --scripts-dir')).toEqual({
      ok: false,
      message: `Missing value for --scripts-dir. ${SESSION_DECK_ITERM2_COMMAND_USAGE}`,
    });
    expect(
      parseSessionDeckIterm2CommandArgs('iterm2 install --scripts-dir /tmp --scripts-dir /other'),
    ).toEqual({
      ok: false,
      message: `Duplicate flag: --scripts-dir. ${SESSION_DECK_ITERM2_COMMAND_USAGE}`,
    });
    expect(parseSessionDeckIterm2CommandArgs('iterm2 install --wat')).toEqual({
      ok: false,
      message: `Unsupported argument: --wat. ${SESSION_DECK_ITERM2_COMMAND_USAGE}`,
    });
    expect(parseSessionDeckIterm2CommandArgs('iterm2 doctor --scripts-dir /tmp')).toEqual({
      ok: false,
      message: `--scripts-dir is only supported for iterm2 install. ${SESSION_DECK_ITERM2_COMMAND_USAGE}`,
    });
    expect(parseSessionDeckIterm2CommandArgs('iterm2 uninstall --scripts-dir /tmp')).toEqual({
      ok: false,
      message: `--scripts-dir is only supported for iterm2 install. ${SESSION_DECK_ITERM2_COMMAND_USAGE}`,
    });
  });

  it('offers subcommand and install-only scripts-dir completions and returns null when nothing matches', () => {
    expect(getSessionDeckIterm2CommandCompletions('')).toEqual([
      { value: 'iterm2', label: 'iterm2' },
    ]);
    expect(getSessionDeckIterm2CommandCompletions('it')).toEqual([
      { value: 'iterm2', label: 'iterm2' },
    ]);
    expect(getSessionDeckIterm2CommandCompletions('iterm2 ')).toEqual([
      { value: 'iterm2 install', label: 'install' },
      { value: 'iterm2 uninstall', label: 'uninstall' },
      { value: 'iterm2 doctor', label: 'doctor' },
    ]);
    expect(getSessionDeckIterm2CommandCompletions('iterm2 d')).toEqual([
      { value: 'iterm2 doctor', label: 'doctor' },
    ]);
    expect(getSessionDeckIterm2CommandCompletions('iterm2 install ')).toEqual([
      { value: 'iterm2 install --scripts-dir', label: '--scripts-dir' },
    ]);
    expect(getSessionDeckIterm2CommandCompletions('iterm2 doctor ')).toBeNull();
    expect(getSessionDeckIterm2CommandCompletions('iterm2 uninstall ')).toBeNull();
    expect(getSessionDeckIterm2CommandCompletions('iterm2 install --scripts-dir')).toBeNull();
    expect(getSessionDeckIterm2CommandCompletions('zzz')).toBeNull();
  });

  it('dispatches to install, uninstall, and doctor handlers', async () => {
    const install = vi.fn(async () => ({ level: 'info' as const, message: 'installed' }));
    const uninstall = vi.fn(async () => ({ level: 'warning' as const, message: 'uninstalled' }));
    const doctor = vi.fn(async () => ({ level: 'error' as const, message: 'doctor' }));

    await expect(
      runSessionDeckIterm2Command('iterm2 install --scripts-dir /tmp/scripts', {
        install,
        uninstall,
        doctor,
      }),
    ).resolves.toEqual({ level: 'info', message: 'installed' });
    expect(install).toHaveBeenCalledWith({ scriptsDir: '/tmp/scripts' });

    await expect(
      runSessionDeckIterm2Command('iterm2 uninstall', { install, uninstall, doctor }),
    ).resolves.toEqual({ level: 'warning', message: 'uninstalled' });
    expect(uninstall).toHaveBeenCalledWith({});

    await expect(
      runSessionDeckIterm2Command('iterm2 doctor', { install, uninstall, doctor }),
    ).resolves.toEqual({ level: 'error', message: 'doctor' });
    expect(doctor).toHaveBeenCalledWith({});
  });
});
