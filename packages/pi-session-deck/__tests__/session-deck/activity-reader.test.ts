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
        branch: 'main',
        prUrl: 'https://github.com/owner/repo/pull/42',
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
