import { describe, expect, it, vi } from 'vitest';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  LIFECYCLE_HEARTBEAT_MS,
  installUiWrappers,
  isMeaningfulToolExecutionUpdate,
  lifecycleEligibility,
  registerJunctionLifecycle,
  restoreUiWrappers,
} from '../extensions/cmux-junction/lifecycle.js';
import {
  LIFECYCLE_TIMINGS,
  LIFECYCLE_UI_WAIT_KINDS,
  type LifecycleEvent,
  type LifecycleSnapshot,
} from '../extensions/cmux-junction/activity.js';
import type { ProcessRunner } from '../extensions/cmux-junction/process.js';

function context(overrides: Record<string, unknown> = {}) {
  let sessionId = 'session-a';
  const ui = {
    select: vi.fn(async () => 'choice'),
    input: vi.fn(async () => 'text'),
    editor: vi.fn(async () => 'edited'),
    confirm: vi.fn(async () => true),
    custom: vi.fn(async () => 'custom-result'),
    notify: vi.fn(),
  };
  return {
    value: {
      mode: 'tui',
      cwd: '/repo',
      isIdle: () => true,
      isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => sessionId },
      ui,
      ...overrides,
    } as unknown as ExtensionContext & { mode: string },
    ui,
    setSessionId(value: string) {
      sessionId = value;
    },
  };
}

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CMUX_SOCKET_PATH: '/tmp/cmux.sock',
    CMUX_WORKSPACE_ID: 'workspace-a',
    CMUX_SURFACE_ID: 'surface-a',
    ...overrides,
  };
}

