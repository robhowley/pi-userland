import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PI_SESSION_DECK_ASSIGNED_RUNTIME_ID_ENV } from '../../extensions/session-deck/presence/constants.js';
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

  it('consumes a valid one-shot assignment as the first cached identity without changing parent provenance', async () => {
    const assignedRuntimeId = '123e4567-e89b-42d3-a456-426614174000';
    const env: NodeJS.ProcessEnv = {
      [PI_SESSION_DECK_ASSIGNED_RUNTIME_ID_ENV]: assignedRuntimeId,
      PI_SESSION_DECK_RUNTIME_ID: 'parent-runtime',
      PI_SESSION_DECK_SESSION_ID: 'parent-session',
      PI_SESSION_DECK_SESSION_FILE: '/tmp/parent-session.md',
      PI_SESSION_DECK_RUNTIME_STARTED_AT: '2026-06-12T11:00:00.000Z',
    };
    const writeRecord = vi.fn(async () => undefined);
    const randomUUID = vi.fn(() => 'generated-runtime');

    const first = await ensurePresenceRuntimeStarted({ env, randomUUID, writeRecord });
    const laterEnv = {
      [PI_SESSION_DECK_ASSIGNED_RUNTIME_ID_ENV]: '223e4567-e89b-42d3-a456-426614174000',
    };
    const second = getPresenceRuntimeIdentity({ env: laterEnv, randomUUID });

    expect(first.runtime.runtimeId).toBe(assignedRuntimeId);
    expect(second).toBe(first.runtime);
    expect(writeRecord).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeId: assignedRuntimeId }),
      {},
    );
    expect(randomUUID).not.toHaveBeenCalled();
    expect(laterEnv[PI_SESSION_DECK_ASSIGNED_RUNTIME_ID_ENV]).toBe(
      '223e4567-e89b-42d3-a456-426614174000',
    );
    expect(env).toEqual({
      PI_SESSION_DECK_RUNTIME_ID: 'parent-runtime',
      PI_SESSION_DECK_SESSION_ID: 'parent-session',
      PI_SESSION_DECK_SESSION_FILE: '/tmp/parent-session.md',
      PI_SESSION_DECK_RUNTIME_STARTED_AT: '2026-06-12T11:00:00.000Z',
    });
  });

  it.each([
    ['non-v4 UUID', '123e4567-e89b-12d3-a456-426614174000'],
    ['unsafe value', '../123e4567-e89b-42d3-a456-426614174000'],
    ['non-UUID value', 'runtime-1'],
  ])('deletes an invalid %s assignment and generates identity instead', (_label, assigned) => {
    const env: NodeJS.ProcessEnv = {
      [PI_SESSION_DECK_ASSIGNED_RUNTIME_ID_ENV]: assigned,
      PI_SESSION_DECK_RUNTIME_ID: 'parent-runtime',
    };

    const identity = getPresenceRuntimeIdentity({
      env,
      randomUUID: () => 'generated-runtime',
    });

    expect(identity.runtimeId).toBe('generated-runtime');
    expect(env).toEqual({ PI_SESSION_DECK_RUNTIME_ID: 'parent-runtime' });
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
    const firstEnv = {
      [PI_SESSION_DECK_ASSIGNED_RUNTIME_ID_ENV]: '123e4567-e89b-42d3-a456-426614174000',
    };
    const first = await firstModule.ensurePresenceRuntimeStarted({
      env: firstEnv,
      randomUUID: () => 'runtime-1',
      writeRecord: firstWriteRecord,
    });

    vi.resetModules();
    const reloadedModule = await import('../../extensions/session-deck/presence/runtime.js');
    const secondWriteRecord = vi.fn(async () => undefined);
    const secondEnv = {
      [PI_SESSION_DECK_ASSIGNED_RUNTIME_ID_ENV]: '223e4567-e89b-42d3-a456-426614174000',
    };
    const second = await reloadedModule.ensurePresenceRuntimeStarted({
      env: secondEnv,
      randomUUID: () => 'runtime-2',
      writeRecord: secondWriteRecord,
    });

    expect(first.runtime.runtimeId).toBe('123e4567-e89b-42d3-a456-426614174000');
    expect(firstEnv[PI_SESSION_DECK_ASSIGNED_RUNTIME_ID_ENV]).toBeUndefined();
    expect(secondEnv[PI_SESSION_DECK_ASSIGNED_RUNTIME_ID_ENV]).toBe(
      '223e4567-e89b-42d3-a456-426614174000',
    );
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
