import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ACTIVITY_REFRESH_INTERVAL_MS } from '../../extensions/session-deck/activity/constants.js';
import {
  ensureActivityRuntimeStarted,
  getActivityRuntimeDiagnostics,
  resetActivityRuntimeForTests,
} from '../../extensions/session-deck/activity/runtime.js';
import type { SessionActivityRecord } from '../../extensions/session-deck/activity/types.js';

const ACTIVITY_RUNTIME_STATE_KEY = '__piSessionDeckActivityRuntimeState__';

afterEach(async () => {
  await resetActivityRuntimeForTests();
});

describe('activity runtime lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-17T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('recreates cached controllers that predate tool update handling', async () => {
    const legacyTimer = setInterval(() => undefined, 1_000);
    const clearIntervalSpy = vi.fn((timer: ReturnType<typeof setInterval>) => {
      clearInterval(timer);
    });
    const legacyController = {
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
    const writes: SessionActivityRecord[] = [];

    (globalThis as Record<string, unknown>)[ACTIVITY_RUNTIME_STATE_KEY] = {
      cachedActivity: null,
      activeStartPromise: Promise.resolve(legacyController),
      activeTimer: legacyTimer,
      activeDirectory: undefined,
      activeClearInterval: clearIntervalSpy,
      runtimeId: 'rt-old',
      sessionManager: null,
      lastSeenSessionId: null,
      activeToolCalls: new Map(),
      inputSummary: {},
      recentToolWindows: [],
      hasActiveTurnError: false,
      runtimeDiagnostics: [],
      pendingMutation: Promise.resolve(),
    };

    const controller = await ensureActivityRuntimeStarted('rt-new', {
      writeRecord: vi.fn(async (record: SessionActivityRecord) => {
        writes.push(record);
      }),
    });

    expect(controller).not.toBe(legacyController);
    expect(clearIntervalSpy).toHaveBeenCalledWith(legacyTimer);

    await controller.recordCompactionStart({ reason: 'manual' });

    expect(writes.at(-1)).toMatchObject({
      runtimeId: 'rt-new',
      activityState: 'compacting',
      activitySource: 'compaction_start',
      compaction: { reason: 'manual' },
    });
  });

  it('tracks overlapping tools and keeps the most recent active tool', async () => {
    const writes: SessionActivityRecord[] = [];
    const controller = await ensureActivityRuntimeStarted('rt-1', {
      writeRecord: vi.fn(async (record: SessionActivityRecord) => {
        writes.push(record);
      }),
    });

    await controller.refreshActivity('startup', {
      getSessionId: () => 'session-abc',
      getSessionFile: () => '/tmp/session-abc.json',
    });
    await controller.recordTurnStart();

    vi.setSystemTime(new Date('2026-06-17T12:00:05.000Z'));
    await controller.recordToolExecutionStart({ toolCallId: 'tool-1', toolName: 'read' });
    expect(controller.getActivity()?.currentToolName).toBe('read');

    vi.setSystemTime(new Date('2026-06-17T12:00:08.000Z'));
    await controller.recordToolExecutionStart({ toolCallId: 'tool-2', toolName: 'bash' });
    expect(controller.getActivity()?.currentToolName).toBe('bash');

    vi.setSystemTime(new Date('2026-06-17T12:00:15.000Z'));
    await controller.recordToolExecutionEnd({
      toolCallId: 'tool-2',
      toolName: 'bash',
      isError: false,
    });
    expect(controller.getActivity()?.currentToolName).toBe('read');
    expect(controller.getActivity()?.activityState).toBe('tool-running');

    vi.setSystemTime(new Date('2026-06-17T12:00:20.000Z'));
    await controller.recordToolExecutionEnd({
      toolCallId: 'tool-1',
      toolName: 'read',
      isError: false,
    });
    expect(controller.getActivity()?.currentToolName).toBeNull();
    expect(controller.getActivity()?.activityState).toBe('thinking');
    expect(writes.at(-1)?.activityState).toBe('thinking');
  });

  it('records meaningful active tool updates as progress without storing partial payloads', async () => {
    const writes: SessionActivityRecord[] = [];
    const controller = await ensureActivityRuntimeStarted('rt-1', {
      writeRecord: vi.fn(async (record: SessionActivityRecord) => {
        writes.push(record);
      }),
    });

    await controller.refreshActivity('startup', {
      getSessionId: () => 'session-abc',
      getSessionFile: () => '/tmp/session-abc.json',
    });
    await controller.recordMessageEnd({
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'previous error',
    });

    vi.setSystemTime(new Date('2026-06-17T12:00:01.000Z'));
    await controller.recordTurnStart();

    vi.setSystemTime(new Date('2026-06-17T12:00:05.000Z'));
    await controller.recordToolExecutionStart({ toolCallId: 'tool-1', toolName: 'read' });

    vi.setSystemTime(new Date('2026-06-17T12:00:07.000Z'));
    await controller.recordToolExecutionStart({ toolCallId: 'tool-2', toolName: 'bash' });

    vi.setSystemTime(new Date('2026-06-17T12:00:08.000Z'));
    await controller.recordToolExecutionUpdate({
      toolCallId: 'tool-1',
      toolName: 'read',
      partialResult: { content: [{ type: 'text', text: 'partial output to drop' }] },
    });

    const updated = controller.getActivity();
    expect(updated).toMatchObject({
      activityState: 'tool-running',
      idle: false,
      busy: true,
      currentTurnStartedAt: '2026-06-17T12:00:01.000Z',
      currentToolName: 'bash',
      lastToolStartedAt: '2026-06-17T12:00:07.000Z',
      lastEventAt: '2026-06-17T12:00:08.000Z',
      lastError: 'previous error',
      activityUpdatedAt: '2026-06-17T12:00:08.000Z',
      activitySource: 'tool_update',
      recentToolWindows: [
        {
          toolCallId: 'tool-1',
          toolName: 'read',
          startedAt: '2026-06-17T12:00:05.000Z',
        },
        {
          toolCallId: 'tool-2',
          toolName: 'bash',
          startedAt: '2026-06-17T12:00:07.000Z',
        },
      ],
    });
    expect(writes.at(-1)?.activitySource).toBe('tool_update');
    expect(JSON.stringify(updated)).not.toContain('partial output to drop');
    expect(JSON.stringify(writes.at(-1))).not.toContain('partialResult');
  });

  it('ignores empty, unknown, and ended tool updates', async () => {
    const writes: SessionActivityRecord[] = [];
    const controller = await ensureActivityRuntimeStarted('rt-1', {
      writeRecord: vi.fn(async (record: SessionActivityRecord) => {
        writes.push(record);
      }),
    });

    await controller.refreshActivity('startup', {
      getSessionId: () => 'session-abc',
      getSessionFile: () => '/tmp/session-abc.json',
    });
    await controller.recordTurnStart();
    await controller.recordToolExecutionStart({ toolCallId: 'tool-1', toolName: 'bash' });
    const writesAfterStart = writes.length;
    const lastEventAtAfterStart = controller.getActivity()?.lastEventAt;

    vi.setSystemTime(new Date('2026-06-17T12:00:05.000Z'));
    await controller.recordToolExecutionUpdate({
      toolCallId: 'tool-1',
      toolName: 'bash',
      partialResult: { content: [], details: undefined },
    });
    await controller.recordToolExecutionUpdate({
      toolCallId: 'tool-unknown',
      toolName: 'bash',
      partialResult: { content: [{ type: 'text', text: 'ignored output' }] },
    });

    expect(writes).toHaveLength(writesAfterStart);
    expect(controller.getActivity()?.lastEventAt).toBe(lastEventAtAfterStart);

    vi.setSystemTime(new Date('2026-06-17T12:00:07.000Z'));
    await controller.recordToolExecutionEnd({
      toolCallId: 'tool-1',
      toolName: 'bash',
      isError: false,
    });
    const writesAfterEnd = writes.length;

    vi.setSystemTime(new Date('2026-06-17T12:00:08.000Z'));
    await controller.recordToolExecutionUpdate({
      toolCallId: 'tool-1',
      toolName: 'bash',
      partialResult: { content: [{ type: 'text', text: 'late output' }] },
    });

    expect(writes).toHaveLength(writesAfterEnd);
    expect(controller.getActivity()).toMatchObject({
      activitySource: 'tool_end',
      lastEventAt: '2026-06-17T12:00:07.000Z',
      currentToolName: null,
    });
  });

  it('coalesces frequent tool update writes to the activity refresh interval', async () => {
    const writes: SessionActivityRecord[] = [];
    const controller = await ensureActivityRuntimeStarted('rt-1', {
      writeRecord: vi.fn(async (record: SessionActivityRecord) => {
        writes.push(record);
      }),
    });

    await controller.refreshActivity('startup', {
      getSessionId: () => 'session-abc',
      getSessionFile: () => '/tmp/session-abc.json',
    });
    await controller.recordTurnStart();
    await controller.recordToolExecutionStart({ toolCallId: 'tool-1', toolName: 'bash' });

    vi.setSystemTime(new Date('2026-06-17T12:00:01.000Z'));
    await controller.recordToolExecutionUpdate({
      toolCallId: 'tool-1',
      toolName: 'bash',
      partialResult: { content: [{ type: 'text', text: 'first' }] },
    });

    vi.setSystemTime(new Date('2026-06-17T12:00:02.000Z'));
    await controller.recordToolExecutionUpdate({
      toolCallId: 'tool-1',
      toolName: 'bash',
      partialResult: { content: [{ type: 'text', text: 'second' }] },
    });

    expect(writes.filter((record) => record.activitySource === 'tool_update')).toHaveLength(1);
    expect(writes.at(-1)?.lastEventAt).toBe('2026-06-17T12:00:01.000Z');
    expect(controller.getActivity()).toMatchObject({
      activitySource: 'tool_update',
      lastEventAt: '2026-06-17T12:00:02.000Z',
    });

    vi.setSystemTime(
      new Date(Date.parse('2026-06-17T12:00:02.000Z') + DEFAULT_ACTIVITY_REFRESH_INTERVAL_MS),
    );
    await controller.recordToolExecutionUpdate({
      toolCallId: 'tool-1',
      toolName: 'bash',
      partialResult: { content: [{ type: 'text', text: 'third' }] },
    });

    expect(writes.filter((record) => record.activitySource === 'tool_update')).toHaveLength(2);
    expect(writes.at(-1)?.lastEventAt).toBe('2026-06-17T12:00:32.000Z');
  });

  it('records input summaries and a bounded sanitized tool-window ring', async () => {
    const controller = await ensureActivityRuntimeStarted('rt-1', {
      writeRecord: vi.fn().mockResolvedValue(undefined),
    });

    await controller.refreshActivity('startup', {
      getSessionId: () => 'session-abc',
      getSessionFile: () => '/tmp/session-abc.json',
    });

    await controller.recordInputSource('interactive');
    vi.setSystemTime(new Date('2026-06-17T12:00:01.000Z'));
    await controller.recordInputSource('rpc');

    expect(controller.getActivity()?.inputSummary).toEqual({
      lastSource: 'rpc',
      lastInputAt: '2026-06-17T12:00:01.000Z',
      counts: { interactive: 1, rpc: 1 },
    });

    for (let index = 0; index < 22; index += 1) {
      vi.setSystemTime(new Date(`2026-06-17T12:00:${String(index + 2).padStart(2, '0')}.000Z`));
      await controller.recordToolExecutionStart({
        toolCallId: `tool-${index}`,
        toolName: 'bash',
      });
      await controller.recordToolExecutionEnd({
        toolCallId: `tool-${index}`,
        toolName: 'bash',
        isError: index === 21,
      });
    }

    const windows = controller.getActivity()?.recentToolWindows ?? [];
    expect(windows).toHaveLength(20);
    expect(windows[0]?.toolCallId).toBe('tool-2');
    expect(windows.at(-1)).toEqual({
      toolCallId: 'tool-21',
      toolName: 'bash',
      startedAt: '2026-06-17T12:00:23.000Z',
      endedAt: '2026-06-17T12:00:23.000Z',
      isError: true,
    });
    expect(JSON.stringify(windows)).not.toContain('args');
    expect(JSON.stringify(windows)).not.toContain('result');
  });

  it('resets activity on /new while keeping the same runtimeId', async () => {
    const controller = await ensureActivityRuntimeStarted('rt-1', {
      writeRecord: vi.fn().mockResolvedValue(undefined),
    });

    await controller.refreshActivity('startup', {
      getSessionId: () => 'session-old',
      getSessionFile: () => '/tmp/session-old.json',
    });
    await controller.recordTurnStart();
    await controller.recordToolExecutionStart({ toolCallId: 'tool-1', toolName: 'read' });
    await controller.recordMessageEnd({
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'bad\nstack',
    });

    expect(controller.getActivity()?.runtimeId).toBe('rt-1');
    expect(controller.getActivity()?.activityState).toBe('error');
    expect(controller.getActivity()?.lastError).toBe('bad stack');

    await controller.recordCompactionStart({ reason: 'manual' });
    expect(controller.getActivity()?.activityState).toBe('compacting');

    await controller.refreshActivity('new', {
      getSessionId: () => 'session-new',
      getSessionFile: () => '/tmp/session-new.json',
    });

    expect(controller.getActivity()?.runtimeId).toBe('rt-1');
    expect(controller.getActivity()?.sessionId).toBe('session-new');
    expect(controller.getActivity()?.activityState).toBe('idle');
    expect(controller.getActivity()?.compaction).toBeUndefined();
    expect(controller.getActivity()?.currentToolName).toBeNull();
    expect(controller.getActivity()?.lastError).toBeNull();
  });

  it('clears active error state on the next turn', async () => {
    const controller = await ensureActivityRuntimeStarted('rt-1', {
      writeRecord: vi.fn().mockResolvedValue(undefined),
    });

    await controller.refreshActivity('startup', {
      getSessionId: () => 'session-abc',
      getSessionFile: () => '/tmp/session-abc.json',
    });
    await controller.recordTurnStart();
    await controller.recordMessageEnd({
      role: 'assistant',
      stopReason: 'aborted',
      errorMessage: 'request aborted',
    });
    await controller.recordTurnEnd();

    expect(controller.getActivity()?.activityState).toBe('error');

    await controller.recordTurnStart();
    expect(controller.getActivity()?.activityState).toBe('thinking');
    expect(controller.getActivity()?.busy).toBe(true);
  });

  it('records compaction as primary activity until it clears to live runtime facts', async () => {
    const controller = await ensureActivityRuntimeStarted('rt-1', {
      writeRecord: vi.fn().mockResolvedValue(undefined),
    });

    await controller.refreshActivity('startup', {
      getSessionId: () => 'session-abc',
      getSessionFile: () => '/tmp/session-abc.json',
    });
    await controller.recordTurnStart();
    await controller.recordToolExecutionStart({ toolCallId: 'tool-1', toolName: 'read' });

    vi.setSystemTime(new Date('2026-06-17T12:00:10.000Z'));
    await controller.recordCompactionStart({ reason: 'threshold', willRetry: true });

    expect(controller.getActivity()).toMatchObject({
      activityState: 'compacting',
      idle: false,
      busy: true,
      currentToolName: 'read',
      activitySource: 'compaction_start',
      compaction: {
        state: 'running',
        startedAt: '2026-06-17T12:00:10.000Z',
        updatedAt: '2026-06-17T12:00:10.000Z',
        reason: 'threshold',
        willRetry: true,
      },
    });

    vi.setSystemTime(new Date('2026-06-17T12:00:20.000Z'));
    await controller.recordToolExecutionEnd({
      toolCallId: 'tool-1',
      toolName: 'read',
      isError: false,
    });

    expect(controller.getActivity()).toMatchObject({
      activityState: 'compacting',
      currentToolName: null,
      activityUpdatedAt: '2026-06-17T12:00:20.000Z',
      compaction: {
        startedAt: '2026-06-17T12:00:10.000Z',
        updatedAt: '2026-06-17T12:00:10.000Z',
      },
    });

    await controller.clearCompaction('completed');

    expect(controller.getActivity()).toMatchObject({
      activityState: 'thinking',
      compaction: null,
      activitySource: 'compaction_end',
    });
  });

  it('ignores already-aborted compaction starts and clears aborts after a write', async () => {
    const controller = await ensureActivityRuntimeStarted('rt-1', {
      writeRecord: vi.fn().mockResolvedValue(undefined),
    });

    await controller.refreshActivity('startup', {
      getSessionId: () => 'session-abc',
      getSessionFile: () => '/tmp/session-abc.json',
    });

    const abortedBefore = new AbortController();
    abortedBefore.abort();
    await controller.recordCompactionStart({ reason: 'manual', signal: abortedBefore.signal });
    expect(controller.getActivity()?.activityState).toBe('idle');

    const abortedAfter = new AbortController();
    await controller.recordCompactionStart({ reason: 'manual', signal: abortedAfter.signal });
    expect(controller.getActivity()?.activityState).toBe('compacting');

    abortedAfter.abort();
    await controller.recordInputSource('extension');

    expect(controller.getActivity()?.activityState).toBe('idle');
    expect(controller.getActivity()?.compaction).toBeNull();
  });

  it('expires compaction during periodic refresh without refreshing compaction timestamps', async () => {
    const controller = await ensureActivityRuntimeStarted('rt-1', {
      writeRecord: vi.fn().mockResolvedValue(undefined),
    });

    await controller.refreshActivity('startup', {
      getSessionId: () => 'session-abc',
      getSessionFile: () => '/tmp/session-abc.json',
    });
    await controller.recordCompactionStart({ reason: 'overflow', willRetry: true });

    expect(controller.getActivity()?.compaction?.updatedAt).toBe('2026-06-17T12:00:00.000Z');

    await vi.advanceTimersByTimeAsync(90_000);
    expect(controller.getActivity()).toMatchObject({
      activityState: 'compacting',
      compaction: { updatedAt: '2026-06-17T12:00:00.000Z' },
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(controller.getActivity()).toMatchObject({
      activityState: 'idle',
      compaction: null,
      activitySource: 'compaction_expired',
    });
  });

  it('writes periodic safety refreshes without changing the last real event timestamp', async () => {
    const writes: SessionActivityRecord[] = [];
    const controller = await ensureActivityRuntimeStarted('rt-1', {
      writeRecord: vi.fn(async (record: SessionActivityRecord) => {
        writes.push(record);
      }),
    });

    await controller.refreshActivity('startup', {
      getSessionId: () => 'session-abc',
      getSessionFile: () => '/tmp/session-abc.json',
    });
    const initial = controller.getActivity();
    expect(initial?.activityState).toBe('idle');
    expect(initial?.activitySource).toBe('startup');

    await vi.advanceTimersByTimeAsync(30_000);

    const refreshed = controller.getActivity();
    expect(refreshed?.activityState).toBe('idle');
    expect(refreshed?.activitySource).toBe('periodic');
    expect(refreshed?.lastEventAt).toBe('2026-06-17T12:00:00.000Z');
    expect(refreshed?.activityUpdatedAt).toBe('2026-06-17T12:00:30.000Z');
    expect(writes.at(-1)?.activitySource).toBe('periodic');
  });

  it('surfaces activity_write_error diagnostics when writes fail', async () => {
    const controller = await ensureActivityRuntimeStarted('rt-1', {
      writeRecord: vi.fn().mockRejectedValue(new Error('disk full')),
    });

    await controller.refreshActivity('startup', {
      getSessionId: () => 'session-abc',
      getSessionFile: () => '/tmp/session-abc.json',
    });

    expect(controller.getActivity()?.activityState).toBe('idle');
    expect(getActivityRuntimeDiagnostics().map((diagnostic) => diagnostic.code)).toContain(
      'activity_write_error',
    );
  });
});
