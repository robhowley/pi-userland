import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { terminateSessionDeckRuntime } from '../../extensions/session-deck/presence/terminate.js';
import type { PresenceRecord } from '../../extensions/session-deck/presence/types.js';

const tempDirectories: string[] = [];

function buildRecord(overrides: Partial<PresenceRecord> = {}): PresenceRecord {
  return {
    runtimeId: 'rt-1',
    pid: 1234,
    startedAt: '2026-07-17T12:00:00.000Z',
    heartbeatAt: '2026-07-17T12:00:10.000Z',
    ...overrides,
  };
}

async function createPresenceDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'session-deck-terminate-'));
  tempDirectories.push(directory);
  return directory;
}

async function writePresence(
  directory: string,
  record: unknown,
  runtimeId = 'rt-1',
): Promise<void> {
  await writeFile(join(directory, `${runtimeId}.json`), JSON.stringify(record), 'utf8');
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('terminateSessionDeckRuntime', () => {
  it('rejects unsafe runtime ids before reading a presence path', async () => {
    const readFile = vi.fn(async () => '{}');

    await expect(terminateSessionDeckRuntime('../rt-1', { readFile })).resolves.toEqual({
      ok: false,
      reason: 'invalid-runtime-id',
    });
    expect(readFile).not.toHaveBeenCalled();
  });

  it('rereads presence by runtime id and rejects missing malformed or mismatched records', async () => {
    const directory = await createPresenceDirectory();

    await expect(terminateSessionDeckRuntime('rt-missing', { directory })).resolves.toEqual({
      ok: false,
      reason: 'presence-missing',
    });

    await writeFile(join(directory, 'rt-bad.json'), '{', 'utf8');
    await expect(terminateSessionDeckRuntime('rt-bad', { directory })).resolves.toEqual({
      ok: false,
      reason: 'presence-malformed',
    });

    await writePresence(directory, buildRecord({ runtimeId: 'rt-other' }));
    await expect(terminateSessionDeckRuntime('rt-1', { directory })).resolves.toEqual({
      ok: false,
      reason: 'runtime-mismatch',
    });
  });

  it('treats missing pid metadata and pid_missing inspection as already exited without signaling', async () => {
    const directory = await createPresenceDirectory();
    const signalProcess = vi.fn();

    await writePresence(directory, { runtimeId: 'rt-1', startedAt: '2026-07-17T12:00:00.000Z' });
    await expect(
      terminateSessionDeckRuntime('rt-1', { directory, signalProcess }),
    ).resolves.toEqual({
      ok: true,
      status: 'already-exited',
    });

    await writePresence(directory, buildRecord());
    await expect(
      terminateSessionDeckRuntime('rt-1', {
        directory,
        inspectPid: async () => ({ status: 'missing', reason: 'pid_missing' }),
        signalProcess,
      }),
    ).resolves.toEqual({ ok: true, status: 'already-exited' });
    expect(signalProcess).not.toHaveBeenCalled();
  });

  it('fails closed on reused unverified and timed-out pid inspection', async () => {
    const directory = await createPresenceDirectory();
    const signalProcess = vi.fn();
    await writePresence(directory, buildRecord());

    await expect(
      terminateSessionDeckRuntime('rt-1', {
        directory,
        inspectPid: async () => ({ status: 'reused', reason: 'pid_reused' }),
        signalProcess,
      }),
    ).resolves.toEqual({ ok: false, reason: 'pid-reused' });

    await expect(
      terminateSessionDeckRuntime('rt-1', {
        directory,
        inspectPid: async () => ({ status: 'unverified', reason: 'pid_unverified' }),
        signalProcess,
      }),
    ).resolves.toEqual({ ok: false, reason: 'pid-unverified' });

    await expect(
      terminateSessionDeckRuntime('rt-1', {
        directory,
        inspectPid: async () => new Promise(() => undefined),
        inspectTimeoutMs: 1,
        signalProcess,
      }),
    ).resolves.toEqual({ ok: false, reason: 'pid-unverified' });

    expect(signalProcess).not.toHaveBeenCalled();
  });

  it('sends exactly SIGTERM when pid identity matches and maps signal failures safely', async () => {
    const directory = await createPresenceDirectory();
    await writePresence(directory, buildRecord({ pid: 4321 }));
    const inspectPid = vi.fn(async () => ({ status: 'matches' as const }));
    const signalProcess = vi.fn();

    await expect(
      terminateSessionDeckRuntime('rt-1', { directory, inspectPid, signalProcess }),
    ).resolves.toEqual({ ok: true, status: 'signal-sent' });
    expect(signalProcess).toHaveBeenCalledWith(4321, 'SIGTERM');
    expect(signalProcess).toHaveBeenCalledTimes(1);

    const signalError = (code: string) =>
      vi.fn(() => {
        const error = new Error(code) as NodeJS.ErrnoException;
        error.code = code;
        throw error;
      });

    await expect(
      terminateSessionDeckRuntime('rt-1', {
        directory,
        inspectPid,
        signalProcess: signalError('ESRCH'),
      }),
    ).resolves.toEqual({ ok: true, status: 'already-exited' });
    await expect(
      terminateSessionDeckRuntime('rt-1', {
        directory,
        inspectPid,
        signalProcess: signalError('EPERM'),
      }),
    ).resolves.toEqual({ ok: false, reason: 'permission-denied' });
    await expect(
      terminateSessionDeckRuntime('rt-1', {
        directory,
        inspectPid,
        signalProcess: signalError('EIO'),
      }),
    ).resolves.toEqual({ ok: false, reason: 'signal-failed' });
  });

  it('never signals the current process id', async () => {
    const directory = await createPresenceDirectory();
    const signalProcess = vi.fn();
    await writePresence(directory, buildRecord({ pid: 999 }));

    await expect(
      terminateSessionDeckRuntime('rt-1', {
        directory,
        currentPid: 999,
        inspectPid: async () => ({ status: 'matches' }),
        signalProcess,
      }),
    ).resolves.toEqual({ ok: false, reason: 'self-signal-denied' });
    expect(signalProcess).not.toHaveBeenCalled();
  });
});
