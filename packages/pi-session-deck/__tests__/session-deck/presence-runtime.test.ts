import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensurePresenceRuntimeStarted,
  getPresenceRuntimeIdentity,
  resetPresenceRuntimeForTests,
} from '../../extensions/session-deck/presence/runtime.js';
import type { PresenceRecord } from '../../extensions/session-deck/presence/types.js';

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

    expect(first.startup).toEqual({ state: 'healthy' });
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

  it('returns an explicit degraded startup state when the initial presence write fails but keeps heartbeating', async () => {
    const writeRecord = vi.fn(async () => {
      throw new Error('disk full');
    });

    const runtime = await ensurePresenceRuntimeStarted({
      directory: '/tmp/session-deck/presence',
      writeRecord,
    });

    expect(runtime.startup).toEqual({
      state: 'degraded',
      diagnostic: {
        code: 'write_error',
        message: 'Failed to write presence record: disk full',
        filePath: '/tmp/session-deck/presence',
      },
    });
    expect(runtime.isRunning()).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(writeRecord).toHaveBeenCalledTimes(2);
  });

  it('keeps the same runtime identity and heartbeat timer across module reloads in one Pi process', async () => {
    vi.resetModules();
    const firstModule = await import('../../extensions/session-deck/presence/runtime.js');

    const firstWriteRecord = vi.fn(async () => undefined);
    const first = await firstModule.ensurePresenceRuntimeStarted({
      randomUUID: () => 'runtime-1',
      writeRecord: firstWriteRecord,
    });

    vi.resetModules();
    const reloadedModule = await import('../../extensions/session-deck/presence/runtime.js');
    const secondWriteRecord = vi.fn(async () => undefined);
    const second = await reloadedModule.ensurePresenceRuntimeStarted({
      randomUUID: () => 'runtime-2',
      writeRecord: secondWriteRecord,
    });

    expect(second.runtime.runtimeId).toBe(first.runtime.runtimeId);
    expect(second.runtime.startedAt).toBe(first.runtime.startedAt);
    expect(firstWriteRecord).toHaveBeenCalledTimes(1);
    expect(secondWriteRecord).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(firstWriteRecord).toHaveBeenCalledTimes(2);
    expect(secondWriteRecord).not.toHaveBeenCalled();
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
