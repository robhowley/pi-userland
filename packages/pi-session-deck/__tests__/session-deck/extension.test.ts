import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../extensions/session-deck/identity/runtime-signals.js');
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

type DeckEnvKey =
  | 'PI_SESSION_DECK_RUNTIME_ID'
  | 'PI_SESSION_DECK_SESSION_ID'
  | 'PI_SESSION_DECK_SESSION_FILE'
  | 'PI_SESSION_DECK_RUNTIME_STARTED_AT';

const TERMINAL_ENV_KEYS: TerminalEnvKey[] = [
  'ITERM_SESSION_ID',
  'TERM_SESSION_ID',
  'TERM_PROGRAM',
  'LC_TERMINAL',
  'LC_TERMINAL_VERSION',
  'TMUX',
  'TMUX_PANE',
];

const DECK_ENV_KEYS: DeckEnvKey[] = [
  'PI_SESSION_DECK_RUNTIME_ID',
  'PI_SESSION_DECK_SESSION_ID',
  'PI_SESSION_DECK_SESSION_FILE',
  'PI_SESSION_DECK_RUNTIME_STARTED_AT',
];

async function withManagedEnv(
  keys: readonly string[],
  overrides: Partial<Record<string, string | undefined>>,
  run: () => Promise<void>,
): Promise<void> {
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]])) as Partial<
    Record<string, string>
  >;

  for (const key of keys) {
    delete process.env[key];
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await run();
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function withTerminalEnv(
  overrides: Partial<Record<TerminalEnvKey, string | undefined>>,
  run: () => Promise<void>,
): Promise<void> {
  await withManagedEnv(TERMINAL_ENV_KEYS, overrides, run);
}

async function withDeckEnv(
  overrides: Partial<Record<DeckEnvKey, string | undefined>>,
  run: () => Promise<void>,
): Promise<void> {
  await withManagedEnv(DECK_ENV_KEYS, overrides, run);
}

function setupMocks(
  presenceMock?: unknown,
  identityMock?: unknown,
  activityMock?: unknown,
  runtimeSignalsMock?: unknown,
) {
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
      recordInputSource: vi.fn().mockResolvedValue(undefined),
      recordMessageEnd: vi.fn().mockResolvedValue(undefined),
      recordTurnStart: vi.fn().mockResolvedValue(undefined),
      recordToolExecutionStart: vi.fn().mockResolvedValue(undefined),
      recordToolExecutionEnd: vi.fn().mockResolvedValue(undefined),
      recordTurnEnd: vi.fn().mockResolvedValue(undefined),
      recordCompactionStart: vi.fn().mockResolvedValue(undefined),
      clearCompaction: vi.fn().mockResolvedValue(undefined),
      getActivity: vi.fn().mockReturnValue(null),
      isRunning: vi.fn(() => true),
    });

  const collectRuntimeSignalsMetadata =
    runtimeSignalsMock ??
    vi.fn().mockResolvedValue({
      process: { pid: 1234, ppid: 4321, ancestors: [] },
      launch: {
        noSession: false,
        print: false,
        mode: 'tui',
        sessionArgPresent: false,
        forkArgPresent: false,
      },
      stdio: {
        stdinTTY: false,
        stdoutTTY: false,
        stderrTTY: false,
      },
    });

  const stopIdentityRuntime = vi.fn().mockResolvedValue(undefined);
  const stopActivityRuntime = vi.fn().mockResolvedValue(undefined);

  vi.doMock('../../extensions/session-deck/presence/runtime.js', () => ({
    ensurePresenceRuntimeStarted,
  }));
  vi.doMock('../../extensions/session-deck/identity/runtime.js', () => ({
    ensureIdentityRuntimeStarted: identityRuntime,
    stopIdentityRuntime,
  }));
  vi.doMock('../../extensions/session-deck/activity/runtime.js', () => ({
    ensureActivityRuntimeStarted: activityRuntime,
    stopActivityRuntime,
  }));
  vi.doMock('../../extensions/session-deck/identity/runtime-signals.js', async () => {
    const actual = await vi.importActual<
      typeof import('../../extensions/session-deck/identity/runtime-signals.js')
    >('../../extensions/session-deck/identity/runtime-signals.js');
    return {
      ...actual,
      collectRuntimeSignalsMetadata,
    };
  });
  vi.doMock('../../extensions/session-deck/identity/command.js', () => ({
    registerSessionDeckCommand: vi.fn(),
  }));
  vi.doMock('../../extensions/session-deck/chips/mirror.js', () => ({
    createSetStatusMirror: vi.fn(() => MOCK_STATUS_MIRROR),
  }));

  return {
    ensurePresenceRuntimeStarted,
    refreshIdentity,
    refreshActivity,
    collectRuntimeSignalsMetadata,
    stopIdentityRuntime,
    stopActivityRuntime,
  };
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
      'input',
      'message_end',
      'turn_start',
      'tool_execution_start',
      'tool_execution_end',
      'turn_end',
      'session_before_compact',
      'session_compact',
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

  it('wires runtime signals into identity refresh and publishes current deck env after capturing inherited values', async () => {
    await withDeckEnv(
      {
        PI_SESSION_DECK_RUNTIME_ID: 'parent-runtime',
        PI_SESSION_DECK_SESSION_ID: 'parent-session',
        PI_SESSION_DECK_SESSION_FILE: '/tmp/parent-session.md',
        PI_SESSION_DECK_RUNTIME_STARTED_AT: '2026-06-17T11:55:00.000Z',
      },
      async () => {
        const collectRuntimeSignalsMetadata = vi.fn().mockImplementation(async () => ({
          process: { pid: 1234, ppid: 4321, ancestors: [] },
          launch: {
            noSession: false,
            print: false,
            mode: 'tui',
            sessionArgPresent: false,
            forkArgPresent: false,
          },
          stdio: {
            stdinTTY: false,
            stdoutTTY: false,
            stderrTTY: false,
          },
          inheritedDeckRuntime: {
            runtimeId: process.env['PI_SESSION_DECK_RUNTIME_ID'],
            sessionId: process.env['PI_SESSION_DECK_SESSION_ID'],
            sessionFile: process.env['PI_SESSION_DECK_SESSION_FILE'],
            startedAt: process.env['PI_SESSION_DECK_RUNTIME_STARTED_AT'],
          },
        }));
        const { refreshIdentity } = setupMocks(
          undefined,
          undefined,
          undefined,
          collectRuntimeSignalsMetadata,
        );
        const { handlers } = await installExtension();

        await handlers.get('session_start')?.({ reason: 'startup' }, makeCtx());

        const sessionManager = refreshIdentity.mock.calls[0]?.[1];
        expect(sessionManager.getRuntimeSignals?.()).toEqual({
          process: { pid: 1234, ppid: 4321, ancestors: [] },
          launch: {
            noSession: false,
            print: false,
            mode: 'tui',
            sessionArgPresent: false,
            forkArgPresent: false,
          },
          stdio: {
            stdinTTY: false,
            stdoutTTY: false,
            stderrTTY: false,
          },
          inheritedDeckRuntime: {
            runtimeId: 'parent-runtime',
            sessionId: 'parent-session',
            sessionFile: '/tmp/parent-session.md',
            startedAt: '2026-06-17T11:55:00.000Z',
          },
        });
        expect(process.env['PI_SESSION_DECK_RUNTIME_ID']).toBe('runtime-1');
        expect(process.env['PI_SESSION_DECK_SESSION_ID']).toBe('session-1');
        expect(process.env['PI_SESSION_DECK_SESSION_FILE']).toBe('/tmp/session-1.md');
        expect(process.env['PI_SESSION_DECK_RUNTIME_STARTED_AT']).toBe('2026-06-12T12:00:00.000Z');
      },
    );
  });

  it('unsets the deck session file env when the current runtime has no session file', async () => {
    await withDeckEnv(
      {
        PI_SESSION_DECK_SESSION_FILE: '/tmp/parent-session.md',
      },
      async () => {
        setupMocks();
        const { handlers } = await installExtension();

        await handlers.get('session_start')?.(
          { reason: 'startup' },
          makeCtx({
            sessionManager: {
              getSessionId: () => 'session-1',
              getSessionFile: () => null,
              getEntries: () => [],
              getSessionName: () => 'Focused session',
              getCwd: () => '/repo',
              getHeader: () => ({
                id: 'session-1',
                timestamp: '2026-06-17T12:00:00.000Z',
                cwd: '/repo',
              }),
            },
          }),
        );

        expect(process.env).not.toHaveProperty('PI_SESSION_DECK_SESSION_FILE');
      },
    );
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

  it('clears compaction and tracked entries on session_shutdown', async () => {
    const activityRuntime = {
      refreshActivity: vi.fn().mockResolvedValue(undefined),
      recordInputSource: vi.fn().mockResolvedValue(undefined),
      recordMessageEnd: vi.fn().mockResolvedValue(undefined),
      recordTurnStart: vi.fn().mockResolvedValue(undefined),
      recordToolExecutionStart: vi.fn().mockResolvedValue(undefined),
      recordToolExecutionEnd: vi.fn().mockResolvedValue(undefined),
      recordTurnEnd: vi.fn().mockResolvedValue(undefined),
      recordCompactionStart: vi.fn().mockResolvedValue(undefined),
      clearCompaction: vi.fn().mockResolvedValue(undefined),
      getActivity: vi.fn().mockReturnValue(null),
      isRunning: vi.fn(() => true),
    };
    const { stopActivityRuntime } = setupMocks(
      undefined,
      undefined,
      vi.fn().mockResolvedValue(activityRuntime),
    );
    const { handlers } = await installExtension();

    MOCK_STATUS_MIRROR.clearTracked.mockClear();
    await handlers.get('session_shutdown')?.({}, {});

    expect(activityRuntime.clearCompaction).toHaveBeenCalledWith('shutdown');
    expect(MOCK_STATUS_MIRROR.clearTracked).toHaveBeenCalledTimes(1);
    expect(stopActivityRuntime).toHaveBeenCalledTimes(1);
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
      recordInputSource: vi.fn().mockResolvedValue(undefined),
      recordMessageEnd: vi.fn().mockResolvedValue(undefined),
      recordTurnStart: vi.fn().mockResolvedValue(undefined),
      recordToolExecutionStart: vi.fn().mockResolvedValue(undefined),
      recordToolExecutionEnd: vi.fn().mockResolvedValue(undefined),
      recordTurnEnd: vi.fn().mockResolvedValue(undefined),
      recordCompactionStart: vi.fn().mockResolvedValue(undefined),
      clearCompaction: vi.fn().mockResolvedValue(undefined),
      getActivity: vi.fn().mockReturnValue(null),
      isRunning: vi.fn(() => true),
    };

    setupMocks(undefined, undefined, vi.fn().mockResolvedValue(activityRuntime));
    const { handlers } = await installExtension();

    await handlers.get('input')?.({ source: 'extension', text: 'do not persist me' }, {});
    await handlers.get('input')?.({ source: 'unknown', text: 'ignored' }, {});
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
    const signal = new AbortController().signal;
    await handlers.get('turn_end')?.({}, {});
    await handlers.get('session_before_compact')?.(
      { reason: 'threshold', willRetry: true, signal },
      {},
    );
    await handlers.get('session_compact')?.({ reason: 'threshold', willRetry: true }, {});

    expect(activityRuntime.recordInputSource).toHaveBeenCalledWith('extension');
    expect(activityRuntime.recordInputSource).toHaveBeenCalledTimes(1);
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
    expect(activityRuntime.recordCompactionStart).toHaveBeenCalledWith({
      reason: 'threshold',
      willRetry: true,
      signal,
    });
    expect(activityRuntime.clearCompaction).toHaveBeenCalledWith('completed');
  });

  it('session_deck own status is set on session_start', async () => {
    setupMocks();
    const { handlers } = await installExtension();

    const ctx = makeCtx();
    await handlers.get('session_start')?.({ reason: 'startup' }, ctx);

    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenCalledWith('session-deck', undefined);
  });
});