function harness(
  options: {
    loadConfig?: (cwd: string, projectTrusted: boolean) => { disableStatus: boolean };
    contextOverrides?: Record<string, unknown>;
  } = {},
) {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const pi = {
    on: vi.fn((name: string, handler: (event: any, ctx: any) => unknown) =>
      handlers.set(name, handler),
    ),
  } as unknown as ExtensionAPI;
  const snapshots: Array<{ operation: string; snapshot?: LifecycleSnapshot; session?: string }> =
    [];
  let clientSession = 'session-a';
  const client = {
    start: vi.fn(async (snapshot: LifecycleSnapshot) => {
      snapshots.push({ operation: 'start', snapshot });
      return true;
    }),
    snapshot: vi.fn(async (snapshot: LifecycleSnapshot) => {
      snapshots.push({ operation: 'snapshot', snapshot, session: clientSession });
      return true;
    }),
    changeSession: vi.fn(async (session: string) => {
      clientSession = session;
      snapshots.push({ operation: 'session', session });
    }),
    goodbye: vi.fn(async () => {
      snapshots.push({ operation: 'goodbye' });
      return true;
    }),
  };
  const intervals: Array<{ callback: () => void; delay: number }> = [];
  const ctx = context(options.contextOverrides);
  const loadConfig = options.loadConfig ?? vi.fn(() => ({ disableStatus: false }));
  const createClient = vi.fn(() => client);
  const resolveTarget = vi.fn(async (_cwd: string, target: any) => ({
    ok: true as const,
    socketPath: target.socketPath,
    workspaceId: target.workspaceId,
    surfaceId: target.surfaceId,
  }));
  const observeProcessStart = vi.fn(async () => 1_699_999_000_000);
  const clearInterval = vi.fn();
  let now = 1_700_000_000_000;
  registerJunctionLifecycle(pi, {
    env: env(),
    loadConfig,
    now: () => now,
    runtimeId: () => 'runtime-a',
    pid: 4321,
    observeProcessStart,
    createClient,
    resolveTarget,
    setInterval: ((callback: () => void, delay: number) => {
      const timer = { callback, delay };
      intervals.push(timer);
      return timer as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearInterval,
  });
  const emit = async (name: string, event: Record<string, unknown> = {}, custom = ctx.value) => {
    await handlers.get(name)?.({ type: name, ...event }, custom);
  };
  return {
    handlers,
    snapshots,
    client,
    intervals,
    ctx,
    emit,
    loadConfig,
    createClient,
    resolveTarget,
    observeProcessStart,
    clearInterval,
    setNow: (value: number) => (now = value),
  };
}

describe('lifecycle eligibility', () => {
  it('requires exact public TUI and inherited identity inputs', () => {
    const ctx = context().value;
    expect(lifecycleEligibility(ctx, env())).toMatchObject({
      eligible: true,
      target: {
        socketPath: '/tmp/cmux.sock',
        workspaceId: 'workspace-a',
        surfaceId: 'surface-a',
      },
      sessionId: 'session-a',
    });
  });

  it.each([
    ['mode', { mode: 'rpc' }, env()],
    ['socket', {}, env({ CMUX_SOCKET_PATH: ' ' })],
    ['workspace', {}, env({ CMUX_WORKSPACE_ID: '' })],
    ['surface', {}, env({ CMUX_SURFACE_ID: '\0bad' })],
  ])('is inert for %s', (reason, ctxOverrides, environment) => {
    expect(lifecycleEligibility(context(ctxOverrides).value, environment)).toEqual({
      eligible: false,
      reason,
    });
  });

  it('is inert when settings disable status', () => {
    expect(lifecycleEligibility(context().value, env(), true)).toEqual({
      eligible: false,
      reason: 'disabled',
    });
  });

  it.each([{ CI: 'true' }, { UNRELATED_SETTING: '1' }])(
    'allows a valid TUI session with unrelated environment values',
    (environment) => {
      expect(lifecycleEligibility(context().value, env(environment))).toMatchObject({
        eligible: true,
        reason: 'eligible',
      });
    },
  );

  it('is inert without a real nonblank Pi session id', () => {
    const ctx = context({ sessionManager: { getSessionId: () => ' ' } }).value;
    expect(lifecycleEligibility(ctx, env())).toEqual({ eligible: false, reason: 'session' });
  });
});

describe('meaningful tool update boundary', () => {
  it.each([
    [undefined, false],
    [null, false],
    [false, false],
    ['', false],
    ['   ', false],
    [[], false],
    [['progress'], false],
    [{}, false],
    [{ content: '' }, false],
    [{ content: [] }, false],
    [{ content: [{ type: 'text', text: ' ' }] }, false],
    [{ content: [{ type: 'image', url: '' }] }, false],
    [{ details: { nested: [] } }, false],
    [{ complete: false }, false],
    ['progress', true],
    [0, true],
    [{ content: 'output' }, true],
    [{ content: [{ type: 'text', text: 'output' }] }, true],
    [{ content: [{ type: 'image_url', url: 'data:image/png' }] }, true],
    [{ details: { count: 0 } }, true],
    [{ completed: true }, true],
    [{ done: true }, true],
  ])('classifies %j as meaningful=%s', (partialResult, expected) => {
    expect(isMeaningfulToolExecutionUpdate(partialResult)).toBe(expected);
  });
});

describe('Pi lifecycle adapter', () => {
  it('loads config with the exact cwd and trust state before disabled startup work', async () => {
    const loadConfig = vi.fn(() => ({ disableStatus: true }));
    const h = harness({
      loadConfig,
      contextOverrides: {
        cwd: '/untrusted/repo',
        isProjectTrusted: () => false,
      },
    });
    const originalUi = { ...h.ctx.ui };

    await h.emit('session_start');

    expect(loadConfig).toHaveBeenCalledExactlyOnceWith('/untrusted/repo', false);
    expect(h.resolveTarget).not.toHaveBeenCalled();
    expect(h.observeProcessStart).not.toHaveBeenCalled();
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.ctx.ui).toEqual(originalUi);
    expect(h.intervals).toEqual([]);
  });

  it('shuts down an enabled runtime before staying disabled without a replacement', async () => {
    const loadConfig = vi
      .fn()
      .mockReturnValueOnce({ disableStatus: false })
      .mockReturnValueOnce({ disableStatus: true });
    const h = harness({ loadConfig });
    const originalInput = h.ctx.ui.input;

    await h.emit('session_start');
    expect(h.ctx.ui.input).not.toBe(originalInput);

    await h.emit('session_start');

    expect(h.client.goodbye).toHaveBeenCalledOnce();
    expect(h.ctx.ui.input).toBe(originalInput);
    expect(h.clearInterval).toHaveBeenCalledTimes(2);
    expect(h.createClient).toHaveBeenCalledOnce();
    expect(h.client.start).toHaveBeenCalledOnce();
    expect(h.intervals).toHaveLength(2);
  });

  it('starts normally when a disabled session becomes enabled', async () => {
    const loadConfig = vi
      .fn()
      .mockReturnValueOnce({ disableStatus: true })
      .mockReturnValueOnce({ disableStatus: false });
    const h = harness({ loadConfig });
    const originalInput = h.ctx.ui.input;

    await h.emit('session_start');
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.ctx.ui.input).toBe(originalInput);

    await h.emit('session_start');

    expect(h.resolveTarget).toHaveBeenCalledOnce();
    expect(h.observeProcessStart).toHaveBeenCalledOnce();
    expect(h.createClient).toHaveBeenCalledOnce();
    expect(h.client.start).toHaveBeenCalledOnce();
    expect(h.ctx.ui.input).not.toBe(originalInput);
    expect(h.intervals).toHaveLength(2);
  });

  it('resolves a stale workspace before coordinator selection', async () => {
    const handlers = new Map<string, Function>();
    const sequence: string[] = [];
    const pi = {
      on: (name: string, handler: Function) => handlers.set(name, handler),
    } as any;
    const client = {
      start: vi.fn(async () => true),
      snapshot: vi.fn(async () => true),
      changeSession: vi.fn(async () => undefined),
      goodbye: vi.fn(async () => true),
    };
    const runner: ProcessRunner = async (_file, args, options) => {
      sequence.push('resolve');
      expect(options.shell).toBe(false);
      expect(args).toEqual([
        '--socket',
        '/tmp/cmux.sock',
        'rpc',
        'agent.resolve_delivery_target',
        '{"surface_id":"surface-a","workspace_id":"workspace-stale"}',
      ]);
      return {
        outcome: 'exit',
        stdout: JSON.stringify({
          source: 'surface',
          workspace_id: 'workspace-live',
          surface_id: 'surface-a',
        }),
        stderr: '',
        exitCode: 0,
      };
    };
    let selectedTarget: unknown;
    registerJunctionLifecycle(pi, {
      env: env({
        CMUX_SOCKET_PATH: '  /tmp/cmux.sock  ',
        CMUX_WORKSPACE_ID: 'workspace-stale',
      }),
      loadConfig: () => ({ disableStatus: false }),
      runner,
      runtimeId: () => 'runtime-a',
      pid: 4321,
      observeProcessStart: async () => 1_699_999_000_000,
      createClient: (options) => {
        sequence.push('select');
        selectedTarget = options.target;
        return client;
      },
      setInterval: (() => ({}) as ReturnType<typeof setInterval>) as typeof setInterval,
      clearInterval: vi.fn(),
    });

    await handlers.get('session_start')?.({}, context().value);

    expect(sequence).toEqual(['resolve', 'select']);
    expect(selectedTarget).toEqual({
      socketPath: '/tmp/cmux.sock',
      workspaceId: 'workspace-live',
      surfaceId: 'surface-a',
    });
  });

  it('restores UI wrappers through adapter shutdown before reinstalling them', async () => {
    const h = harness();
    const ui = h.ctx.ui as any;
    const releases: Array<(value: string) => void> = [];
    const originalInput = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releases.push(resolve);
        }),
    );
    ui.input = originalInput;

    await h.emit('session_start');
    const firstWrapper = ui.input;
    const firstCall = ui.input('first');
    await h.emit('session_shutdown');

    expect(h.snapshots.some((entry) => entry.snapshot?.state === 'awaiting-input')).toBe(true);
    expect(ui.input).toBe(originalInput);

    await h.emit('session_start');
    const secondWrapper = ui.input;
    expect(secondWrapper).not.toBe(originalInput);
    expect(secondWrapper).not.toBe(firstWrapper);

    const snapshotsBeforeFirstRelease = h.snapshots.length;
    releases[0]?.('first');
    await expect(firstCall).resolves.toBe('first');
    expect(h.snapshots).toHaveLength(snapshotsBeforeFirstRelease);
    expect(ui.input).toBe(secondWrapper);

    const secondCall = ui.input('second');
    expect(releases).toHaveLength(2);
    releases[1]?.('second');
    await expect(secondCall).resolves.toBe('second');
  });

  it('keeps lifecycle disabled when target resolution fails', async () => {
    const handlers = new Map<string, Function>();
    const pi = { on: (name: string, handler: Function) => handlers.set(name, handler) } as any;
    const createClient = vi.fn();
    const runner: ProcessRunner = async () => ({
      outcome: 'exit',
      stdout: '',
      stderr: 'not found',
      exitCode: 1,
    });
    registerJunctionLifecycle(pi, {
      env: env(),
      loadConfig: () => ({ disableStatus: false }),
      runner,
      createClient,
      observeProcessStart: vi.fn(async () => 1_699_999_000_000),
    });

    await expect(handlers.get('session_start')?.({}, context().value)).resolves.toBeUndefined();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('maps public events in serialized order and settles only on the real idle event', async () => {
    const h = harness();
    await h.emit('session_start', { reason: 'startup' });
    await h.emit('input', { text: 'private prompt', source: 'interactive' });
    await h.emit('message_end', { message: { role: 'user', content: 'private message' } });
    await h.emit('turn_start', { turnIndex: 0, timestamp: 1_700_000_000_001 });
    await h.emit('tool_execution_start', {
      toolCallId: 'tool-1',
      toolName: 'bash',
      args: { command: 'secret' },
    });
    await h.emit('tool_execution_update', {
      toolCallId: 'tool-1',
      partialResult: { content: 'secret output' },
    });
    await h.emit('tool_execution_end', {
      toolCallId: 'tool-1',
      result: { content: 'secret result' },
    });
    await h.emit('turn_end', { turnIndex: 0, message: { content: 'private' }, toolResults: [] });
    await h.emit('agent_settled', {}, { ...h.ctx.value, isIdle: () => false } as any);

    expect(h.snapshots.map((entry) => entry.snapshot?.state).filter(Boolean)).toEqual([
      'idle',
      'thinking',
      'tool-running',
      'tool-running',
      'thinking',
      'unknown',
    ]);

    await h.emit('agent_settled');
    expect(h.snapshots.at(-1)?.snapshot?.state).toBe('idle');
    const retained = JSON.stringify(h.snapshots);
    for (const secret of [
      'private prompt',
      'private message',
      'secret',
      'secret output',
      'secret result',
    ]) {
      expect(retained).not.toContain(secret);
    }
  });

  it('tracks a deferred custom wait through real settlement', async () => {
    const h = harness();
    let release!: (value: string) => void;
    const originalCustom = vi.fn(function (_factory: unknown, _options: unknown) {
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });
    (h.ctx.ui as any).custom = originalCustom;

    await h.emit('session_start');
    await h.emit('turn_start', { turnIndex: 0 });
    await h.emit('turn_end', { turnIndex: 0 });
    const factory = vi.fn();
    const options = { overlay: true };
    const customCall = (h.ctx.ui as any).custom(factory, options);
    const states = () => h.snapshots.map((entry) => entry.snapshot?.state).filter(Boolean);

    await vi.waitFor(() =>
      expect(states()).toEqual(['idle', 'thinking', 'unknown', 'awaiting-input']),
    );

    release('custom-result');
    await expect(customCall).resolves.toBe('custom-result');
    await vi.waitFor(() =>
      expect(states()).toEqual(['idle', 'thinking', 'unknown', 'awaiting-input', 'unknown']),
    );

    await h.emit('agent_settled');
    expect(states()).toEqual(['idle', 'thinking', 'unknown', 'awaiting-input', 'unknown', 'idle']);
  });

  it('starts a fresh turn-index fence for each prompt and compaction retry run', async () => {
    const h = harness();
    await h.emit('session_start');
    await h.emit('agent_start');
    await h.emit('turn_start', { turnIndex: 0 });
    await h.emit('turn_end', { turnIndex: 0 });
    await h.emit('agent_settled');

    await h.emit('agent_start');
    await h.emit('turn_start', { turnIndex: 0 });
    expect(h.snapshots.at(-1)?.snapshot?.state).toBe('thinking');
    await h.emit('turn_end', { turnIndex: 0 });
    await h.emit('session_before_compact', {
      reason: 'overflow',
      willRetry: true,
      signal: new AbortController().signal,
    });
    await h.emit('session_compact');
    await h.emit('agent_start');
    await h.emit('turn_start', { turnIndex: 0 });
    expect(h.snapshots.at(-1)?.snapshot?.state).toBe('thinking');
  });

  it('does not let no-op tool updates refresh stuck-tool evidence', async () => {
    const h = harness();
    const startedAt = 1_700_000_000_000;
    await h.emit('session_start');
    await h.emit('agent_start');
    await h.emit('turn_start', { turnIndex: 0, timestamp: startedAt });
    await h.emit('tool_execution_start', { toolCallId: 'tool-1', toolName: 'bash' });

    h.setNow(startedAt + LIFECYCLE_TIMINGS.toolStuckAfterMs + 1);
    for (const partialResult of [null, false, '', [], {}, { content: [] }]) {
      await h.emit('tool_execution_update', { toolCallId: 'tool-1', partialResult });
    }
    const maintenance = h.intervals.find(
      ({ delay }) => delay === LIFECYCLE_TIMINGS.maintenanceIntervalMs,
    )!;
    maintenance.callback();
    await vi.waitFor(() => expect(h.snapshots.at(-1)?.snapshot?.state).toBe('unknown'));
  });

  it('closes the compaction abort race while registration is queued', async () => {
    const h = harness();
    await h.emit('session_start');
    const controller = new AbortController();
    const registration = h.emit('session_before_compact', {
      reason: 'manual',
      signal: controller.signal,
    });
    controller.abort();
    await registration;
    expect(h.snapshots.map((entry) => entry.snapshot?.state).filter(Boolean)).toEqual([
      'idle',
      'compacting',
      'idle',
    ]);
  });

  it('ignores an already-aborted compaction without clearing the active generation', async () => {
    const h = harness();
    await h.emit('session_start');
    await h.emit('session_before_compact', {
      reason: 'threshold',
      signal: new AbortController().signal,
    });
    const aborted = new AbortController();
    aborted.abort();
    await h.emit('session_before_compact', { reason: 'manual', signal: aborted.signal });
    expect(h.snapshots.at(-1)?.snapshot?.state).toBe('compacting');
    expect(h.snapshots).toHaveLength(2);
  });

  it('maps assistant errors and compaction without retaining raw errors or content', async () => {
    const h = harness();
    await h.emit('session_start');
    await h.emit('message_end', {
      message: { role: 'assistant', stopReason: 'error', errorMessage: 'private stack' },
    });
    expect(h.snapshots.at(-1)?.snapshot?.state).toBe('error');

    const controller = new AbortController();
    await h.emit('session_before_compact', {
      reason: 'threshold',
      willRetry: true,
      signal: controller.signal,
      preparation: { content: 'private summary' },
    });
    expect(h.snapshots.at(-1)?.snapshot?.state).toBe('compacting');
    controller.abort('private abort');
    await Promise.resolve();
    await Promise.resolve();
    expect(h.snapshots.at(-1)?.snapshot?.state).toBe('error');

    await h.emit('turn_start', { turnIndex: 1, timestamp: 1_700_000_000_002 });
    expect(h.snapshots.at(-1)?.snapshot?.state).toBe('thinking');
    expect(JSON.stringify(h.snapshots)).not.toContain('private');
  });

  it('runs 30-second maintenance, 10-second full heartbeats, and resets on session change', async () => {
    const h = harness();
    await h.emit('session_start');
    expect(h.intervals.map(({ delay }) => delay).sort()).toEqual([
      LIFECYCLE_HEARTBEAT_MS,
      LIFECYCLE_TIMINGS.maintenanceIntervalMs,
    ]);
    const heartbeat = h.intervals.find(({ delay }) => delay === LIFECYCLE_HEARTBEAT_MS)!;
    heartbeat.callback();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.client.snapshot).toHaveBeenCalled();

    h.ctx.setSessionId('session-b');
    const maintenance = h.intervals.find(
      ({ delay }) => delay === LIFECYCLE_TIMINGS.maintenanceIntervalMs,
    )!;
    const rolloverStart = h.snapshots.length;
    maintenance.callback();
    await vi.waitFor(() =>
      expect(
        h.snapshots.slice(rolloverStart).map(({ operation, session }) => ({ operation, session })),
      ).toEqual([
        { operation: 'session', session: 'session-b' },
        { operation: 'snapshot', session: 'session-b' },
      ]),
    );
    expect(h.client.changeSession).toHaveBeenCalledWith('session-b');
    expect(h.snapshots.at(-1)?.snapshot?.state).toBe('idle');
  });

  it('closes intake and sends goodbye after every queued lifecycle delivery', async () => {
    const h = harness();
    await h.emit('session_start');
    const turn = h.emit('turn_start', { turnIndex: 0, timestamp: 1_700_000_000_001 });
    const shutdown = h.emit('session_shutdown', { reason: 'quit' });
    await Promise.all([turn, shutdown]);
    expect(h.snapshots.at(-1)?.operation).toBe('goodbye');
    const count = h.snapshots.length;
    await h.emit('turn_start', { turnIndex: 1, timestamp: 1_700_000_000_002 });
    expect(h.snapshots).toHaveLength(count);
  });

  it('joins overlapping shutdown events to the same goodbye', async () => {
    const h = harness();
    let releaseGoodbye!: () => void;
    h.client.goodbye.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseGoodbye = () => resolve(true);
        }),
    );
    await h.emit('session_start');

    let firstSettled = false;
    let secondSettled = false;
    const first = h.emit('session_shutdown').then(() => {
      firstSettled = true;
    });
    await vi.waitFor(() => expect(h.client.goodbye).toHaveBeenCalledOnce());
    const second = h.emit('session_shutdown').then(() => {
      secondSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);
    expect(h.client.goodbye).toHaveBeenCalledOnce();

    releaseGoodbye();
    await Promise.all([first, second]);
    expect(h.client.goodbye).toHaveBeenCalledOnce();
  });

  it('fails open when process identity or delivery setup fails', async () => {
    const handlers = new Map<string, Function>();
    const pi = { on: (name: string, handler: Function) => handlers.set(name, handler) } as any;
    registerJunctionLifecycle(pi, {
      env: env(),
      loadConfig: () => ({ disableStatus: false }),
      resolveTarget: async (_cwd, target) => ({
        ok: true,
        socketPath: target.socketPath,
        workspaceId: target.workspaceId,
        surfaceId: target.surfaceId,
      }),
      observeProcessStart: async () => null,
      createClient: () => {
        throw new Error('must not run');
      },
    });
    await expect(handlers.get('session_start')?.({}, context().value)).resolves.toBeUndefined();
  });
});

