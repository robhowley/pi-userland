import { describe, expect, it } from 'vitest';
import {
  createLifecycleState,
  deriveLifecycleSnapshot,
  formatLifecycleLabel,
  LIFECYCLE_TIMINGS,
  reduceLifecycle,
  sanitizeToolName,
  type LifecycleEvent,
  type LifecycleReducerState,
  type LifecycleSnapshot,
} from '../extensions/cmux-junction/activity.js';

const START = Date.parse('2026-08-18T12:00:00.000Z');

function freshState(): LifecycleReducerState {
  const initial = createLifecycleState({ runtimeId: 'runtime-1', now: START });
  return reduce(initial, { type: 'session_start', sessionId: 'session-1' }, START).state;
}

function reduce(
  state: LifecycleReducerState,
  event: LifecycleEvent,
  at: number,
): ReturnType<typeof reduceLifecycle> {
  return reduceLifecycle(state, { ...event, at }, at);
}

function snapshotAt(state: LifecycleReducerState, at: number): LifecycleSnapshot {
  return deriveLifecycleSnapshot(state, at);
}

describe('Junction lifecycle reducer', () => {
  it('owns exactly seven states and derives the trusted idle/thinking/tool path', () => {
    const initial = createLifecycleState({ runtimeId: 'runtime-1', now: START });
    expect(snapshotAt(initial, START).state).toBe('unknown');

    let state = reduce(initial, { type: 'session_start', sessionId: 'session-1' }, START).state;
    expect(snapshotAt(state, START)).toMatchObject({
      state: 'idle',
      toolName: null,
    });

    state = reduce(state, { type: 'turn_start', turnIndex: 0 }, START + 1_000).state;
    expect(snapshotAt(state, START + 1_000).state).toBe('thinking');

    state = reduce(
      state,
      { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read_file' },
      START + 2_000,
    ).state;
    expect(snapshotAt(state, START + 2_000)).toMatchObject({
      state: 'tool-running',
      toolName: 'read_file',
    });
    expect(formatLifecycleLabel(snapshotAt(state, START + 2_000))).toBe('Tool running: read_file');

    state = reduce(
      state,
      { type: 'tool_execution_end', toolCallId: 'tool-1' },
      START + 3_000,
    ).state;
    expect(snapshotAt(state, START + 3_000).state).toBe('thinking');

    state = reduce(state, { type: 'turn_end', turnIndex: 0 }, START + 4_000).state;
    expect(snapshotAt(state, START + 4_000).state).toBe('unknown');
    state = reduce(state, { type: 'agent_settled', isIdle: true }, START + 5_000).state;
    expect(snapshotAt(state, START + 5_000).state).toBe('idle');

    const labels = [
      'Compacting',
      'Error',
      'Needs input',
      'Tool running',
      'Thinking',
      'Unknown',
      'Idle',
    ];
    expect(new Set(labels)).toHaveLength(7);
  });

  it('applies compacting, error, wait, tool, thinking, idle precedence', () => {
    let state = freshState();
    state = reduce(state, { type: 'turn_start', turnIndex: 0 }, START + 1).state;
    state = reduce(
      state,
      { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash' },
      START + 2,
    ).state;
    state = reduce(
      state,
      { type: 'ui_wait_start', waitId: 'wait-1', kind: 'confirm' },
      START + 3,
    ).state;
    expect(snapshotAt(state, START + 3).state).toBe('awaiting-input');

    state = reduce(state, { type: 'session_before_compact', reason: 'threshold' }, START + 4).state;
    expect(snapshotAt(state, START + 4).state).toBe('compacting');

    state = reduce(
      state,
      { type: 'message_end', role: 'assistant', stopReason: 'aborted' },
      START + 5,
    ).state;
    expect(snapshotAt(state, START + 5).state).toBe('compacting');

    state = reduce(state, { type: 'session_compact' }, START + 6).state;
    expect(snapshotAt(state, START + 6).state).toBe('error');

    state = reduce(state, { type: 'turn_start', turnIndex: 1 }, START + 7).state;
    expect(snapshotAt(state, START + 7).state).toBe('awaiting-input');

    state = reduce(state, { type: 'ui_wait_end', waitId: 'wait-1' }, START + 8).state;
    expect(snapshotAt(state, START + 8).state).toBe('thinking');
  });

  it('keeps awaiting input above tools and tool running above thinking', () => {
    let state = freshState();
    state = reduce(state, { type: 'turn_start', turnIndex: 0 }, START + 1).state;
    state = reduce(
      state,
      { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash' },
      START + 2,
    ).state;
    expect(snapshotAt(state, START + 2).state).toBe('tool-running');

    state = reduce(state, { type: 'ui_wait_start', kind: 'input' }, START + 3).state;
    expect(snapshotAt(state, START + 3).state).toBe('awaiting-input');

    state = reduce(state, { type: 'ui_wait_clear' }, START + 4).state;
    expect(snapshotAt(state, START + 4).state).toBe('tool-running');
  });

  it('tracks overlapping ordered tools and ignores unknown or ended ids', () => {
    let state = freshState();
    state = reduce(state, { type: 'turn_start', turnIndex: 0 }, START + 1).state;
    state = reduce(
      state,
      { type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read' },
      START + 2,
    ).state;
    state = reduce(
      state,
      { type: 'tool_execution_start', toolCallId: 'bash-1', toolName: 'bash' },
      START + 3,
    ).state;
    expect(snapshotAt(state, START + 3).toolName).toBe('bash');

    let transition = reduce(
      state,
      { type: 'tool_execution_update', toolCallId: 'unknown' },
      START + 4,
    );
    expect(transition.accepted).toBe(false);
    expect(transition.state).toBe(state);

    state = reduce(state, { type: 'tool_execution_end', toolCallId: 'bash-1' }, START + 5).state;
    expect(snapshotAt(state, START + 5)).toMatchObject({
      state: 'tool-running',
      toolName: 'read',
    });

    state = reduce(state, { type: 'tool_execution_end', toolCallId: 'read-1' }, START + 6).state;
    expect(snapshotAt(state, START + 6).state).toBe('thinking');

    transition = reduce(state, { type: 'tool_execution_update', toolCallId: 'read-1' }, START + 7);
    expect(transition.accepted).toBe(false);
    expect(transition.state).toBe(state);
  });

  it('replaces an active tool id without duplicating it and keeps the newest order', () => {
    let state = freshState();
    state = reduce(state, { type: 'turn_start', turnIndex: 0 }, START + 1).state;
    state = reduce(
      state,
      { type: 'tool_execution_start', toolCallId: 'a', toolName: 'read' },
      START + 2,
    ).state;
    state = reduce(
      state,
      { type: 'tool_execution_start', toolCallId: 'b', toolName: 'bash' },
      START + 3,
    ).state;
    state = reduce(
      state,
      { type: 'tool_execution_start', toolCallId: 'a', toolName: 'write' },
      START + 4,
    ).state;

    expect(state.activeTools.map((tool) => tool.toolCallId)).toEqual(['b', 'a']);
    expect(snapshotAt(state, START + 4).toolName).toBe('write');
  });

  it('accepts only meaningful known-tool updates and coalesces their publications', () => {
    let state = freshState();
    state = reduce(state, { type: 'turn_start', turnIndex: 0 }, START).state;
    state = reduce(
      state,
      { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash' },
      START + 1,
    ).state;

    let transition = reduce(
      state,
      { type: 'tool_execution_update', toolCallId: 'tool-1', meaningful: false },
      START + 2,
    );
    expect(transition.accepted).toBe(false);
    expect(transition.state.lastEventAt).toBe(START + 1);

    transition = reduce(
      state,
      { type: 'tool_execution_update', toolCallId: 'tool-1', meaningful: true },
      START + 3,
    );
    expect(transition.accepted).toBe(true);
    expect(transition.shouldPublish).toBe(true);
    state = transition.state;

    transition = reduce(
      state,
      { type: 'tool_execution_update', toolCallId: 'tool-1', meaningful: true },
      START + 4,
    );
    expect(transition.accepted).toBe(true);
    expect(transition.shouldPublish).toBe(false);
    expect(transition.state.lastEventAt).toBe(START + 4);
    state = transition.state;

    transition = reduce(
      state,
      { type: 'tool_execution_update', toolCallId: 'tool-1', meaningful: true },
      START + 3 + LIFECYCLE_TIMINGS.toolPublishCoalesceMs,
    );
    expect(transition.shouldPublish).toBe(true);
  });

  it('treats maintenance as fresh snapshot evidence without proving tool progress', () => {
    let state = freshState();
    state = reduce(state, { type: 'turn_start', turnIndex: 0 }, START).state;
    state = reduce(
      state,
      { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash' },
      START + 1,
    ).state;
    const lastEventAt = state.lastEventAt;

    state = reduce(
      state,
      { type: 'maintenance' },
      START + LIFECYCLE_TIMINGS.activityStaleAfterMs,
    ).state;
    expect(state.lastEventAt).toBe(lastEventAt);
    expect(state.activityUpdatedAt).toBe(START + LIFECYCLE_TIMINGS.activityStaleAfterMs);
    expect(snapshotAt(state, START + LIFECYCLE_TIMINGS.activityStaleAfterMs).state).toBe(
      'tool-running',
    );

    const stuckBoundary = START + 1 + LIFECYCLE_TIMINGS.toolStuckAfterMs;
    state = reduce(state, { type: 'maintenance' }, stuckBoundary).state;
    expect(snapshotAt(state, stuckBoundary).state).toBe('tool-running');

    state = reduce(state, { type: 'maintenance' }, stuckBoundary + 1).state;
    expect(snapshotAt(state, stuckBoundary + 1).state).toBe('unknown');
  });

  it('marks active evidence stale after two minutes and accepts the exact boundary', () => {
    let state = freshState();
    state = reduce(state, { type: 'turn_start', turnIndex: 0 }, START).state;
    expect(snapshotAt(state, START + LIFECYCLE_TIMINGS.activityStaleAfterMs).state).toBe(
      'thinking',
    );
    expect(snapshotAt(state, START + LIFECYCLE_TIMINGS.activityStaleAfterMs + 1).state).toBe(
      'unknown',
    );
  });

  it('rejects evidence more than five seconds in the future', () => {
    let state = freshState();
    state = reduce(state, { type: 'turn_start', turnIndex: 0 }, START + 5_001).state;
    expect(snapshotAt(state, START).state).toBe('unknown');

    state = freshState();
    state = reduce(state, { type: 'turn_start', turnIndex: 0 }, START + 5_000).state;
    expect(snapshotAt(state, START).state).toBe('thinking');
  });

  it('requires an active turn and matching turn index before settling idle', () => {
    let state = freshState();
    state = reduce(state, { type: 'turn_start', turnIndex: 4 }, START + 1).state;

    let transition = reduce(state, { type: 'turn_start', turnIndex: 4 }, START + 2);
    expect(transition.accepted).toBe(false);
    expect(transition.state).toBe(state);

    transition = reduce(state, { type: 'turn_start', turnIndex: 3 }, START + 2);
    expect(transition.accepted).toBe(false);

    transition = reduce(state, { type: 'turn_end', turnIndex: 3 }, START + 3);
    expect(transition.accepted).toBe(false);
    expect(transition.state.activeTurn?.turnIndex).toBe(4);

    state = reduce(state, { type: 'turn_end', turnIndex: 4 }, START + 4).state;
    expect(state.settlementRequired).toBe(true);
    expect(snapshotAt(state, START + 4).state).toBe('unknown');
    expect(reduce(state, { type: 'agent_settled', isIdle: false }, START + 5).accepted).toBe(false);

    state = reduce(state, { type: 'agent_settled', isIdle: true }, START + 6).state;
    expect(state.settlementRequired).toBe(false);
    expect(snapshotAt(state, START + 6).state).toBe('idle');
  });

  it('does not let agent_end force idle before settlement', () => {
    let state = freshState();
    state = reduce(state, { type: 'turn_start', turnIndex: 0 }, START + 1).state;
    state = reduce(state, { type: 'agent_end' }, START + 2).state;
    expect(state.lastAgentEndAt).toBe(START + 2);
    expect(snapshotAt(state, START + 2).state).toBe('thinking');

    state = reduce(state, { type: 'turn_end', turnIndex: 0 }, START + 3).state;
    state = reduce(state, { type: 'agent_end' }, START + 4).state;
    expect(snapshotAt(state, START + 4).state).toBe('unknown');
  });

  it('keeps assistant errors sticky through turn end and settlement', () => {
    let state = freshState();
    state = reduce(state, { type: 'turn_start', turnIndex: 0 }, START + 1).state;
    state = reduce(
      state,
      { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash' },
      START + 2,
    ).state;
    state = reduce(
      state,
      { type: 'message_end', role: 'assistant', stopReason: 'error' },
      START + 3,
    ).state;
    expect(state.activeTools).toHaveLength(0);
    expect(snapshotAt(state, START + 3).state).toBe('error');

    state = reduce(state, { type: 'turn_end', turnIndex: 0 }, START + 4).state;
    state = reduce(state, { type: 'agent_settled', isIdle: true }, START + 5).state;
    expect(snapshotAt(state, START + 5).state).toBe('error');

    state = reduce(state, { type: 'turn_start', turnIndex: 1 }, START + 6).state;
    expect(state.assistantError).toBeNull();
    expect(snapshotAt(state, START + 6).state).toBe('thinking');
  });

  it('does not turn tool failures into assistant errors', () => {
    let state = freshState();
    state = reduce(state, { type: 'turn_start', turnIndex: 0 }, START + 1).state;
    state = reduce(
      state,
      { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash' },
      START + 2,
    ).state;
    state = reduce(
      state,
      { type: 'tool_execution_end', toolCallId: 'tool-1', isError: true },
      START + 3,
    ).state;
    expect(state.assistantError).toBeNull();
    expect(snapshotAt(state, START + 3).state).toBe('thinking');
  });

  it('generates private UI wait ids, supports overlap, and returns to the underlying state', () => {
    let state = freshState();
    state = reduce(state, { type: 'turn_start', turnIndex: 0 }, START + 1).state;
    let transition = reduce(state, { type: 'ui_wait_start', kind: 'input' }, START + 2);
    expect(transition.generatedWaitId).toBe('input-1');
    expect(transition.state.uiWaits).toHaveLength(1);
    expect(snapshotAt(transition.state, START + 2).state).toBe('awaiting-input');
    state = transition.state;

    transition = reduce(state, { type: 'ui_wait_start', kind: 'input' }, START + 3);
    expect(transition.generatedWaitId).toBe('input-2');
    state = transition.state;
    expect(state.uiWaits).toHaveLength(2);

    state = reduce(state, { type: 'ui_wait_end', waitId: 'input-1' }, START + 4).state;
    expect(snapshotAt(state, START + 4).state).toBe('awaiting-input');
    state = reduce(state, { type: 'ui_wait_end', waitId: 'input-2' }, START + 5).state;
    expect(snapshotAt(state, START + 5).state).toBe('thinking');

    const unknownEnd = reduce(state, { type: 'ui_wait_end', waitId: 'input-2' }, START + 6);
    expect(unknownEnd.accepted).toBe(false);
  });

  it.each(['select', 'input', 'editor', 'confirm'] as const)(
    'tracks generated %s waits',
    (kind) => {
      let state = freshState();
      const started = reduce(state, { type: 'ui_wait_start', kind }, START + 1);
      expect(started.generatedWaitId).toBe(`${kind}-1`);
      expect(started.snapshot.state).toBe('awaiting-input');

      state = reduce(
        started.state,
        { type: 'ui_wait_end', waitId: started.generatedWaitId! },
        START + 2,
      ).state;
      expect(snapshotAt(state, START + 2).state).toBe('idle');
    },
  );

  it('fences compaction abort callbacks by generation and clears current completion in order', () => {
    let state = freshState();
    state = reduce(state, { type: 'turn_start', turnIndex: 0 }, START + 1).state;
    state = reduce(state, { type: 'session_before_compact', reason: 'manual' }, START + 2).state;
    const firstGeneration = state.compaction?.generation;
    expect(firstGeneration).toBe(1);
    expect(snapshotAt(state, START + 2).state).toBe('compacting');

    state = reduce(
      state,
      { type: 'compaction_abort', generation: firstGeneration! + 1 },
      START + 3,
    ).state;
    expect(state.compaction?.generation).toBe(firstGeneration);

    state = reduce(state, { type: 'session_before_compact', reason: 'overflow' }, START + 4).state;
    const secondGeneration = state.compaction?.generation;
    expect(secondGeneration).toBe(2);

    state = reduce(
      state,
      { type: 'compaction_abort', generation: firstGeneration! },
      START + 5,
    ).state;
    expect(state.compaction?.generation).toBe(secondGeneration);

    state = reduce(state, { type: 'session_compact' }, START + 6).state;
    expect(state.compaction).toBeNull();
    expect(snapshotAt(state, START + 6).state).toBe('thinking');
    expect(reduce(state, { type: 'session_compact' }, START + 7).accepted).toBe(false);
  });

  it('demotes stale compaction, expires it after ten minutes, and never refreshes it generically', () => {
    let state = freshState();
    state = reduce(state, { type: 'turn_start', turnIndex: 0 }, START).state;
    state = reduce(state, { type: 'session_before_compact', reason: 'threshold' }, START + 1).state;
    const compactionUpdatedAt = state.compaction?.updatedAt;

    state = reduce(state, { type: 'input', source: 'extension' }, START + 60_000).state;
    expect(state.compaction?.updatedAt).toBe(compactionUpdatedAt);
    expect(snapshotAt(state, START + 60_000).state).toBe('compacting');

    const demoteBoundary = START + 1 + LIFECYCLE_TIMINGS.compactionDemoteAfterMs;
    expect(snapshotAt(state, demoteBoundary).state).toBe('compacting');
    expect(snapshotAt(state, demoteBoundary + 1).state).toBe('thinking');

    const expireBoundary = START + 1 + LIFECYCLE_TIMINGS.compactionExpireAfterMs;
    expect(snapshotAt(state, expireBoundary).compaction).not.toBeNull();
    state = reduce(state, { type: 'maintenance' }, expireBoundary + 1).state;
    expect(state.compaction).toBeNull();
    expect(snapshotAt(state, expireBoundary + 1).state).toBe('thinking');
  });

  it('returns direct to idle when waits or compaction never belonged to a turn', () => {
    let state = freshState();
    state = reduce(state, { type: 'ui_wait_start', kind: 'select' }, START + 1).state;
    expect(snapshotAt(state, START + 1).state).toBe('awaiting-input');
    state = reduce(state, { type: 'ui_wait_end', waitId: 'select-1' }, START + 2).state;
    expect(snapshotAt(state, START + 2).state).toBe('idle');

    state = reduce(state, { type: 'session_before_compact', reason: 'manual' }, START + 3).state;
    expect(snapshotAt(state, START + 3).state).toBe('compacting');
    state = reduce(state, { type: 'session_compact' }, START + 4).state;
    expect(snapshotAt(state, START + 4).state).toBe('idle');
  });

  it('clears local facts on shutdown and rejects events after intake closes', () => {
    let state = freshState();
    state = reduce(state, { type: 'turn_start', turnIndex: 0 }, START + 1).state;
    state = reduce(state, { type: 'ui_wait_start', kind: 'confirm' }, START + 2).state;
    state = reduce(state, { type: 'session_before_compact' }, START + 3).state;
    const shutdown = reduce(state, { type: 'session_shutdown' }, START + 4);

    expect(shutdown.shouldPublish).toBe(true);
    expect(shutdown.state.closed).toBe(true);
    expect(shutdown.state.activeTools).toEqual([]);
    expect(shutdown.state.uiWaits).toEqual([]);
    expect(shutdown.state.compaction).toBeNull();
    expect(shutdown.snapshot.state).toBe('idle');

    const lateTurn = reduce(shutdown.state, { type: 'turn_start', turnIndex: 1 }, START + 5);
    expect(lateTurn.accepted).toBe(false);
    expect(lateTurn.state).toBe(shutdown.state);
  });

  it('treats malformed stored timestamps as unknown evidence', () => {
    const state = {
      ...freshState(),
      activityUpdatedAt: Number.NaN,
    };
    expect(snapshotAt(state, START).state).toBe('unknown');

    const active = reduce(freshState(), { type: 'turn_start', turnIndex: 0 }, START + 1).state;
    expect(snapshotAt({ ...active, lastEventAt: Number.NaN }, START + 1).state).toBe('unknown');
    expect(snapshotAt({ ...active, activityUpdatedAt: Number.NaN }, START + 1).state).toBe(
      'unknown',
    );
  });

  it('resets all transient lifecycle facts when the session changes', () => {
    let state = freshState();
    state = reduce(state, { type: 'turn_start', turnIndex: 3 }, START + 1).state;
    state = reduce(
      state,
      { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash' },
      START + 2,
    ).state;
    state = reduce(state, { type: 'ui_wait_start', kind: 'confirm' }, START + 3).state;
    state = reduce(
      state,
      { type: 'message_end', role: 'assistant', stopReason: 'aborted' },
      START + 4,
    ).state;
    state = reduce(state, { type: 'session_before_compact' }, START + 5).state;

    state = reduce(
      state,
      { type: 'session_start', sessionId: 'session-2', runtimeId: 'runtime-2' },
      START + 6,
    ).state;
    expect(state).toMatchObject({
      runtimeId: 'runtime-2',
      sessionId: 'session-2',
      activeTurn: null,
      lastTurnIndex: null,
      settlementRequired: false,
      activeTools: [],
      uiWaits: [],
      assistantError: null,
      compaction: null,
      idleTrusted: true,
    });
    expect(snapshotAt(state, START + 6).state).toBe('idle');
  });

  it('handles maintenance session rollover as a reset and not as activity progress', () => {
    let state = freshState();
    state = reduce(state, { type: 'turn_start', turnIndex: 0 }, START + 1).state;
    state = reduce(state, { type: 'maintenance', sessionId: 'session-new' }, START + 2).state;
    expect(state.sessionId).toBe('session-new');
    expect(state.activeTurn).toBeNull();
    expect(snapshotAt(state, START + 2).state).toBe('idle');
  });

  it('sanitizes tool names and keeps snapshots free of ids and payloads', () => {
    expect(sanitizeToolName('  bash\t--command "secret" ')).toBe('bash');
    expect(sanitizeToolName('read\u0000_file')).toBe('read');
    expect(sanitizeToolName('\u001b[31mbash\u001b[0m')).toBe('bash');
    expect(sanitizeToolName('unsafe;rm')).toBeNull();
    expect(sanitizeToolName('x'.repeat(100))).toHaveLength(64);

    let state = freshState();
    state = reduce(state, { type: 'turn_start', turnIndex: 0 }, START + 1).state;
    state = reduce(
      state,
      {
        type: 'tool_execution_start',
        toolCallId: 'private-tool-id',
        toolName: 'bash --prompt secret',
      },
      START + 2,
    ).state;
    const snapshot = snapshotAt(state, START + 2);
    expect(snapshot).toMatchObject({ state: 'tool-running', toolName: 'bash' });
    expect(JSON.stringify(snapshot)).not.toContain('private-tool-id');
    expect(JSON.stringify(snapshot)).not.toContain('secret');
    expect(JSON.stringify(snapshot)).not.toContain('prompt');
    expect(JSON.stringify(snapshot)).not.toContain('session-1');
    expect(formatLifecycleLabel(snapshot)).toBe('Tool running: bash');
  });

  it('makes duplicate and malformed events no-ops', () => {
    let state = freshState();
    const duplicateStart = reduce(
      state,
      { type: 'session_start', sessionId: 'session-1' },
      START + 1,
    );
    expect(duplicateStart.accepted).toBe(false);

    state = reduce(state, { type: 'turn_start', turnIndex: 0 }, START + 2).state;
    state = reduce(
      state,
      { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read' },
      START + 3,
    ).state;
    const duplicateTool = reduce(
      state,
      { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read' },
      START + 4,
    );
    expect(duplicateTool.accepted).toBe(false);
    expect(duplicateTool.state).toBe(state);

    const malformed = reduce(
      state,
      { type: 'tool_execution_end', toolCallId: '\u0000bad' },
      START + 5,
    );
    expect(malformed.accepted).toBe(false);
    expect(malformed.state).toBe(state);

    const unknownSource = reduce(
      state,
      { type: 'input', source: 'prompt' } as unknown as LifecycleEvent,
      START + 6,
    );
    expect(unknownSource.accepted).toBe(false);
  });

  it('does not publish ordinary metadata-only events but publishes a heartbeat maintenance snapshot', () => {
    let state = freshState();
    const input = reduce(state, { type: 'input', source: 'rpc' }, START + 1);
    expect(input.accepted).toBe(true);
    expect(input.shouldPublish).toBe(false);
    state = input.state;

    const maintenance = reduce(state, { type: 'maintenance' }, START + 2);
    expect(maintenance.shouldPublish).toBe(true);
    expect(maintenance.state.lastSnapshot?.lastEventAt).toBe(START + 1);
  });
});
