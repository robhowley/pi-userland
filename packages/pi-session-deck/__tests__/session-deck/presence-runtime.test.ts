import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parsePresenceCommandArgs,
  registerPresenceCommand,
  SESSION_DECK_COMMAND_NAME,
} from '../../extensions/session-deck/presence/command.js';
import {
  ensurePresenceRuntimeStarted,
  getPresenceRuntimeIdentity,
  resetPresenceRuntimeForTests,
} from '../../extensions/session-deck/presence/runtime.js';
import type { ReapPresenceRecordsResult } from '../../extensions/session-deck/presence/reap.js';
import type {
  PresenceCommandAPI,
  PresenceCommandContext,
  PresenceCommandRegistration,
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

describe('session-deck command', () => {
  function createMockAPI(): {
    api: PresenceCommandAPI;
    getHandler: () => ((args: string, ctx: PresenceCommandContext) => Promise<void>) | undefined;
    getRegistration: () => PresenceCommandRegistration | undefined;
  } {
    const api = {
      registerCommand: vi.fn(),
    } satisfies PresenceCommandAPI;

    return {
      api,
      getHandler: () => vi.mocked(api.registerCommand).mock.calls[0]?.[1].handler,
      getRegistration: () => vi.mocked(api.registerCommand).mock.calls[0]?.[1],
    };
  }

  function createCommandContext(): PresenceCommandContext {
    return {
      ui: {
        notify: vi.fn(),
      },
    };
  }

  it('parses strict flag combinations', () => {
    expect(parsePresenceCommandArgs('')).toEqual({ ok: true, all: false, reap: false });
    expect(parsePresenceCommandArgs('--all')).toEqual({ ok: true, all: true, reap: false });
    expect(parsePresenceCommandArgs('--reap')).toEqual({ ok: true, all: false, reap: true });
    expect(parsePresenceCommandArgs('--all --reap')).toEqual({
      ok: true,
      all: true,
      reap: true,
    });
    expect(parsePresenceCommandArgs('--reap --all')).toEqual({
      ok: true,
      all: true,
      reap: true,
    });
    expect(parsePresenceCommandArgs('--all --all')).toEqual({
      ok: false,
      message: 'Usage: /session-deck [--all] [--reap]',
    });
    expect(parsePresenceCommandArgs('--reap --reap')).toEqual({
      ok: false,
      message: 'Usage: /session-deck [--all] [--reap]',
    });
    expect(parsePresenceCommandArgs('--bogus')).toEqual({
      ok: false,
      message: 'Usage: /session-deck [--all] [--reap]',
    });
  });

  it('rejects invalid arguments without reading or reaping', async () => {
    const { api, getHandler } = createMockAPI();
    const readPresenceView = vi.fn(async () => ({ records: [], diagnostics: [] }));
    const reapPresenceRecords = vi.fn(async () => ({ removed: [], diagnostics: [] }));

    registerPresenceCommand(api, {
      readPresenceView,
      reapPresenceRecords,
    });

    const handler = getHandler();
    const ctx = createCommandContext();
    await handler?.('--bogus', ctx);

    expect(readPresenceView).not.toHaveBeenCalled();
    expect(reapPresenceRecords).not.toHaveBeenCalled();
    expect(vi.mocked(ctx.ui.notify)).toHaveBeenCalledWith(
      'Usage: /session-deck [--all] [--reap]',
      'error',
    );
  });

  it('offers --all and --reap argument completions', () => {
    const { api, getRegistration } = createMockAPI();

    registerPresenceCommand(api, {
      readPresenceView: vi.fn(async () => ({ records: [], diagnostics: [] })),
    });

    const completions = getRegistration()?.getArgumentCompletions?.('');
    expect(completions).toEqual([
      { value: '--all', label: '--all' },
      { value: '--reap', label: '--reap' },
    ]);
    expect(getRegistration()?.getArgumentCompletions?.('--r')).toEqual([
      { value: '--reap', label: '--reap' },
    ]);
  });

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
    const readPresenceView = vi.fn(async () => view);
    const reapPresenceRecords = vi.fn(async () => ({ removed: [], diagnostics: [] }));

    registerPresenceCommand(api, {
      readPresenceView,
      reapPresenceRecords,
    });

    const handler = getHandler();
    expect(handler).toBeTypeOf('function');

    const ctx = createCommandContext();
    await handler?.('', ctx);

    expect(readPresenceView).toHaveBeenCalledTimes(1);
    expect(reapPresenceRecords).not.toHaveBeenCalled();

    const [defaultMessage, defaultLevel] = vi.mocked(ctx.ui.notify).mock.calls[0] ?? [];
    expect(defaultLevel).toBe('info');
    expect(defaultMessage).toContain('Pi sessions (live + stale)');
    expect(defaultMessage).toContain('live-runtime');
    expect(defaultMessage).toContain('stale-runtime');
    expect(defaultMessage).not.toContain('dead-runtime');
    expect(defaultMessage).not.toContain('Diagnostics:');

    vi.mocked(ctx.ui.notify).mockClear();
    await handler?.('--all', ctx);

    expect(readPresenceView).toHaveBeenCalledTimes(2);
    expect(reapPresenceRecords).not.toHaveBeenCalled();

    const [allMessage] = vi.mocked(ctx.ui.notify).mock.calls[0] ?? [];
    expect(allMessage).toContain('Pi sessions (all presence records)');
    expect(allMessage).toContain('dead-runtime');
    expect(allMessage).toContain('Diagnostics:');
    expect(allMessage).toContain('/tmp/broken.json');
  });

  it('runs reap only when explicitly requested for the default post-reap view', async () => {
    const { api, getHandler } = createMockAPI();
    const readPresenceView = vi.fn(
      async (): Promise<PresenceView> => ({
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
            code: 'read_error',
            message: 'Failed to read one record',
            filePath: '/tmp/read-error.json',
          },
        ],
      }),
    );
    const reapPresenceRecords = vi.fn(
      async (): Promise<ReapPresenceRecordsResult> => ({
        removed: ['/tmp/session-deck/old-runtime.json'],
        diagnostics: [],
      }),
    );

    registerPresenceCommand(api, {
      readPresenceView,
      reapPresenceRecords,
    });

    const handler = getHandler();
    expect(handler).toBeTypeOf('function');

    const ctx = createCommandContext();
    await handler?.('--reap', ctx);

    expect(reapPresenceRecords).toHaveBeenCalledTimes(1);
    expect(readPresenceView).toHaveBeenCalledTimes(1);

    const [message, level] = vi.mocked(ctx.ui.notify).mock.calls[0] ?? [];
    expect(level).toBe('info');
    expect(message).toContain('Reap complete: removed 1 expired presence record.');
    expect(message).toContain('old-runtime');
    expect(message).toContain('Pi sessions (live + stale)');
    expect(message).toContain('live-runtime');
    expect(message).not.toContain('dead-runtime');
    expect(message).not.toContain('Diagnostics:');
  });

  it('runs reap only when explicitly requested and reports removals', async () => {
    const { api, getHandler } = createMockAPI();
    const readPresenceView = vi.fn(
      async (): Promise<PresenceView> => ({
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
            code: 'read_error',
            message: 'Failed to read one record',
            filePath: '/tmp/read-error.json',
          },
        ],
      }),
    );
    const reapPresenceRecords = vi.fn(
      async (): Promise<ReapPresenceRecordsResult> => ({
        removed: ['/tmp/session-deck/old-runtime.json', '/tmp/session-deck/other-runtime.json'],
        diagnostics: [
          {
            code: 'malformed_record',
            message: 'Ignored malformed JSON',
            filePath: '/tmp/broken.json',
          },
        ],
      }),
    );

    registerPresenceCommand(api, {
      readPresenceView,
      reapPresenceRecords,
    });

    const handler = getHandler();
    expect(handler).toBeTypeOf('function');

    const ctx = createCommandContext();
    await handler?.('--all --reap', ctx);

    expect(reapPresenceRecords).toHaveBeenCalledTimes(1);
    expect(readPresenceView).toHaveBeenCalledTimes(1);

    const [message, level] = vi.mocked(ctx.ui.notify).mock.calls[0] ?? [];
    expect(level).toBe('info');
    expect(message).toContain('Reap complete: removed 2 expired presence records.');
    expect(message).toContain('Removed:');
    expect(message).toContain('old-runtime');
    expect(message).toContain('other-runtime');
    expect(message).toContain('Reap diagnostics:');
    expect(message).toContain('/tmp/broken.json');
    expect(message).toContain('Pi sessions (all presence records)');
    expect(message).toContain('live-runtime');
    expect(message).toContain('dead-runtime');
    expect(message).toContain('Diagnostics:');
    expect(message).toContain('/tmp/read-error.json');
  });

  it('registers the expected slash command name', () => {
    const { api } = createMockAPI();

    registerPresenceCommand(api, {
      readPresenceView: vi.fn(async () => ({ records: [], diagnostics: [] })),
    });

    expect(vi.mocked(api.registerCommand)).toHaveBeenCalledWith(
      SESSION_DECK_COMMAND_NAME,
      expect.objectContaining({
        description: expect.stringContaining('Pi session presence'),
      }),
    );
  });
});
