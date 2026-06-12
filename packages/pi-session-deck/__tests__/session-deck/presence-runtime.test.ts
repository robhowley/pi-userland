import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerPresenceCommand,
  SESSION_DECK_PRESENCE_COMMAND_NAME,
} from '../../extensions/session-deck/presence/command.js';
import {
  ensurePresenceRuntimeStarted,
  getPresenceRuntimeIdentity,
  resetPresenceRuntimeForTests,
} from '../../extensions/session-deck/presence/runtime.js';
import type {
  PresenceCommandAPI,
  PresenceCommandContext,
} from '../../extensions/session-deck/presence/command.js';
import type { PresenceRecord, PresenceView } from '../../extensions/session-deck/presence/types.js';

afterEach(async () => {
  await resetPresenceRuntimeForTests();
});

describe('presence runtime lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-12T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes immediately and keeps one runtime identity across repeated starts and /new-style restarts', async () => {
    const writes: PresenceRecord[] = [];
    const writeRecord = vi.fn(async (record: PresenceRecord) => {
      writes.push(record);
    });

    const first = await ensurePresenceRuntimeStarted({ writeRecord });
    const second = await ensurePresenceRuntimeStarted({ writeRecord });

    expect(second.runtime.runtimeId).toBe(first.runtime.runtimeId);
    expect(second.runtime.startedAt).toBe(first.runtime.startedAt);
    expect(writeRecord).toHaveBeenCalledTimes(1);
    expect(writes[0]).toEqual({
      runtimeId: first.runtime.runtimeId,
      pid: first.runtime.pid,
      startedAt: '2026-06-12T12:00:00.000Z',
      heartbeatAt: '2026-06-12T12:00:00.000Z',
    });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(writeRecord).toHaveBeenCalledTimes(2);
    expect(writes[1]).toEqual({
      runtimeId: first.runtime.runtimeId,
      pid: first.runtime.pid,
      startedAt: '2026-06-12T12:00:00.000Z',
      heartbeatAt: '2026-06-12T12:00:10.000Z',
    });
  });

  it('creates a new runtimeId after a simulated Pi process restart', async () => {
    const first = getPresenceRuntimeIdentity({
      now: () => new Date('2026-06-12T12:00:00.000Z'),
      randomUUID: () => 'runtime-1',
    });

    await resetPresenceRuntimeForTests();

    const second = getPresenceRuntimeIdentity({
      now: () => new Date('2026-06-12T12:05:00.000Z'),
      randomUUID: () => 'runtime-2',
    });

    expect(second.runtimeId).toBe('runtime-2');
    expect(second.runtimeId).not.toBe(first.runtimeId);
    expect(second.startedAt).toBe('2026-06-12T12:05:00.000Z');
  });
});

describe('session-deck-presence command', () => {
  function createMockAPI(): {
    api: PresenceCommandAPI;
    getHandler: () => ((args: string, ctx: PresenceCommandContext) => Promise<void>) | undefined;
  } {
    const api = {
      registerCommand: vi.fn(),
    } satisfies PresenceCommandAPI;

    return {
      api,
      getHandler: () => vi.mocked(api.registerCommand).mock.calls[0]?.[1].handler,
    };
  }

  function createCommandContext(): PresenceCommandContext {
    return {
      ui: {
        notify: vi.fn(),
      },
    };
  }

  it('shows only live and stale records by default and diagnostics with --all', async () => {
    const { api, getHandler } = createMockAPI();
    const view: PresenceView = {
      records: [
        {
          runtimeId: 'live-runtime',
          pid: 100,
          startedAt: '2026-06-12T11:55:00.000Z',
          heartbeatAt: '2026-06-12T11:59:55.000Z',
          heartbeatAgeMs: 5_000,
          presenceState: 'live',
          reason: 'fresh_heartbeat',
        },
        {
          runtimeId: 'stale-runtime',
          pid: 101,
          startedAt: '2026-06-12T11:50:00.000Z',
          heartbeatAt: '2026-06-12T11:59:10.000Z',
          heartbeatAgeMs: 50_000,
          presenceState: 'stale',
          reason: 'heartbeat_expired',
        },
        {
          runtimeId: 'dead-runtime',
          pid: 102,
          startedAt: '2026-06-12T11:40:00.000Z',
          heartbeatAt: '2026-06-12T11:49:00.000Z',
          heartbeatAgeMs: 660_000,
          presenceState: 'dead',
          reason: 'heartbeat_expired',
        },
      ],
      diagnostics: [
        {
          code: 'malformed_record',
          message: 'Ignored malformed JSON',
          filePath: '/tmp/broken.json',
        },
      ],
    };

    registerPresenceCommand(api, {
      readPresenceView: vi.fn(async () => view),
    });

    const handler = getHandler();
    expect(handler).toBeTypeOf('function');

    const ctx = createCommandContext();
    await handler?.('', ctx);

    const [defaultMessage, defaultLevel] = vi.mocked(ctx.ui.notify).mock.calls[0] ?? [];
    expect(defaultLevel).toBe('info');
    expect(defaultMessage).toContain('live-runtime');
    expect(defaultMessage).toContain('stale-runtime');
    expect(defaultMessage).not.toContain('dead-runtime');
    expect(defaultMessage).not.toContain('Diagnostics:');

    vi.mocked(ctx.ui.notify).mockClear();
    await handler?.('--all', ctx);

    const [allMessage] = vi.mocked(ctx.ui.notify).mock.calls[0] ?? [];
    expect(allMessage).toContain('dead-runtime');
    expect(allMessage).toContain('Diagnostics:');
    expect(allMessage).toContain('/tmp/broken.json');
  });

  it('registers the expected slash command name', () => {
    const { api } = createMockAPI();

    registerPresenceCommand(api, {
      readPresenceView: vi.fn(async () => ({ records: [], diagnostics: [] })),
    });

    expect(vi.mocked(api.registerCommand)).toHaveBeenCalledWith(
      SESSION_DECK_PRESENCE_COMMAND_NAME,
      expect.objectContaining({
        description: expect.stringContaining('Pi runtime presence'),
      }),
    );
  });
});
