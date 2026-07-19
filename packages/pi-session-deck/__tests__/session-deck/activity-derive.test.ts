import { describe, expect, it } from 'vitest';
import { deriveActivity } from '../../extensions/session-deck/activity/derive.js';
import type { SessionActivityRecord } from '../../extensions/session-deck/activity/types.js';

const NOW = new Date('2026-06-17T12:10:00.000Z');

function buildRecord(overrides: Partial<SessionActivityRecord> = {}): SessionActivityRecord {
  return {
    runtimeId: 'rt-1',
    sessionId: 'session-abc',
    activityState: 'idle',
    idle: true,
    busy: false,
    currentTurnStartedAt: null,
    currentToolName: null,
    lastEventAt: '2026-06-17T12:09:30.000Z',
    lastError: null,
    activityUpdatedAt: '2026-06-17T12:09:30.000Z',
    activitySource: 'turn_end',
    ...overrides,
  };
}

describe('deriveActivity', () => {
  it('derives idle, thinking, tool-running, and error states from trusted records', () => {
    const idle = deriveActivity({
      activity: buildRecord({
        lastEventAt: '2026-06-17T11:50:00.000Z',
        activityUpdatedAt: '2026-06-17T12:09:30.000Z',
      }),
      sessionId: 'session-abc',
      now: NOW,
    });
    expect(idle.activityState).toBe('idle');

    const thinking = deriveActivity({
      activity: buildRecord({
        activityState: 'thinking',
        idle: false,
        busy: true,
        currentTurnStartedAt: '2026-06-17T12:07:00.000Z',
        lastEventAt: '2026-06-17T12:09:30.000Z',
      }),
      sessionId: 'session-abc',
      now: NOW,
    });
    expect(thinking.activityState).toBe('thinking');
    expect(thinking.activityAgeMs).toBe(180_000);

    const toolRunning = deriveActivity({
      activity: buildRecord({
        activityState: 'tool-running',
        idle: false,
        busy: true,
        currentTurnStartedAt: '2026-06-17T12:07:00.000Z',
        currentToolName: 'read',
        lastToolStartedAt: '2026-06-17T12:09:18.000Z',
        lastEventAt: '2026-06-17T12:09:18.000Z',
      }),
      sessionId: 'session-abc',
      now: NOW,
    });
    expect(toolRunning.activityState).toBe('tool-running');
    expect(toolRunning.activityAgeMs).toBe(42_000);

    const error = deriveActivity({
      activity: buildRecord({
        activityState: 'error',
        idle: false,
        busy: false,
        lastError: 'assistant aborted',
      }),
      sessionId: 'session-abc',
      now: NOW,
    });
    expect(error.activityState).toBe('error');
    expect(error.lastError).toBe('assistant aborted');
    expect(error.diagnostics.map((diagnostic) => diagnostic.code)).toContain('last_error_active');
  });

  it('derives compacting only while compaction metadata is fresh', () => {
    const fresh = deriveActivity({
      activity: buildRecord({
        activityState: 'compacting',
        idle: false,
        busy: true,
        lastEventAt: '2026-06-17T12:09:50.000Z',
        activityUpdatedAt: '2026-06-17T12:09:50.000Z',
        compaction: {
          state: 'running',
          startedAt: '2026-06-17T12:09:30.000Z',
          updatedAt: '2026-06-17T12:09:30.000Z',
          reason: 'manual',
          willRetry: false,
        },
      }),
      sessionId: 'session-abc',
      now: NOW,
    });

    expect(fresh.activityState).toBe('compacting');
    expect(fresh.activityAgeMs).toBe(30_000);
    expect(fresh.compaction).toEqual({
      state: 'running',
      ageMs: 30_000,
      startedAt: '2026-06-17T12:09:30.000Z',
      reason: 'manual',
      willRetry: false,
    });

    const stale = deriveActivity({
      activity: buildRecord({
        activityState: 'compacting',
        idle: false,
        busy: true,
        currentTurnStartedAt: '2026-06-17T12:08:00.000Z',
        lastEventAt: '2026-06-17T12:09:50.000Z',
        activityUpdatedAt: '2026-06-17T12:09:50.000Z',
        compaction: {
          state: 'running',
          startedAt: '2026-06-17T12:07:00.000Z',
          updatedAt: '2026-06-17T12:07:30.000Z',
          reason: 'threshold',
          willRetry: true,
        },
      }),
      sessionId: 'session-abc',
      now: NOW,
    });

    expect(stale.activityState).toBe('thinking');
    expect(stale.compaction?.state).toBe('stale');
    expect(stale.diagnostics.map((diagnostic) => diagnostic.code)).toContain('compaction_stale');

    const expired = deriveActivity({
      activity: buildRecord({
        activityState: 'compacting',
        idle: false,
        busy: true,
        currentTurnStartedAt: '2026-06-17T12:08:00.000Z',
        currentToolName: 'bash',
        lastToolStartedAt: '2026-06-17T12:08:30.000Z',
        lastEventAt: '2026-06-17T12:09:50.000Z',
        activityUpdatedAt: '2026-06-17T12:09:50.000Z',
        compaction: {
          state: 'running',
          startedAt: '2026-06-17T11:58:00.000Z',
          updatedAt: '2026-06-17T11:59:00.000Z',
          reason: 'overflow',
          willRetry: true,
        },
      }),
      sessionId: 'session-abc',
      now: NOW,
    });

    expect(expired.activityState).toBe('tool-running');
    expect(expired.compaction).toBeNull();
    expect(expired.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'compaction_expired',
    );
  });

  it('falls back when compacting metadata is missing or malformed', () => {
    const result = deriveActivity({
      activity: buildRecord({
        activityState: 'compacting',
        idle: true,
        busy: false,
        compaction: null,
      }),
      sessionId: 'session-abc',
      now: NOW,
    });

    expect(result.activityState).toBe('idle');
    expect(result.compaction).toBeNull();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'compaction_malformed',
    );
  });

  it('returns unknown with activity_missing when there is no sidecar', () => {
    const result = deriveActivity({ activity: null, sessionId: 'session-abc', now: NOW });
    expect(result.activityState).toBe('unknown');
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['activity_missing']);
  });

  it('marks stale idle snapshots unknown when activityUpdatedAt expires', () => {
    const result = deriveActivity({
      activity: buildRecord({
        lastEventAt: '2026-06-17T12:06:30.000Z',
        activityUpdatedAt: '2026-06-17T12:06:30.000Z',
      }),
      sessionId: 'session-abc',
      now: NOW,
    });

    expect(result.activityState).toBe('unknown');
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('activity_stale');
  });

  it('ignores busy activity whose last real event is too old even if periodic refreshes continue', () => {
    const result = deriveActivity({
      activity: buildRecord({
        activityState: 'tool-running',
        idle: false,
        busy: true,
        currentTurnStartedAt: '2026-06-17T11:50:00.000Z',
        currentToolName: 'bash',
        lastToolStartedAt: '2026-06-17T11:59:00.000Z',
        lastEventAt: '2026-06-17T11:59:00.000Z',
        activityUpdatedAt: '2026-06-17T12:09:50.000Z',
      }),
      sessionId: 'session-abc',
      now: NOW,
    });

    expect(result.activityState).toBe('unknown');
    expect(result.currentToolName).toBe('bash');
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('tool_stuck');
  });

  it('ignores mismatched session activity so /new does not leak old state', () => {
    const result = deriveActivity({
      activity: buildRecord({ sessionId: 'session-old', currentToolName: 'read' }),
      sessionId: 'session-new',
      now: NOW,
    });

    expect(result.activityState).toBe('unknown');
    expect(result.currentToolName).toBeNull();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('session_mismatch');
  });

  it('returns unknown for conflicting busy/idle flags', () => {
    const result = deriveActivity({
      activity: buildRecord({
        activityState: 'thinking',
        idle: true,
        busy: true,
        currentTurnStartedAt: '2026-06-17T12:08:00.000Z',
      }),
      sessionId: 'session-abc',
      now: NOW,
    });

    expect(result.activityState).toBe('unknown');
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('busy_idle_conflict');
  });
});
