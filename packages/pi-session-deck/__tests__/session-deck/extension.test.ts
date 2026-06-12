import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('pi-session-deck extension', () => {
  it('starts presence on load and rechecks on repeated session_start events', async () => {
    const ensurePresenceRuntimeStarted = vi.fn().mockResolvedValue({
      runtime: {
        runtimeId: 'runtime-1',
        pid: 1234,
        startedAt: '2026-06-12T12:00:00.000Z',
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
    }));

    const { default: install } = await import('../../extensions/session-deck/index.js');
    const handlers = new Map<string, () => Promise<void>>();
    const pi = {
      on: vi.fn((event: string, handler: () => Promise<void>) => {
        handlers.set(event, handler);
      }),
      registerCommand: vi.fn(),
    };

    await install(pi as never);

    expect(registerPresenceCommand).toHaveBeenCalledWith(pi);
    expect(Array.from(handlers.keys())).toEqual(['session_start']);
    expect(ensurePresenceRuntimeStarted).toHaveBeenCalledTimes(1);

    await handlers.get('session_start')?.();
    await handlers.get('session_start')?.();

    expect(ensurePresenceRuntimeStarted).toHaveBeenCalledTimes(3);
  });
});
