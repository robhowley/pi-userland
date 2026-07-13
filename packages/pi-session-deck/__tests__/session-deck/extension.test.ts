import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../extensions/session-deck/identity/terminal-collect.js');
  vi.restoreAllMocks();
  vi.resetModules();
});

type RegisteredHandler = (event: any, ctx: any) => Promise<void>;

const MOCK_STATUS_MIRROR = {
  reconfigure: vi.fn(),
  install: vi.fn(),
  clearTracked: vi.fn().mockResolvedValue(undefined),
};

type TerminalEnvKey =
  | 'ITERM_SESSION_ID'
  | 'TERM_SESSION_ID'
  | 'TERM_PROGRAM'
  | 'LC_TERMINAL'
  | 'LC_TERMINAL_VERSION'
  | 'TMUX'
  | 'TMUX_PANE';

const TERMINAL_ENV_KEYS: TerminalEnvKey[] = [
  'ITERM_SESSION_ID',
  'TERM_SESSION_ID',
  'TERM_PROGRAM',
  'LC_TERMINAL',
  'LC_TERMINAL_VERSION',
  'TMUX',
  'TMUX_PANE',
];

async function withTerminalEnv(
  overrides: Partial<Record<TerminalEnvKey, string | undefined>>,
  run: () => Promise<void>,
): Promise<void> {
  const previous = Object.fromEntries(
    TERMINAL_ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Partial<Record<TerminalEnvKey, string>>;

  for (const key of TERMINAL_ENV_KEYS) {
    delete process.env[key];
  }

  for (const [key, value] of Object.entries(overrides) as Array<
    [TerminalEnvKey, string | undefined]
  >) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await run();
  } finally {
    for (const key of TERMINAL_ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function setupMocks(presenceMock?: unknown, identityMock?: unknown, activityMock?: unknown) {
  const ensurePresenceRuntimeStarted =
    presenceMock ??
    vi.fn().mockResolvedValue({
      runtime: {
        runtimeId: 'runtime-1',
        pid: 1234,
        startedAt: '2026-06-12T12:00:00.000Z',
      },
      startup: { state: 'healthy' },
      isRunning: vi.fn(() => true),
      stop: vi.fn(),
    });

  const refreshIdentity = vi.fn().mockResolvedValue(undefined);
  const refreshActivity = vi.fn().mockResolvedValue(undefined);

  const identityRuntime =
    identityMock ??
    vi.fn().mockResolvedValue({
      refreshIdentity,
      getIdentity: vi.fn().mockReturnValue(null),
      isRunning: vi.fn(() => true),
    });

  const activityRuntime =
    activityMock ??
    vi.fn().mockResolvedValue({
      refreshActivity,
      recordMessageEnd: vi.fn().mockResolvedValue(undefined),
      recordTurnStart: vi.fn().mockResolvedValue(undefined),
      recordToolExecutionStart: vi.fn().mockResolvedValue(undefined),
      recordToolExecutionEnd: vi.fn().mockResolvedValue(undefined),
      recordTurnEnd: vi.fn().mockResolvedValue(undefined),
      getActivity: vi.fn().mockReturnValue(null),
      isRunning: vi.fn(() => true),
    });

  const stopIdentityRuntime = vi.fn().mockResolvedValue(undefined);

  vi.doMock('../../extensions/session-deck/presence/runtime.js', () => ({
    ensurePresenceRuntimeStarted,
  }));
  vi.doMock('../../extensions/session-deck/identity/runtime.js', () => ({
    ensureIdentityRuntimeStarted: identityRuntime,
    stopIdentityRuntime,
  }));
  vi.doMock('../../extensions/session-deck/activity/runtime.js', () => ({
    ensureActivityRuntimeStarted: activityRuntime,
  }));
  vi.doMock('../../extensions/session-deck/identity/command.js', () => ({
    registerSessionDeckCommand: vi.fn(),
  }));
  vi.doMock('../../extensions/session-deck/chips/mirror.js', () => ({
    createSetStatusMirror: vi.fn(() => MOCK_STATUS_MIRROR),
  }));

  return { ensurePresenceRuntimeStarted, refreshIdentity, refreshActivity, stopIdentityRuntime };
}

async function installExtension() {
  const { default: install } = await import('../../extensions/session-deck/index.js');
  const handlers = new Map<string, RegisteredHandler>();
  const pi = {
    on: vi.fn((event: string, handler: RegisteredHandler) => {
      handlers.set(event, handler);
    }),
  };
  await install(pi as never);
  return { handlers, pi };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'tui',
    hasUI: true,
    cwd: '/repo',
    model: { id: 'gpt-5', provider: 'openai' },
    getContextUsage: () => ({ percent: 12.5, contextWindow: 200_000 }),
    sessionManager: {
      getSessionId: () => 'session-1',
      getSessionFile: () => '/tmp/session-1.md',
      getEntries: () => [],
      getSessionName: () => 'Focused session',
      getCwd: () => '/repo',
      getHeader: () => ({
        id: 'session-1',
        timestamp: '2026-06-17T12:00:00.000Z',
        cwd: '/repo',
      }),
    },
    ui: { setStatus: vi.fn(), setFooter: vi.fn() },
    ...overrides,
  };
}

describe('pi-session-deck extension', () => {
  it('registers all hooks and starts presence runtime', async () => {
    setupMocks();
    const { pi } = await installExtension();

    expect(vi.mocked(pi.on).mock.calls.map((c) => c[0])).toEqual([
      'session_start',
      'message_end',
      'turn_start',
      'tool_execution_start',
      'tool_execution_end',
      'turn_end',
      'session_shutdown',
    ]);
  });

  it('installs setStatus mirror, refreshes identity/activity on session_start, does not touch setFooter', async () => {
    const { refreshIdentity, refreshActivity } = setupMocks();
    const { handlers } = await installExtension();

    const ctx = makeCtx();

    await handlers.get('session_start')?.({ reason: 'startup' }, ctx);
    await handlers.get('session_start')?.({ reason: 'new' }, ctx);

    expect(MOCK_STATUS_MIRROR.install).toHaveBeenCalledWith(ctx.ui);
    expect(MOCK_STATUS_MIRROR.reconfigure).toHaveBeenCalledWith({
      runtimeId: 'runtime-1',
      getSessionId: expect.any(Function),
    });

    expect(refreshIdentity).toHaveBeenNthCalledWith(1, 'startup', expect.any(Object));
    expect(refreshIdentity).toHaveBeenNthCalledWith(2, 'new', expect.any(Object));
    expect(refreshActivity).toHaveBeenNthCalledWith(1, 'startup', expect.any(Object));
    expect(refreshActivity).toHaveBeenNthCalledWith(2, 'new', expect.any(Object));

    expect(vi.mocked(ctx.ui.setFooter)).not.toHaveBeenCalled();
  });

  it.each(['startup', 'reload', 'new', 'resume', 'fork'] as const)(
    'preserves raw session_start reason %s when refreshing identity',
    async (reason) => {
      const { refreshIdentity, refreshActivity } = setupMocks();
      const { handlers } = await installExtension();

      await handlers.get('session_start')?.({ reason }, makeCtx());

      expect(refreshIdentity).toHaveBeenCalledWith(reason, expect.any(Object));
      expect(refreshActivity).toHaveBeenCalledWith(
        reason === 'new' ? 'new' : 'startup',
        expect.any(Object),
      );
    },
  );

  it('captures future raw session metadata for identity refresh, including headless mode', async () => {
    const { refreshIdentity, refreshActivity } = setupMocks();
    const { handlers } = await installExtension();

    const ctx = makeCtx({
      mode: 'json-stream',
      hasUI: false,
      sessionManager: {
        getSessionId: () => 'session-1',
        getSessionFile: () => '/tmp/session-1.md',
        getEntries: () => [],
        getSessionName: () => 'Focused session',
        getCwd: () => '/repo',
        getHeader: () => ({
          id: 'session-1',
          timestamp: '2026-06-17T12:00:00.000Z',
          cwd: '/repo',
          parentSession: '/tmp/session-parent.md',
        }),
      },
    });

    await handlers.get('session_start')?.(
      { reason: 'resume_from_handoff', previousSessionFile: '/tmp/session-previous.md' },
      ctx,
    );

    expect(refreshIdentity).toHaveBeenCalledWith('resume_from_handoff', expect.any(Object));
    expect(refreshActivity).toHaveBeenCalledWith('startup', expect.any(Object));

    const sessionManager = refreshIdentity.mock.calls[0]?.[1];
    expect(sessionManager.getSessionStart()).toEqual({
      reason: 'resume_from_handoff',
      previousSessionFile: '/tmp/session-previous.md',
      mode: 'json-stream',
      hasUI: false,
    });
    expect(sessionManager.getHeader()).toEqual({
      id: 'session-1',
      timestamp: '2026-06-17T12:00:00.000Z',
      cwd: '/repo',
      parentSession: '/tmp/session-parent.md',
    });
  });

  it('uses collected tmux terminal metadata for identity refresh when available', async () => {
    const tmuxTerminal = {
      kind: 'tmux' as const,
      socketPath: '/tmp/tmux/default',
      sessionName: 'prod',
      paneId: '%12',
    };
    const collectSessionTerminalMetadata = vi.fn().mockResolvedValue(tmuxTerminal);
    vi.doMock('../../extensions/session-deck/identity/terminal-collect.js', () => ({
      collectSessionTerminalMetadata,
    }));
    const { refreshIdentity } = setupMocks();
    const { handlers } = await installExtension();

    await handlers.get('session_start')?.({ reason: 'startup' }, makeCtx());

    const sessionManager = refreshIdentity.mock.calls[0]?.[1];
    expect(sessionManager.getTerminal?.()).toEqual(tmuxTerminal);
    expect(collectSessionTerminalMetadata).toHaveBeenCalledTimes(1);
  });

  it('captures iTerm2 terminal metadata for identity refresh when ITERM_SESSION_ID is set', async () => {
    await withTerminalEnv(
      {
        ITERM_SESSION_ID: '  w0t0p0:abc/def?x=1  ',
        TERM_PROGRAM: 'iTerm.app',
        LC_TERMINAL: 'iTerm2',
        LC_TERMINAL_VERSION: '3.6.11',
      },
      async () => {
        const { refreshIdentity } = setupMocks();
        const { handlers } = await installExtension();

        await handlers.get('session_start')?.({ reason: 'startup' }, makeCtx());

        const expectedTerminal = {
          kind: 'iterm2',
          sessionId: 'w0t0p0:abc/def?x=1',
          revealUrl: 'iterm2:///reveal?sessionid=w0t0p0%3Aabc%2Fdef%3Fx%3D1',
          termProgram: 'iTerm.app',
          lcTerminal: 'iTerm2',
          lcTerminalVersion: '3.6.11',
        };
        const sessionManager = refreshIdentity.mock.calls[0]?.[1];
        expect(sessionManager.getTerminal?.()).toEqual(expectedTerminal);

        process.env['ITERM_SESSION_ID'] = 'changed-after-session-start';
        expect(sessionManager.getTerminal?.()).toEqual(expectedTerminal);
      },
    );
  });

  it.each([
    ['missing ITERM_SESSION_ID', undefined],
    ['blank ITERM_SESSION_ID', ''],
    ['trimmed-empty ITERM_SESSION_ID', '   '],
  ] as const)('omits terminal metadata for %s', async (_name, itermSessionId) => {
    await withTerminalEnv(
      {
        ITERM_SESSION_ID: itermSessionId,
        TERM_SESSION_ID: 'not-an-iterm-fallback',
      },
      async () => {
        const { refreshIdentity } = setupMocks();
        const { handlers } = await installExtension();

        await handlers.get('session_start')?.({ reason: 'startup' }, makeCtx());

        const sessionManager = refreshIdentity.mock.calls[0]?.[1];
        expect(sessionManager.getTerminal?.()).toBeUndefined();
      },
    );
  });

  it('captures non-UUID iTerm2 session ids without regex validation', async () => {
    await withTerminalEnv({ ITERM_SESSION_ID: 'definitely-not-a-uuid' }, async () => {
      const { refreshIdentity } = setupMocks();
      const { handlers } = await installExtension();

      await handlers.get('session_start')?.({ reason: 'startup' }, makeCtx());

      const sessionManager = refreshIdentity.mock.calls[0]?.[1];
      expect(sessionManager.getTerminal?.()).toEqual({
        kind: 'iterm2',
        sessionId: 'definitely-not-a-uuid',
        revealUrl: 'iterm2:///reveal?sessionid=definitely-not-a-uuid',
      });
    });
  });

  it('clears tracked entries on session_shutdown', async () => {
    setupMocks();
    const { handlers } = await installExtension();

    MOCK_STATUS_MIRROR.clearTracked.mockClear();
    await handlers.get('session_shutdown')?.({}, {});

    expect(MOCK_STATUS_MIRROR.clearTracked).toHaveBeenCalledTimes(1);
  });

  it('surfaces degraded startup state through session-deck status', async () => {
    setupMocks(
      vi.fn().mockResolvedValue({
        runtime: { runtimeId: 'runtime-1', pid: 1234, startedAt: '2026-06-12T12:00:00.000Z' },
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
      }),
    );
    const { handlers } = await installExtension();

    const ctx = makeCtx();
    await handlers.get('session_start')?.({ reason: 'startup' }, ctx);

    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenCalledWith(
      'session-deck',
      'session-deck degraded: Failed to write presence record: permission denied',
    );
  });

  it('forwards runtime events into the activity runtime', async () => {
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

    setupMocks(undefined, undefined, vi.fn().mockResolvedValue(activityRuntime));
    const { handlers } = await installExtension();

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

  it('session_deck own status is set on session_start', async () => {
    setupMocks();
    const { handlers } = await installExtension();

    const ctx = makeCtx();
    await handlers.get('session_start')?.({ reason: 'startup' }, ctx);

    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenCalledWith('session-deck', undefined);
  });
});
