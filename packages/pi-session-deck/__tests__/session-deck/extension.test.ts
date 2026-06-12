import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

type SessionStartHandler = (
  event: { reason: 'startup' | 'reload' | 'new' | 'resume' | 'fork' },
  ctx: {
    ui: {
      setStatus: (key: string, text: string | undefined) => void;
    };
  },
) => Promise<void>;

describe('pi-session-deck extension', () => {
  it('starts presence on load, rechecks on repeated session_start events, and clears healthy status', async () => {
    const ensurePresenceRuntimeStarted = vi.fn().mockResolvedValue({
      runtime: {
        runtimeId: 'runtime-1',
        pid: 1234,
        startedAt: '2026-06-12T12:00:00.000Z',
      },
      startup: {
        state: 'healthy',
      },
      isRunning: vi.fn(() => true),
      stop: vi.fn(),
    });
    const registerPresenceCommand = vi.fn();

    vi.doMock('../../extensions/session-deck/presence/runtime.js', () => ({
      ensurePresenceRuntimeStarted,
    }));
    vi.doMock('../../extensions/session-deck/presence/command.js', () => ({
      registerPresenceCommand,
      SESSION_DECK_COMMAND_NAME: 'session-deck',
    }));

    const { default: install } = await import('../../extensions/session-deck/index.js');
    const handlers = new Map<string, SessionStartHandler>();
    const pi = {
      on: vi.fn((event: string, handler: SessionStartHandler) => {
        handlers.set(event, handler);
      }),
      registerCommand: vi.fn(),
    };

    await install(pi as never);

    expect(registerPresenceCommand).toHaveBeenCalledWith(pi);
    expect(Array.from(handlers.keys())).toEqual(['session_start']);
    expect(ensurePresenceRuntimeStarted).toHaveBeenCalledTimes(1);

    const ctx = {
      ui: {
        setStatus: vi.fn(),
      },
    };

    await handlers.get('session_start')?.({ reason: 'startup' }, ctx);
    await handlers.get('session_start')?.({ reason: 'new' }, ctx);

    expect(ensurePresenceRuntimeStarted).toHaveBeenCalledTimes(3);
    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenNthCalledWith(1, 'session-deck', undefined);
    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenNthCalledWith(2, 'session-deck', undefined);
  });

  it('surfaces degraded startup state in the footer status', async () => {
    const ensurePresenceRuntimeStarted = vi.fn().mockResolvedValue({
      runtime: {
        runtimeId: 'runtime-1',
        pid: 1234,
        startedAt: '2026-06-12T12:00:00.000Z',
      },
      startup: {
        state: 'degraded',
        diagnostic: {
          code: 'write_error',
          message: 'Failed to write presence record: permission denied',
          filePath: '/tmp/session-deck/presence',
        },
      },
      isRunning: vi.fn(() => true),
      stop: vi.fn(),
    });
    const registerPresenceCommand = vi.fn();

    vi.doMock('../../extensions/session-deck/presence/runtime.js', () => ({
      ensurePresenceRuntimeStarted,
    }));
    vi.doMock('../../extensions/session-deck/presence/command.js', () => ({
      registerPresenceCommand,
      SESSION_DECK_COMMAND_NAME: 'session-deck',
    }));

    const { default: install } = await import('../../extensions/session-deck/index.js');
    const handlers = new Map<string, SessionStartHandler>();
    const pi = {
      on: vi.fn((event: string, handler: SessionStartHandler) => {
        handlers.set(event, handler);
      }),
      registerCommand: vi.fn(),
    };

    await install(pi as never);

    const ctx = {
      ui: {
        setStatus: vi.fn(),
      },
    };

    await handlers.get('session_start')?.({ reason: 'startup' }, ctx);

    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenCalledWith(
      'session-deck',
      'session-deck degraded: Failed to write presence record: permission denied',
    );
  });
});
