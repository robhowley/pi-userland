import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureIdentityRuntimeStarted,
  resetIdentityRuntimeForTests,
  stopIdentityRuntime,
} from '../../extensions/session-deck/identity/runtime.js';

afterEach(async () => {
  await resetIdentityRuntimeForTests();
});

describe('identity runtime lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-17T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a controller with getIdentity null before any refresh', async () => {
    const controller = await ensureIdentityRuntimeStarted('rt-1', { execGhCli: null });

    expect(controller.getIdentity()).toBeNull();
    expect(controller.isRunning()).toBe(true);
  });

  it('returns null from getIdentity before refresh completes', async () => {
    const controller = await ensureIdentityRuntimeStarted('rt-1', {
      execGhCli: null,
      writeRecord: vi.fn().mockResolvedValue(undefined),
    });

    expect(controller.getIdentity()).toBeNull();
  });

  it('refreshes identity and caches it', async () => {
    const writeRecord = vi.fn().mockResolvedValue(undefined);
    const controller = await ensureIdentityRuntimeStarted('rt-1', {
      execGhCli: null,
      writeRecord,
      now: () => new Date('2026-06-17T12:00:00.000Z'),
    });

    const mockSessionManager = {
      getSessionId: () => 'session-abc',
      getSessionFile: () => '/tmp/session-abc.json',
    };

    await controller.refreshIdentity('startup', mockSessionManager);

    expect(controller.getIdentity()).not.toBeNull();
    expect(controller.getIdentity()?.runtimeId).toBe('rt-1');
    expect(controller.getIdentity()?.sessionId).toBe('session-abc');
    expect(controller.getIdentity()?.identitySource).toBe('startup');
  });

  it('preserves session context across periodic refreshes', async () => {
    const writeRecord = vi.fn().mockResolvedValue(undefined);
    const controller = await ensureIdentityRuntimeStarted('rt-1', {
      execGhCli: null,
      writeRecord,
      now: () => new Date('2026-06-17T12:00:00.000Z'),
    });

    const mockSessionManager = {
      getSessionId: () => 'session-abc',
      getSessionFile: () => '/tmp/session-abc.json',
    };

    await controller.refreshIdentity('startup', mockSessionManager);
    expect(controller.getIdentity()?.sessionId).toBe('session-abc');

    await controller.refreshIdentity('periodic');
    expect(controller.getIdentity()?.sessionId).toBe('session-abc');
    expect(controller.getIdentity()?.identitySource).toBe('periodic');
  });

  it('preserves sessionStartedAt across periodic refreshes', async () => {
    const writeRecord = vi.fn().mockResolvedValue(undefined);
    const controller = await ensureIdentityRuntimeStarted('rt-1', {
      execGhCli: null,
      writeRecord,
    });

    const mockSessionManager = {
      getSessionId: () => 'session-abc',
      getSessionFile: () => '/tmp/session-abc.json',
    };

    vi.setSystemTime(new Date('2026-06-17T12:00:00.000Z'));
    await controller.refreshIdentity('startup', mockSessionManager);
    const sessionStartedAt = controller.getIdentity()?.sessionStartedAt;
    expect(sessionStartedAt).toBe('2026-06-17T12:00:00.000Z');

    vi.setSystemTime(new Date('2026-06-17T12:05:00.000Z'));
    await controller.refreshIdentity('periodic');
    expect(controller.getIdentity()?.sessionStartedAt).toBe(sessionStartedAt);
    expect(controller.getIdentity()?.identityUpdatedAt).toBe('2026-06-17T12:05:00.000Z');
  });

  it('updates sessionId/sessionFile on /new but keeps runtimeId', async () => {
    const writeRecord = vi.fn().mockResolvedValue(undefined);
    const controller = await ensureIdentityRuntimeStarted('rt-1', {
      execGhCli: null,
      writeRecord,
      now: () => new Date('2026-06-17T12:00:00.000Z'),
    });

    const sessionManager1 = {
      getSessionId: () => 'session-old',
      getSessionFile: () => '/tmp/session-old.json',
    };

    await controller.refreshIdentity('startup', sessionManager1);
    expect(controller.getIdentity()?.runtimeId).toBe('rt-1');
    expect(controller.getIdentity()?.sessionId).toBe('session-old');

    const sessionManager2 = {
      getSessionId: () => 'session-new',
      getSessionFile: () => '/tmp/session-new.json',
    };

    await controller.refreshIdentity('new', sessionManager2);
    expect(controller.getIdentity()?.runtimeId).toBe('rt-1');
    expect(controller.getIdentity()?.sessionId).toBe('session-new');
    expect(controller.getIdentity()?.identitySource).toBe('new');
  });

  it('does not crash when refreshIdentity is called with no runtimeId', async () => {
    const controller = await ensureIdentityRuntimeStarted('', {
      execGhCli: null,
      writeRecord: vi.fn().mockResolvedValue(undefined),
    });

    await expect(controller.refreshIdentity('startup')).resolves.toBeUndefined();
  });

  it('emits diagnostic on write failure', async () => {
    const onDiagnostic = vi.fn();
    const controller = await ensureIdentityRuntimeStarted('rt-1', {
      execGhCli: null,
      writeRecord: vi.fn().mockRejectedValue(new Error('disk full')),
      onDiagnostic,
    });

    const mockSessionManager = {
      getSessionId: () => 'session-abc',
      getSessionFile: () => '/tmp/session-abc.json',
    };

    await controller.refreshIdentity('startup', mockSessionManager);

    expect(onDiagnostic).toHaveBeenCalled();
    const calls = onDiagnostic.mock.calls;
    const lastCall = calls.at(-1)?.[0];
    expect(lastCall?.code).toBe('identity_write_error');
    expect(lastCall?.runtimeId).toBe('rt-1');
  });

  it('serializes concurrent refreshes so newer session state wins', async () => {
    let allowFirstGitLookup = false;
    let releaseFirstGitLookup!: () => void;
    const execGit = vi.fn(async (_cwd: string, ...args: string[]) => {
      if (args.join(' ') === 'rev-parse --show-toplevel' && !allowFirstGitLookup) {
        allowFirstGitLookup = true;
        await new Promise<void>((resolve) => {
          releaseFirstGitLookup = resolve;
        });
      }

      return { stdout: '', exitCode: 128 };
    });
    const writeRecord = vi.fn().mockResolvedValue(undefined);

    const controller = await ensureIdentityRuntimeStarted('rt-1', {
      execGhCli: null,
      execGit,
      writeRecord,
      now: () => new Date('2026-06-17T12:00:00.000Z'),
    });

    const startupRefresh = controller.refreshIdentity('startup', {
      getSessionId: () => 'session-old',
      getSessionFile: () => '/tmp/session-old.json',
    });
    const newRefresh = controller.refreshIdentity('new', {
      getSessionId: () => 'session-new',
      getSessionFile: () => '/tmp/session-new.json',
    });

    expect(controller.getIdentity()).toBeNull();
    await Promise.resolve();
    releaseFirstGitLookup();
    await Promise.all([startupRefresh, newRefresh]);

    expect(writeRecord).toHaveBeenCalledTimes(2);
    expect(writeRecord.mock.calls[0]?.[0].sessionId).toBe('session-old');
    expect(writeRecord.mock.calls[1]?.[0].sessionId).toBe('session-new');
    expect(controller.getIdentity()?.sessionId).toBe('session-new');
    expect(controller.getIdentity()?.identitySource).toBe('new');
  });

  it('stopIdentityRuntime stops the timer and clears state', async () => {
    const writeRecord = vi.fn().mockResolvedValue(undefined);
    const controller = await ensureIdentityRuntimeStarted('rt-1', {
      execGhCli: null,
      writeRecord,
    });

    expect(controller.isRunning()).toBe(true);

    await stopIdentityRuntime();
    expect(controller.isRunning()).toBe(false);
  });

  it('second call to ensureIdentityRuntimeStarted returns same controller', async () => {
    const controller1 = await ensureIdentityRuntimeStarted('rt-1', { execGhCli: null });
    const controller2 = await ensureIdentityRuntimeStarted('rt-2', { execGhCli: null });

    expect(controller1).toBe(controller2);
  });
});