describe('UI wait wrappers', () => {
  it.each(LIFECYCLE_UI_WAIT_KINDS)(
    'wraps %s with ordered start/end and restores the owned method',
    async (kind) => {
      const ui = context().ui as any;
      const calls: LifecycleEvent[] = [];
      const original = ui[kind];
      const installation = installUiWrappers(ui, async (event) => {
        calls.push(event);
      });
      const wrapper = ui[kind];
      expect(installUiWrappers(ui, async () => undefined)).toBe(installation);
      const args =
        kind === 'custom'
          ? [vi.fn(), { overlay: true }]
          : ['title', kind === 'confirm' ? 'message' : undefined];
      await wrapper.call(ui, ...args);
      expect(calls.map((event) => event.type)).toEqual(['ui_wait_start', 'ui_wait_end']);
      expect(calls[0]).toMatchObject({
        type: 'ui_wait_start',
        waitId: `junction-${kind}-1`,
        kind,
      });
      expect(calls[1]).toMatchObject({ type: 'ui_wait_end', waitId: `junction-${kind}-1` });
      restoreUiWrappers(ui, installation);
      expect(ui[kind]).toBe(original);
    },
  );

  it('keeps a deferred custom wait open and restores the original method', async () => {
    const ui = context().ui as any;
    const factory = vi.fn();
    const options = { overlay: true, overlayOptions: { width: 40 } };
    const result = 'custom-result';
    let release!: (value: string) => void;
    const original = vi.fn(function (
      this: unknown,
      actualFactory: unknown,
      actualOptions: unknown,
    ) {
      expect(this).toBe(ui);
      expect(actualFactory).toBe(factory);
      expect(actualOptions).toBe(options);
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });
    ui.custom = original;
    const calls: LifecycleEvent[] = [];
    const installation = installUiWrappers(ui, async (event) => {
      calls.push(event);
    });

    const pending = ui.custom(factory, options);
    expect(calls).toEqual([{ type: 'ui_wait_start', waitId: 'junction-custom-1', kind: 'custom' }]);
    expect(original).toHaveBeenCalledExactlyOnceWith(factory, options);
    expect(calls).toHaveLength(1);

    release(result);
    await expect(pending).resolves.toBe(result);
    expect(calls).toEqual([
      { type: 'ui_wait_start', waitId: 'junction-custom-1', kind: 'custom' },
      { type: 'ui_wait_end', waitId: 'junction-custom-1' },
    ]);

    restoreUiWrappers(ui, installation);
    expect(ui.custom).toBe(original);
  });

  it('ends waits in finally and does not overwrite a later wrapper during restoration', async () => {
    const ui = context().ui as any;
    const rejected = new Error('private rejection');
    ui.input = vi.fn(async () => {
      throw rejected;
    });
    const calls: LifecycleEvent[] = [];
    const installation = installUiWrappers(ui, async (event) => {
      calls.push(event);
    });
    await expect(ui.input('title')).rejects.toBe(rejected);
    expect(calls.map((event) => event.type)).toEqual(['ui_wait_start', 'ui_wait_end']);
    expect(calls[0]).toMatchObject({ type: 'ui_wait_start', waitId: 'junction-input-1' });
    expect(calls[1]).toMatchObject({ type: 'ui_wait_end', waitId: 'junction-input-1' });

    const later = vi.fn();
    ui.input = later;
    restoreUiWrappers(ui, installation);
    expect(ui.input).toBe(later);
  });
});
