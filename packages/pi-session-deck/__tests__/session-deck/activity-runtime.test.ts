import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureActivityRuntimeStarted,
  getActivityRuntimeDiagnostics,
  resetActivityRuntimeForTests,
} from '../../extensions/session-deck/activity/runtime.js';
import type { SessionActivityRecord } from '../../extensions/session-deck/activity/types.js';

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

    await controller.refreshActivity('new', {
      getSessionId: () => 'session-new',
      getSessionFile: () => '/tmp/session-new.json',
    });

    expect(controller.getActivity()?.runtimeId).toBe('rt-1');
    expect(controller.getActivity()?.sessionId).toBe('session-new');
    expect(controller.getActivity()?.activityState).toBe('idle');
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
