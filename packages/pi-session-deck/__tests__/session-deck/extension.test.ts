import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

type RegisteredHandler = (event: any, ctx: any) => Promise<void>;

describe('pi-session-deck extension', () => {
  it('registers activity hooks, preserves footer ownership, and refreshes identity/activity on repeated session_start events', async () => {
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
    const refreshIdentity = vi.fn().mockResolvedValue(undefined);
    const refreshActivity = vi.fn().mockResolvedValue(undefined);
    const registerSessionDeckCommand = vi.fn();

    vi.doMock('../../extensions/session-deck/presence/runtime.js', () => ({
      ensurePresenceRuntimeStarted,
    }));
    vi.doMock('../../extensions/session-deck/identity/runtime.js', () => ({
      ensureIdentityRuntimeStarted: vi.fn().mockResolvedValue({
        refreshIdentity,
        getIdentity: vi.fn().mockReturnValue(null),
        isRunning: vi.fn(() => true),
      }),
      stopIdentityRuntime: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../../extensions/session-deck/activity/runtime.js', () => ({
      ensureActivityRuntimeStarted: vi.fn().mockResolvedValue({
        refreshActivity,
        recordMessageEnd: vi.fn().mockResolvedValue(undefined),
        recordTurnStart: vi.fn().mockResolvedValue(undefined),
        recordToolExecutionStart: vi.fn().mockResolvedValue(undefined),
        recordToolExecutionEnd: vi.fn().mockResolvedValue(undefined),
        recordTurnEnd: vi.fn().mockResolvedValue(undefined),
        getActivity: vi.fn().mockReturnValue(null),
        isRunning: vi.fn(() => true),
      }),
    }));
    vi.doMock('../../extensions/session-deck/identity/command.js', () => ({
      registerSessionDeckCommand,
    }));

    const { default: install } = await import('../../extensions/session-deck/index.js');
    const handlers = new Map<string, RegisteredHandler>();
    const pi = {
      on: vi.fn((event: string, handler: RegisteredHandler) => {
        handlers.set(event, handler);
      }),
    };

    await install(pi as never);

    expect(registerSessionDeckCommand).toHaveBeenCalledWith(pi);
    expect(Array.from(handlers.keys())).toEqual([
      'session_start',
      'message_end',
      'turn_start',
      'tool_execution_start',
      'tool_execution_end',
      'turn_end',
      'session_shutdown',
    ]);
    expect(ensurePresenceRuntimeStarted).toHaveBeenCalledTimes(1);

    const ctx = {
      mode: 'tui',
      cwd: '/repo',
      model: {
        id: 'gpt-5',
        provider: 'openai',
      },
      getContextUsage: () => ({ percent: 12.5, contextWindow: 200_000 }),
      sessionManager: {
        getSessionId: () => 'session-1',
        getSessionFile: () => '/tmp/session-1.md',
        getEntries: () => [],
        getSessionName: () => 'Focused session',
        getCwd: () => '/repo',
      },
      ui: {
        setStatus: vi.fn(),
        setFooter: vi.fn(),
      },
    };

    await handlers.get('session_start')?.({ reason: 'startup' }, ctx);
    await handlers.get('session_start')?.({ reason: 'new' }, ctx);

    expect(ensurePresenceRuntimeStarted).toHaveBeenCalledTimes(3);
    expect(refreshIdentity).toHaveBeenNthCalledWith(1, 'startup', expect.any(Object));
    expect(refreshIdentity).toHaveBeenNthCalledWith(2, 'new', expect.any(Object));
    expect(refreshIdentity.mock.calls[0]?.[1]?.getSessionName?.()).toBe('Focused session');
    expect(refreshIdentity.mock.calls[0]?.[1]?.getCwd?.()).toBe('/repo');
    expect(refreshActivity).toHaveBeenNthCalledWith(1, 'startup', expect.any(Object));
    expect(refreshActivity).toHaveBeenNthCalledWith(2, 'new', expect.any(Object));
    expect(ctx.ui.setFooter).not.toHaveBeenCalled();
    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenNthCalledWith(1, 'session-deck', undefined);
    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenNthCalledWith(2, 'session-deck', undefined);
  });

  it('forwards runtime events into the activity runtime', async () => {
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
    const activityRuntime = {
      refreshActivity: vi.fn().mockResolvedValue(undefined),
      recordMessageEnd: vi.fn().mockResolvedValue(undefined),
      recordTurnStart: vi.fn().mockResolvedValue(undefined),
      recordToolExecutionStart: vi.fn().mockResolvedValue(undefined),
      recordToolExecutionEnd: vi.fn().mockResolvedValue(undefined),
      recordTurnEnd: vi.fn().mockResolvedValue(undefined),
      getActivity: vi.fn().mockReturnValue(null),
      isRunning: vi.fn(() => true),
    };

    vi.doMock('../../extensions/session-deck/presence/runtime.js', () => ({
      ensurePresenceRuntimeStarted,
    }));
    vi.doMock('../../extensions/session-deck/identity/runtime.js', () => ({
      ensureIdentityRuntimeStarted: vi.fn().mockResolvedValue({
        refreshIdentity: vi.fn().mockResolvedValue(undefined),
        getIdentity: vi.fn().mockReturnValue(null),
        isRunning: vi.fn(() => true),
      }),
      stopIdentityRuntime: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../../extensions/session-deck/activity/runtime.js', () => ({
      ensureActivityRuntimeStarted: vi.fn().mockResolvedValue(activityRuntime),
    }));
    vi.doMock('../../extensions/session-deck/identity/command.js', () => ({
      registerSessionDeckCommand: vi.fn(),
    }));

    const { default: install } = await import('../../extensions/session-deck/index.js');
    const handlers = new Map<string, RegisteredHandler>();
    const pi = {
      on: vi.fn((event: string, handler: RegisteredHandler) => {
        handlers.set(event, handler);
      }),
    };

    await install(pi as never);

    await handlers.get('message_end')?.(
      { message: { role: 'assistant', stopReason: 'error', errorMessage: 'boom' } },
      {},
    );
    await handlers.get('turn_start')?.({}, {});
    await handlers.get('tool_execution_start')?.({ toolCallId: 'tool-1', toolName: 'read' }, {});
    await handlers.get('tool_execution_end')?.(
      { toolCallId: 'tool-1', toolName: 'read', isError: true },
      {},
    );
    await handlers.get('turn_end')?.({}, {});

    expect(activityRuntime.recordMessageEnd).toHaveBeenCalledWith({
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'boom',
    });
    expect(activityRuntime.recordTurnStart).toHaveBeenCalledTimes(1);
    expect(activityRuntime.recordToolExecutionStart).toHaveBeenCalledWith({
      toolCallId: 'tool-1',
      toolName: 'read',
    });
    expect(activityRuntime.recordToolExecutionEnd).toHaveBeenCalledWith({
      toolCallId: 'tool-1',
      toolName: 'read',
      isError: true,
    });
    expect(activityRuntime.recordTurnEnd).toHaveBeenCalledTimes(1);
  });

  it('stops the identity runtime on session_shutdown', async () => {
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
    const stopIdentityRuntime = vi.fn().mockResolvedValue(undefined);

    vi.doMock('../../extensions/session-deck/presence/runtime.js', () => ({
      ensurePresenceRuntimeStarted,
    }));
    vi.doMock('../../extensions/session-deck/identity/runtime.js', () => ({
      ensureIdentityRuntimeStarted: vi.fn().mockResolvedValue({
        refreshIdentity: vi.fn().mockResolvedValue(undefined),
        getIdentity: vi.fn().mockReturnValue(null),
        isRunning: vi.fn(() => true),
      }),
      stopIdentityRuntime,
    }));
    vi.doMock('../../extensions/session-deck/activity/runtime.js', () => ({
      ensureActivityRuntimeStarted: vi.fn().mockResolvedValue({
        refreshActivity: vi.fn().mockResolvedValue(undefined),
        recordMessageEnd: vi.fn().mockResolvedValue(undefined),
        recordTurnStart: vi.fn().mockResolvedValue(undefined),
        recordToolExecutionStart: vi.fn().mockResolvedValue(undefined),
        recordToolExecutionEnd: vi.fn().mockResolvedValue(undefined),
        recordTurnEnd: vi.fn().mockResolvedValue(undefined),
        getActivity: vi.fn().mockReturnValue(null),
        isRunning: vi.fn(() => true),
      }),
    }));
    vi.doMock('../../extensions/session-deck/identity/command.js', () => ({
      registerSessionDeckCommand: vi.fn(),
    }));

    const { default: install } = await import('../../extensions/session-deck/index.js');
    const handlers = new Map<string, RegisteredHandler>();
    const pi = {
      on: vi.fn((event: string, handler: RegisteredHandler) => {
        handlers.set(event, handler);
      }),
    };

    await install(pi as never);
    await handlers.get('session_shutdown')?.({}, {});

    expect(stopIdentityRuntime).toHaveBeenCalledTimes(1);
  });

  it('does not touch footer APIs during startup even when they are available', async () => {
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

    vi.doMock('../../extensions/session-deck/presence/runtime.js', () => ({
      ensurePresenceRuntimeStarted,
    }));
    vi.doMock('../../extensions/session-deck/identity/runtime.js', () => ({
      ensureIdentityRuntimeStarted: vi.fn().mockResolvedValue({
        refreshIdentity: vi.fn().mockResolvedValue(undefined),
        getIdentity: vi.fn().mockReturnValue(null),
        isRunning: vi.fn(() => true),
      }),
      stopIdentityRuntime: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../../extensions/session-deck/activity/runtime.js', () => ({
      ensureActivityRuntimeStarted: vi.fn().mockResolvedValue({
        refreshActivity: vi.fn().mockResolvedValue(undefined),
        recordMessageEnd: vi.fn().mockResolvedValue(undefined),
        recordTurnStart: vi.fn().mockResolvedValue(undefined),
        recordToolExecutionStart: vi.fn().mockResolvedValue(undefined),
        recordToolExecutionEnd: vi.fn().mockResolvedValue(undefined),
        recordTurnEnd: vi.fn().mockResolvedValue(undefined),
        getActivity: vi.fn().mockReturnValue(null),
        isRunning: vi.fn(() => true),
      }),
    }));
    vi.doMock('../../extensions/session-deck/identity/command.js', () => ({
      registerSessionDeckCommand: vi.fn(),
    }));

    const { default: install } = await import('../../extensions/session-deck/index.js');
    const handlers = new Map<string, RegisteredHandler>();
    const pi = {
      on: vi.fn((event: string, handler: RegisteredHandler) => {
        handlers.set(event, handler);
      }),
    };

    await install(pi as never);

    const ctx = {
      mode: 'tui',
      sessionManager: {
        getSessionId: () => 'session-1',
        getSessionFile: () => '/tmp/session-1.md',
      },
      ui: {
        setStatus: vi.fn(),
        setFooter: vi.fn(),
      },
    };

    await handlers.get('session_start')?.({ reason: 'startup' }, ctx);

    expect(vi.mocked(ctx.ui.setFooter)).not.toHaveBeenCalled();
    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenCalledWith('session-deck', undefined);
  });

  it('surfaces degraded startup state through session-deck status', async () => {
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

    vi.doMock('../../extensions/session-deck/presence/runtime.js', () => ({
      ensurePresenceRuntimeStarted,
    }));
    vi.doMock('../../extensions/session-deck/identity/runtime.js', () => ({
      ensureIdentityRuntimeStarted: vi.fn().mockResolvedValue({
        refreshIdentity: vi.fn().mockResolvedValue(undefined),
        getIdentity: vi.fn().mockReturnValue(null),
        isRunning: vi.fn(() => true),
      }),
      stopIdentityRuntime: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../../extensions/session-deck/activity/runtime.js', () => ({
      ensureActivityRuntimeStarted: vi.fn().mockResolvedValue({
        refreshActivity: vi.fn().mockResolvedValue(undefined),
        recordMessageEnd: vi.fn().mockResolvedValue(undefined),
        recordTurnStart: vi.fn().mockResolvedValue(undefined),
        recordToolExecutionStart: vi.fn().mockResolvedValue(undefined),
        recordToolExecutionEnd: vi.fn().mockResolvedValue(undefined),
        recordTurnEnd: vi.fn().mockResolvedValue(undefined),
        getActivity: vi.fn().mockReturnValue(null),
        isRunning: vi.fn(() => true),
      }),
    }));
    vi.doMock('../../extensions/session-deck/identity/command.js', () => ({
      registerSessionDeckCommand: vi.fn(),
    }));

    const { default: install } = await import('../../extensions/session-deck/index.js');
    const handlers = new Map<string, RegisteredHandler>();
    const pi = {
      on: vi.fn((event: string, handler: RegisteredHandler) => {
        handlers.set(event, handler);
      }),
    };

    await install(pi as never);

    const ctx = {
      sessionManager: {
        getSessionId: () => 'session-1',
        getSessionFile: () => '/tmp/session-1.md',
      },
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
