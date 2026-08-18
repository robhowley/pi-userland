import { describe, expect, it, vi } from 'vitest';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  LIFECYCLE_DISABLED_ENV,
  LIFECYCLE_HEARTBEAT_MS,
  installUiWrappers,
  lifecycleEligibility,
  registerJunctionLifecycle,
  restoreUiWrappers,
} from '../extensions/cmux-junction/lifecycle.js';
import { LIFECYCLE_TIMINGS, type LifecycleSnapshot } from '../extensions/cmux-junction/activity.js';

function context(overrides: Record<string, unknown> = {}) {
  let sessionId = 'session-a';
  const ui = {
    select: vi.fn(async () => 'choice'),
    input: vi.fn(async () => 'text'),
    editor: vi.fn(async () => 'edited'),
    confirm: vi.fn(async () => true),
    notify: vi.fn(),
  };
  return {
    value: {
      mode: 'tui',
      isIdle: () => true,
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

function harness() {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const pi = {
    on: vi.fn((name: string, handler: (event: any, ctx: any) => unknown) =>
      handlers.set(name, handler),
    ),
  } as unknown as ExtensionAPI;
  const snapshots: Array<{ operation: string; snapshot?: LifecycleSnapshot; session?: string }> =
    [];
  const client = {
    start: vi.fn(async (snapshot: LifecycleSnapshot) => {
      snapshots.push({ operation: 'start', snapshot });
      return true;
    }),
    snapshot: vi.fn(async (snapshot: LifecycleSnapshot) => {
      snapshots.push({ operation: 'snapshot', snapshot });
      return true;
    }),
    changeSession: vi.fn(async (session: string) => {
      snapshots.push({ operation: 'session', session });
    }),
    goodbye: vi.fn(async () => {
      snapshots.push({ operation: 'goodbye' });
      return true;
    }),
  };
  const intervals: Array<{ callback: () => void; delay: number }> = [];
  const ctx = context();
  let now = 1_700_000_000_000;
  registerJunctionLifecycle(pi, {
    env: env(),
    now: () => now,
    runtimeId: () => 'runtime-a',
    pid: 4321,
    observeProcessStart: async () => 1_699_999_000_000,
    createClient: () => client,
    setInterval: ((callback: () => void, delay: number) => {
      const timer = { callback, delay };
      intervals.push(timer);
      return timer as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearInterval: vi.fn(),
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
    ['ci', {}, env({ CI: 'true' })],
    ['disabled', {}, env({ [LIFECYCLE_DISABLED_ENV]: '1' })],
  ])('is inert for %s', (reason, ctxOverrides, environment) => {
    expect(lifecycleEligibility(context(ctxOverrides).value, environment)).toEqual({
      eligible: false,
      reason,
    });
  });

  it('is inert without a real nonblank Pi session id', () => {
    const ctx = context({ sessionManager: { getSessionId: () => ' ' } }).value;
    expect(lifecycleEligibility(ctx, env())).toEqual({ eligible: false, reason: 'session' });
  });
});

describe('Pi lifecycle adapter', () => {
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
      isError: true,
    });
    await h.emit('turn_end', { turnIndex: 0, message: { content: 'private' }, toolResults: [] });
    await h.emit('agent_end', { messages: [{ content: 'private' }] });
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
    maintenance.callback();
    await vi.waitFor(() => expect(h.client.changeSession).toHaveBeenCalledWith('session-b'));
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

  it('fails open when process identity or delivery setup fails', async () => {
    const handlers = new Map<string, Function>();
    const pi = { on: (name: string, handler: Function) => handlers.set(name, handler) } as any;
    registerJunctionLifecycle(pi, {
      env: env(),
      observeProcessStart: async () => null,
      createClient: () => {
        throw new Error('must not run');
      },
    });
    await expect(handlers.get('session_start')?.({}, context().value)).resolves.toBeUndefined();
  });
});

describe('UI wait wrappers', () => {
  it.each(['select', 'input', 'editor', 'confirm'] as const)(
    'wraps %s with ordered start/end and restores the owned method',
    async (kind) => {
      const ui = context().ui as any;
      const calls: string[] = [];
      const original = ui[kind];
      const installation = installUiWrappers(ui, async (event) => {
        calls.push(event.type);
      });
      const wrapper = ui[kind];
      expect(installUiWrappers(ui, async () => undefined)).toBe(installation);
      await wrapper.call(ui, 'title', kind === 'confirm' ? 'message' : undefined);
      expect(calls).toEqual(['ui_wait_start', 'ui_wait_end']);
      restoreUiWrappers(ui, installation);
      expect(ui[kind]).toBe(original);
    },
  );

  it('ends waits in finally and does not overwrite a later wrapper during restoration', async () => {
    const ui = context().ui as any;
    const rejected = new Error('private rejection');
    ui.input = vi.fn(async () => {
      throw rejected;
    });
    const calls: string[] = [];
    const installation = installUiWrappers(ui, async (event) => {
      calls.push(event.type);
    });
    await expect(ui.input('title')).rejects.toBe(rejected);
    expect(calls).toEqual(['ui_wait_start', 'ui_wait_end']);

    const later = vi.fn();
    ui.input = later;
    restoreUiWrappers(ui, installation);
    expect(ui.input).toBe(later);
  });
});
