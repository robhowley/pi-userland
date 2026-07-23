import type { Dirent } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { readSessionDeckView } from '../../extensions/session-deck/activity/reader.js';
import type { JoinedSessionView } from '../../extensions/session-deck/identity/types.js';

function buildJoinedView(overrides: Partial<JoinedSessionView> = {}): JoinedSessionView {
  return {
    records: [
      {
        runtimeId: 'rt-1',
        pid: 1234,
        presenceState: 'live',
        heartbeatAt: '2026-06-17T12:09:55.000Z',
        heartbeatAgeMs: 5_000,
        startedAt: '2026-06-17T11:00:00.000Z',
        sessionId: 'session-abc',
        sessionFile: '/tmp/session-abc.json',
        sessionName: null,
        cwd: '/tmp/project',
        worktree: '/tmp/project',
        repoName: 'repo',
        qualifiedRepoName: 'owner/repo',
        branch: 'main',
        prUrl: 'https://github.com/owner/repo/pull/42',
        isLinkedWorktree: false,
        worktreeLabel: null,
        identityUpdatedAt: '2026-06-17T12:09:00.000Z',
        identityFreshness: 'fresh',
        diagnostics: [],
      },
    ],
    diagnostics: [],
    ...overrides,
  };
}

describe('activity reader', () => {
  it('keeps live presence+identity rows visible when activity is missing', async () => {
    const view = await readSessionDeckView({
      joinedView: buildJoinedView(),
      now: new Date('2026-06-17T12:10:00.000Z'),
      readdir: vi.fn().mockResolvedValue([]),
      readFile: vi.fn(),
    });

    expect(view.records).toHaveLength(1);
    expect(view.records[0]?.runtimeId).toBe('rt-1');
    expect(view.records[0]?.activityState).toBe('unknown');
    expect(view.records[0]?.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'activity_missing',
    );
  });

  it('does not trust null-session activity when identity is missing', async () => {
    const readdir = vi
      .fn()
      .mockResolvedValue([{ name: 'rt-1.json', isFile: () => true } as unknown as Dirent]);
    const readFile = vi.fn().mockResolvedValue(
      JSON.stringify({
        runtimeId: 'rt-1',
        sessionId: null,
        activityState: 'idle',
        idle: true,
        busy: false,
        currentTurnStartedAt: null,
        currentToolName: null,
        lastEventAt: '2026-06-17T12:09:18.000Z',
        lastError: null,
        activityUpdatedAt: '2026-06-17T12:09:18.000Z',
      }),
    );

    const view = await readSessionDeckView({
      joinedView: buildJoinedView({
        records: [
          {
            ...buildJoinedView().records[0]!,
            sessionId: null,
            sessionFile: null,
            cwd: null,
            worktree: null,
            repoName: null,
            qualifiedRepoName: null,
            branch: null,
            prUrl: null,
            isLinkedWorktree: null,
            worktreeLabel: null,
            identityUpdatedAt: null,
            identityFreshness: 'missing',
            diagnostics: [
              {
                code: 'identity_missing',
                message: 'No identity record for this runtime',
                runtimeId: 'rt-1',
              },
            ],
          },
        ],
      }),
      now: new Date('2026-06-17T12:10:00.000Z'),
      readdir,
      readFile,
    });

    expect(view.records[0]?.activityState).toBe('unknown');
    expect(view.records[0]?.idle).toBeNull();
    expect(view.records[0]?.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'identity_missing',
    );
  });

  it('joins activity when runtimeId and sessionId match', async () => {
    const readdir = vi
      .fn()
      .mockResolvedValue([{ name: 'rt-1.json', isFile: () => true } as unknown as Dirent]);
    const readFile = vi.fn().mockResolvedValue(
      JSON.stringify({
        runtimeId: 'rt-1',
        sessionId: 'session-abc',
        activityState: 'tool-running',
        idle: false,
        busy: true,
        currentTurnStartedAt: '2026-06-17T12:08:00.000Z',
        currentToolName: 'read',
        lastEventAt: '2026-06-17T12:09:18.000Z',
        lastError: null,
        activityUpdatedAt: '2026-06-17T12:09:18.000Z',
      }),
    );

    const view = await readSessionDeckView({
      joinedView: buildJoinedView(),
      now: new Date('2026-06-17T12:10:00.000Z'),
      readdir,
      readFile,
    });

    expect(view.records[0]?.activityState).toBe('tool-running');
    expect(view.records[0]?.currentToolName).toBe('read');
    expect(view.records[0]?.activityAgeMs).toBe(42_000);
  });

  it('accepts tool_update activity sources', async () => {
    const readdir = vi
      .fn()
      .mockResolvedValue([{ name: 'rt-1.json', isFile: () => true } as unknown as Dirent]);
    const readFile = vi.fn().mockResolvedValue(
      JSON.stringify({
        runtimeId: 'rt-1',
        sessionId: 'session-abc',
        activityState: 'tool-running',
        idle: false,
        busy: true,
        currentTurnStartedAt: '2026-06-17T12:08:00.000Z',
        currentToolName: 'bash',
        lastToolStartedAt: '2026-06-17T12:08:30.000Z',
        lastEventAt: '2026-06-17T12:09:50.000Z',
        lastError: null,
        activityUpdatedAt: '2026-06-17T12:09:50.000Z',
        activitySource: 'tool_update',
      }),
    );

    const view = await readSessionDeckView({
      joinedView: buildJoinedView(),
      now: new Date('2026-06-17T12:10:00.000Z'),
      readdir,
      readFile,
    });

    expect(view.records[0]?.activityState).toBe('tool-running');
    expect(view.records[0]?.currentToolName).toBe('bash');
    expect(view.records[0]?.diagnostics).toEqual([]);
  });

  it('accepts compacting records with metadata and exposes public compaction details', async () => {
    const readdir = vi
      .fn()
      .mockResolvedValue([{ name: 'rt-1.json', isFile: () => true } as unknown as Dirent]);
    const readFile = vi.fn().mockResolvedValue(
      JSON.stringify({
        runtimeId: 'rt-1',
        sessionId: 'session-abc',
        activityState: 'compacting',
        idle: false,
        busy: true,
        currentTurnStartedAt: null,
        currentToolName: null,
        lastEventAt: '2026-06-17T12:09:50.000Z',
        lastError: null,
        activityUpdatedAt: '2026-06-17T12:09:50.000Z',
        activitySource: 'compaction_start',
        compaction: {
          state: 'running',
          startedAt: '2026-06-17T12:09:40.000Z',
          updatedAt: '2026-06-17T12:09:40.000Z',
          reason: 'overflow',
          willRetry: true,
          prompt: 'do not keep',
        },
      }),
    );

    const view = await readSessionDeckView({
      joinedView: buildJoinedView(),
      now: new Date('2026-06-17T12:10:00.000Z'),
      readdir,
      readFile,
    });

    expect(view.records[0]?.activityState).toBe('compacting');
    expect(view.records[0]?.compaction).toEqual({
      state: 'running',
      ageMs: 20_000,
      startedAt: '2026-06-17T12:09:40.000Z',
      reason: 'overflow',
      willRetry: true,
    });
    expect(JSON.stringify(view.records[0]?.compaction)).not.toContain('do not keep');
  });

  it('diagnoses compacting records with missing metadata without dropping base fields', async () => {
    const readdir = vi
      .fn()
      .mockResolvedValue([{ name: 'rt-1.json', isFile: () => true } as unknown as Dirent]);
    const readFile = vi.fn().mockResolvedValue(
      JSON.stringify({
        runtimeId: 'rt-1',
        sessionId: 'session-abc',
        activityState: 'compacting',
        idle: true,
        busy: false,
        currentTurnStartedAt: null,
        currentToolName: null,
        lastEventAt: '2026-06-17T12:09:50.000Z',
        lastError: null,
        activityUpdatedAt: '2026-06-17T12:09:50.000Z',
      }),
    );

    const view = await readSessionDeckView({
      joinedView: buildJoinedView(),
      now: new Date('2026-06-17T12:10:00.000Z'),
      readdir,
      readFile,
    });

    expect(view.records[0]?.activityState).toBe('idle');
    expect(view.records[0]?.idle).toBe(true);
    expect(view.records[0]?.compaction).toBeNull();
    expect(view.records[0]?.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'compaction_malformed',
    );
  });

  it('derives idle from unrecognized quiescent activityState values when idle/busy flags stay authoritative', async () => {
    const unrecognizedQuiescentState = 'quiescent-state';
    const readdir = vi
      .fn()
      .mockResolvedValue([{ name: 'rt-1.json', isFile: () => true } as unknown as Dirent]);
    const readFile = vi.fn().mockResolvedValue(
      JSON.stringify({
        runtimeId: 'rt-1',
        sessionId: 'session-abc',
        activityState: unrecognizedQuiescentState,
        idle: true,
        busy: false,
        currentTurnStartedAt: null,
        currentToolName: null,
        lastEventAt: '2026-06-17T12:09:18.000Z',
        lastError: null,
        activityUpdatedAt: '2026-06-17T12:09:18.000Z',
      }),
    );

    const view = await readSessionDeckView({
      joinedView: buildJoinedView(),
      now: new Date('2026-06-17T12:10:00.000Z'),
      readdir,
      readFile,
    });

    expect(view.records[0]?.activityState).toBe('idle');
    expect(view.records[0]?.idle).toBe(true);
    expect(view.records[0]?.busy).toBe(false);
  });

  it('normalizes activity input summaries and tool windows without preserving payload-like extras', async () => {
    const readdir = vi
      .fn()
      .mockResolvedValue([{ name: 'rt-1.json', isFile: () => true } as unknown as Dirent]);
    const readFile = vi.fn().mockResolvedValue(
      JSON.stringify({
        runtimeId: 'rt-1',
        sessionId: 'session-abc',
        activityState: 'idle',
        idle: true,
        busy: false,
        currentTurnStartedAt: null,
        currentToolName: null,
        lastEventAt: '2026-06-17T12:09:18.000Z',
        lastError: null,
        inputSummary: {
          lastSource: 'rpc',
          lastInputAt: '2026-06-17T12:09:17.000Z',
          counts: { interactive: 1, rpc: 2, unknown: 99 },
        },
        recentToolWindows: [
          { toolCallId: '', toolName: 'bad', startedAt: '2026-06-17T12:09:10.000Z' },
          {
            toolCallId: 'tool-1',
            toolName: 'bash',
            startedAt: '2026-06-17T12:09:10.000Z',
            endedAt: '2026-06-17T12:09:12.000Z',
            isError: true,
            args: { prompt: 'do not keep' },
            result: 'do not keep',
          },
        ],
        activityUpdatedAt: '2026-06-17T12:09:18.000Z',
      }),
    );

    const view = await readSessionDeckView({
      joinedView: buildJoinedView(),
      now: new Date('2026-06-17T12:10:00.000Z'),
      readdir,
      readFile,
    });

    expect(view.records[0]?.inputSummary).toEqual({
      lastSource: 'rpc',
      lastInputAt: '2026-06-17T12:09:17.000Z',
      counts: { interactive: 1, rpc: 2 },
    });
    expect(view.records[0]?.recentToolWindows).toEqual([
      {
        toolCallId: 'tool-1',
        toolName: 'bash',
        startedAt: '2026-06-17T12:09:10.000Z',
        endedAt: '2026-06-17T12:09:12.000Z',
        isError: true,
      },
    ]);
    expect(JSON.stringify(view.records[0]?.recentToolWindows)).not.toContain('do not keep');
  });

  it('drops malformed activity input/tool summaries without breaking the record', async () => {
    const readdir = vi
      .fn()
      .mockResolvedValue([{ name: 'rt-1.json', isFile: () => true } as unknown as Dirent]);
    const readFile = vi.fn().mockResolvedValue(
      JSON.stringify({
        runtimeId: 'rt-1',
        sessionId: 'session-abc',
        activityState: 'idle',
        idle: true,
        busy: false,
        currentTurnStartedAt: null,
        currentToolName: null,
        lastEventAt: '2026-06-17T12:09:18.000Z',
        lastError: null,
        inputSummary: { lastSource: 'prompt', counts: 'bad' },
        recentToolWindows: [{ toolCallId: 'tool-1', toolName: 'bash' }],
        activityUpdatedAt: '2026-06-17T12:09:18.000Z',
      }),
    );

    const view = await readSessionDeckView({
      joinedView: buildJoinedView(),
      now: new Date('2026-06-17T12:10:00.000Z'),
      readdir,
      readFile,
    });

    expect(view.records[0]?.activityState).toBe('idle');
    expect(view.records[0]?.inputSummary).toBeUndefined();
    expect(view.records[0]?.recentToolWindows).toBeUndefined();
  });

  it('ignores old-session activity and reports session_mismatch', async () => {
    const readdir = vi
      .fn()
      .mockResolvedValue([{ name: 'rt-1.json', isFile: () => true } as unknown as Dirent]);
    const readFile = vi.fn().mockResolvedValue(
      JSON.stringify({
        runtimeId: 'rt-1',
        sessionId: 'session-old',
        activityState: 'tool-running',
        idle: false,
        busy: true,
        currentTurnStartedAt: '2026-06-17T12:08:00.000Z',
        currentToolName: 'bash',
        lastEventAt: '2026-06-17T12:09:18.000Z',
        lastError: null,
        activityUpdatedAt: '2026-06-17T12:09:18.000Z',
      }),
    );

    const view = await readSessionDeckView({
      joinedView: buildJoinedView(),
      now: new Date('2026-06-17T12:10:00.000Z'),
      readdir,
      readFile,
    });

    expect(view.records[0]?.activityState).toBe('unknown');
    expect(view.records[0]?.currentToolName).toBeNull();
    expect(view.records[0]?.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'session_mismatch',
    );
  });

  it('allows explicit null-session identity to match null-session activity', async () => {
    const readdir = vi
      .fn()
      .mockResolvedValue([{ name: 'rt-1.json', isFile: () => true } as unknown as Dirent]);
    const readFile = vi.fn().mockResolvedValue(
      JSON.stringify({
        runtimeId: 'rt-1',
        sessionId: null,
        activityState: 'idle',
        idle: true,
        busy: false,
        currentTurnStartedAt: null,
        currentToolName: null,
        lastEventAt: '2026-06-17T12:09:18.000Z',
        lastError: null,
        activityUpdatedAt: '2026-06-17T12:09:18.000Z',
      }),
    );

    const view = await readSessionDeckView({
      joinedView: buildJoinedView({
        records: [
          {
            ...buildJoinedView().records[0]!,
            sessionId: null,
            sessionFile: null,
            identityFreshness: 'fresh',
          },
        ],
      }),
      now: new Date('2026-06-17T12:10:00.000Z'),
      readdir,
      readFile,
    });

    expect(view.records[0]?.activityState).toBe('idle');
    expect(view.records[0]?.idle).toBe(true);
  });

  it('surfaces malformed activity without breaking the row', async () => {
    const readdir = vi
      .fn()
      .mockResolvedValue([{ name: 'rt-1.json', isFile: () => true } as unknown as Dirent]);
    const readFile = vi.fn().mockResolvedValue('not valid json {{{');

    const view = await readSessionDeckView({
      joinedView: buildJoinedView(),
      now: new Date('2026-06-17T12:10:00.000Z'),
      readdir,
      readFile,
    });

    expect(view.records[0]?.activityState).toBe('unknown');
    expect(view.records[0]?.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'malformed_activity_record',
    );
  });
});
