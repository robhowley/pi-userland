import { describe, expect, it } from 'vitest';
import { deriveChildRuntimeFacets } from '../../extensions/session-deck/parentage/derive.js';
import type { SessionDeckRecord } from '../../extensions/session-deck/activity/types.js';

function buildRecord(overrides: Partial<SessionDeckRecord> = {}): SessionDeckRecord {
  return {
    runtimeId: 'rt-parent',
    pid: 100,
    presenceState: 'live',
    presenceReason: 'fresh_heartbeat',
    heartbeatAt: '2026-07-17T12:05:00.000Z',
    heartbeatAgeMs: 1_000,
    startedAt: '2026-07-17T12:00:00.000Z',
    sessionId: 'session-parent',
    sessionFile: '/tmp/session-parent.md',
    sessionName: 'parent',
    cwd: '/repo',
    worktree: '/repo',
    repoName: 'repo',
    qualifiedRepoName: 'owner/repo',
    branch: 'main',
    prUrl: null,
    isLinkedWorktree: false,
    worktreeLabel: null,
    identityUpdatedAt: '2026-07-17T12:05:00.000Z',
    identityFreshness: 'fresh',
    derivedFacets: {
      persistence: 'file_backed',
      interactivity: 'interactive',
      lifecycle: 'startup',
      lineage: 'root',
      identityStrength: 'strong',
      headerConsistency: 'consistent',
    },
    activityState: 'idle',
    activityAgeMs: null,
    idle: true,
    busy: false,
    currentTurnStartedAt: null,
    currentToolName: null,
    lastEventAt: '2026-07-17T12:05:00.000Z',
    lastError: null,
    activityUpdatedAt: '2026-07-17T12:05:00.000Z',
    diagnostics: [],
    ...overrides,
  };
}

function buildChild(overrides: Partial<SessionDeckRecord> = {}): SessionDeckRecord {
  return buildRecord({
    runtimeId: 'rt-child',
    pid: 200,
    startedAt: '2026-07-17T12:01:30.000Z',
    sessionId: 'session-child',
    sessionFile: null,
    sessionName: 'child',
    derivedFacets: {
      persistence: 'in_memory',
      interactivity: 'headless',
      lifecycle: 'startup',
      lineage: 'root',
      identityStrength: 'weak',
      headerConsistency: 'consistent',
    },
    sessionHeader: {
      id: 'session-child',
      timestamp: '2026-07-17T12:01:30.000Z',
      cwd: '/repo',
    },
    sessionStart: {
      reason: 'startup',
      mode: 'json',
      hasUI: false,
    },
    ...overrides,
  });
}

describe('deriveChildRuntimeFacets', () => {
  it('treats an in-memory session as a candidate but not parentage proof by itself', () => {
    const child = buildChild({
      sessionStart: { reason: 'startup', hasUI: true },
      derivedFacets: {
        persistence: 'in_memory',
        interactivity: 'interactive',
        lifecycle: 'startup',
        lineage: 'root',
        identityStrength: 'weak',
        headerConsistency: 'consistent',
      },
    });

    const facet = deriveChildRuntimeFacets([child]).get('rt-child');

    expect(facet).toEqual({ candidate: true, confidence: 'none', evidence: [] });
  });

  it('does not treat previousSessionFile alone as child parentage evidence', () => {
    const parent = buildRecord();
    const child = buildChild({
      sessionStart: {
        reason: 'resume',
        previousSessionFile: '/tmp/session-parent.md',
        hasUI: true,
      },
      derivedFacets: {
        persistence: 'in_memory',
        interactivity: 'interactive',
        lifecycle: 'resume',
        lineage: 'previous',
        identityStrength: 'weak',
        headerConsistency: 'consistent',
      },
    });

    const facet = deriveChildRuntimeFacets([parent, child]).get('rt-child');

    expect(facet).toEqual({ candidate: true, confidence: 'none', evidence: [] });
  });

  it('does not treat --no-session alone as child parentage evidence', () => {
    const parent = buildRecord();
    const child = buildChild({
      sessionStart: { reason: 'startup' },
      runtimeSignals: {
        launch: {
          noSession: true,
          print: false,
          sessionArgPresent: false,
          forkArgPresent: false,
        },
      },
      derivedFacets: {
        persistence: 'in_memory',
        interactivity: 'unknown',
        lifecycle: 'startup',
        lineage: 'root',
        identityStrength: 'weak',
        headerConsistency: 'consistent',
      },
    });

    const facet = deriveChildRuntimeFacets([parent, child]).get('rt-child');

    expect(facet).toEqual({ candidate: true, confidence: 'none', evidence: [] });
  });

  it('derives high parentage from inherited deck env and process ancestry without raw internals', () => {
    const parent = buildRecord({
      runtimeId: 'rt-parent',
      pid: 100,
      startedAt: '2026-07-17T12:00:00.000Z',
      runtimeSignals: {
        process: {
          pid: 100,
          ppid: 1,
          processStartedAt: '2026-07-17T12:00:00.000Z',
          ancestors: [],
        },
      },
      recentToolWindows: [
        {
          toolCallId: 'tool-1',
          toolName: 'bash',
          startedAt: '2026-07-17T12:01:00.000Z',
          endedAt: '2026-07-17T12:02:00.000Z',
        },
      ],
    });
    const child = buildChild({
      runtimeSignals: {
        process: {
          pid: 200,
          ppid: 100,
          processStartedAt: '2026-07-17T12:01:30.000Z',
          ancestors: [{ pid: 100, ppid: 1, processStartedAt: '2026-07-17T12:00:00.000Z' }],
        },
        inheritedDeckRuntime: {
          runtimeId: 'rt-parent',
          sessionId: 'session-parent',
          sessionFile: '/tmp/session-parent.md',
          startedAt: '2026-07-17T12:00:00.000Z',
        },
      },
      inputSummary: { lastSource: 'extension', counts: { extension: 1 } },
    });

    const facet = deriveChildRuntimeFacets([parent, child]).get('rt-child');

    expect(facet).toMatchObject({
      candidate: true,
      confidence: 'high',
      parentRuntimeId: 'rt-parent',
      parentSessionId: 'session-parent',
    });
    expect(facet?.evidence.map((evidence) => evidence.code)).toEqual(
      expect.arrayContaining([
        'inherited_deck_runtime',
        'process_ancestor_match',
        'started_during_parent_tool',
        'headless_in_memory',
        'automation_input_source',
      ]),
    );
    expect(JSON.stringify(facet)).not.toContain('/tmp/session-parent.md');
    expect(JSON.stringify(facet)).not.toContain('tool-1');
  });

  it('resolves explicit header parents without exposing the raw parentSession path', () => {
    const parent = buildRecord();
    const child = buildChild({
      sessionHeader: {
        id: 'session-child',
        timestamp: '2026-07-17T12:01:30.000Z',
        cwd: '/repo',
        parentSession: '/tmp/session-parent.md',
      },
    });

    const facet = deriveChildRuntimeFacets([parent, child]).get('rt-child');

    expect(facet).toMatchObject({
      confidence: 'explicit',
      parentRuntimeId: 'rt-parent',
      parentSessionId: 'session-parent',
    });
    expect(facet?.evidence).toContainEqual({
      code: 'explicit_header_parent',
      confidence: 'explicit',
      parentRuntimeId: 'rt-parent',
      parentSessionId: 'session-parent',
    });
    expect(JSON.stringify(facet)).not.toContain('/tmp/session-parent.md');
  });

  it('keeps same-terminal-only evidence low and does not choose a parent edge', () => {
    const terminal = {
      kind: 'tmux' as const,
      socketPath: '/tmp/tmux/default',
      sessionName: 'main',
      paneId: '%1',
    };
    const parent = buildRecord({ terminal });
    const child = buildChild({
      terminal,
      sessionStart: { reason: 'startup', hasUI: true },
      derivedFacets: {
        persistence: 'in_memory',
        interactivity: 'interactive',
        lifecycle: 'startup',
        lineage: 'root',
        identityStrength: 'weak',
        headerConsistency: 'consistent',
      },
    });

    const facet = deriveChildRuntimeFacets([parent, child]).get('rt-child');

    expect(facet).toMatchObject({ candidate: true, confidence: 'low' });
    expect(facet).not.toHaveProperty('parentRuntimeId');
    expect(facet?.evidence).toEqual([
      {
        code: 'same_terminal',
        confidence: 'low',
        parentRuntimeId: 'rt-parent',
        parentSessionId: 'session-parent',
      },
    ]);
  });

  it('caps conflicting high parent evidence at medium and leaves parent ids unresolved', () => {
    const leftParent = buildRecord({ runtimeId: 'rt-left', pid: 101, sessionId: 'session-left' });
    const rightParent = buildRecord({
      runtimeId: 'rt-right',
      pid: 102,
      sessionId: 'session-right',
      sessionFile: '/tmp/session-right.md',
    });
    const child = buildChild({
      runtimeSignals: {
        inheritedDeckRuntime: { runtimeId: 'rt-left' },
        process: {
          pid: 200,
          ppid: 102,
          processStartedAt: '2026-07-17T12:01:30.000Z',
          ancestors: [{ pid: 102, ppid: 1, processStartedAt: '2026-07-17T12:00:00.000Z' }],
        },
      },
    });

    const facet = deriveChildRuntimeFacets([leftParent, rightParent, child]).get('rt-child');

    expect(facet?.confidence).toBe('medium');
    expect(facet).not.toHaveProperty('parentRuntimeId');
  });
});
