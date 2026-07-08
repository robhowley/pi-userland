import type { Dirent } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { JoinedSessionRecord } from '../../extensions/session-deck/identity/types.js';
import type { PresenceView } from '../../extensions/session-deck/presence/types.js';

function makePresenceView(overrides?: Partial<PresenceView>): PresenceView {
  return {
    records: [],
    diagnostics: [],
    ...overrides,
  };
}

function buildIdentityRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runtimeId: 'rt-1',
    sessionId: 'session-abc',
    sessionFile: '/tmp/session-abc.md',
    cwd: '/home/user/project',
    worktree: '/home/user/project',
    repoName: null,
    qualifiedRepoName: null,
    branch: 'main',
    prUrl: null,
    isLinkedWorktree: null,
    worktreeLabel: null,
    identityUpdatedAt: '2026-06-17T12:00:00.000Z',
    sessionStartedAt: '2026-06-17T11:00:00.000Z',
    gitRemote: null,
    gitRoot: null,
    identitySource: 'startup',
    ...overrides,
  };
}

async function readSingleJoinedRecord(
  identityRecord: Record<string, unknown> | undefined,
): Promise<JoinedSessionRecord> {
  const { readJoinedSessionView } =
    await import('../../extensions/session-deck/identity/reader.js');

  const readdirImpl =
    identityRecord === undefined
      ? vi.fn().mockResolvedValue([])
      : vi.fn().mockResolvedValue([{ name: 'rt-1.json', isFile: () => true } as unknown as Dirent]);
  const readFileImpl =
    identityRecord === undefined
      ? vi.fn()
      : vi.fn().mockResolvedValue(JSON.stringify(identityRecord));

  const view = await readJoinedSessionView({
    presenceView: makePresenceView({
      records: [
        {
          runtimeId: 'rt-1',
          pid: 1234,
          startedAt: '2026-06-17T11:00:00.000Z',
          heartbeatAt: '2026-06-17T12:09:55.000Z',
          heartbeatAgeMs: 5_000,
          presenceState: 'live',
          reason: 'fresh_heartbeat',
        },
      ],
    }),
    readdir: readdirImpl,
    readFile: readFileImpl,
  });

  expect(view.records).toHaveLength(1);
  return view.records[0]!;
}

describe('identity reader — join', () => {
  it('joins presence records with matching identity records and preserves future raw sessionStart strings', async () => {
    const { readJoinedSessionView } =
      await import('../../extensions/session-deck/identity/reader.js');

    const identityRecords: Record<string, unknown> = {
      'rt-1': {
        runtimeId: 'rt-1',
        sessionId: 'session-abc',
        sessionFile: '/tmp/session-abc.md',
        sessionName: 'Focused session',
        cwd: '/home/user/project',
        worktree: '/home/user/project',
        repoName: 'repo',
        qualifiedRepoName: 'owner/repo',
        branch: 'main',
        prUrl: 'https://github.com/owner/repo/pull/42',
        isLinkedWorktree: true,
        worktreeLabel: 'project-feature',
        identityUpdatedAt: new Date().toISOString(),
        sessionStartedAt: new Date().toISOString(),
        gitRemote: null,
        gitRoot: null,
        identitySource: 'startup',
        sessionStart: {
          reason: 'resume_from_handoff',
          previousSessionFile: '/tmp/session-prev.md',
          mode: 'rpc-stream',
          hasUI: true,
        },
        sessionHeader: {
          id: 'session-abc',
          timestamp: '2026-06-17T11:59:00.000Z',
          cwd: '/home/user/project',
          parentSession: '/tmp/session-parent.md',
        },
      },
    };

    const readdirImpl = vi
      .fn()
      .mockResolvedValue([{ name: 'rt-1.json', isFile: () => true } as unknown as Dirent]);

    const readFileImpl = vi
      .fn()
      .mockImplementation(async (_filePath: string) =>
        JSON.stringify(identityRecords['rt-1'] as never),
      );

    const view = await readJoinedSessionView({
      presenceView: makePresenceView({
        records: [
          {
            runtimeId: 'rt-1',
            pid: 1234,
            startedAt: new Date().toISOString(),
            heartbeatAt: new Date().toISOString(),
            heartbeatAgeMs: 5_000,
            presenceState: 'live',
            reason: 'fresh_heartbeat',
          },
        ],
      }),
      readdir: readdirImpl,
      readFile: readFileImpl,
    });

    expect(view.records).toHaveLength(1);
    const record = view.records[0]!;
    expect(record.runtimeId).toBe('rt-1');
    expect(record.sessionId).toBe('session-abc');
    expect(record.sessionName).toBe('Focused session');
    expect(record.repoName).toBe('repo');
    expect(record.qualifiedRepoName).toBe('owner/repo');
    expect(record.branch).toBe('main');
    expect(record.cwd).toBe('/home/user/project');
    expect(record.prUrl).toBe('https://github.com/owner/repo/pull/42');
    expect(record.isLinkedWorktree).toBe(true);
    expect(record.worktreeLabel).toBe('project-feature');
    expect(record.identityFreshness).toBe('fresh');
    expect(record.derivedFacets).toEqual({
      persistence: 'file_backed',
      interactivity: 'interactive',
      lifecycle: 'other',
      lineage: 'previous_and_parent',
      identityStrength: 'strong',
      headerConsistency: 'consistent',
    });
    expect(record.sessionStart).toEqual({
      reason: 'resume_from_handoff',
      previousSessionFile: '/tmp/session-prev.md',
      mode: 'rpc-stream',
      hasUI: true,
    });
    expect(record.sessionHeader).toEqual({
      id: 'session-abc',
      timestamp: '2026-06-17T11:59:00.000Z',
      cwd: '/home/user/project',
      parentSession: '/tmp/session-parent.md',
    });
    expect(view.diagnostics).toHaveLength(0);
  });

  it('sets identity fields to null when identity record is missing', async () => {
    const { readJoinedSessionView } =
      await import('../../extensions/session-deck/identity/reader.js');

    const readdirImpl = vi.fn().mockResolvedValue([]);
    const readFileImpl = vi.fn().mockRejectedValue(new Error('ENOENT'));

    const view = await readJoinedSessionView({
      presenceView: makePresenceView({
        records: [
          {
            runtimeId: 'rt-1',
            pid: 1234,
            startedAt: new Date().toISOString(),
            heartbeatAt: new Date().toISOString(),
            heartbeatAgeMs: 5_000,
            presenceState: 'live',
            reason: 'fresh_heartbeat',
          },
        ],
      }),
      readdir: readdirImpl,
      readFile: readFileImpl,
    });

    expect(view.records).toHaveLength(1);
    const record = view.records[0]!;
    expect(record.sessionId).toBeNull();
    expect(record.cwd).toBeNull();
    expect(record.repoName).toBeNull();
    expect(record.qualifiedRepoName).toBeNull();
    expect(record.branch).toBeNull();
    expect(record.prUrl).toBeNull();
    expect(record.identityFreshness).toBe('missing');
    expect(record.derivedFacets).toEqual({
      persistence: 'unknown',
      interactivity: 'unknown',
      lifecycle: 'unknown',
      lineage: 'unknown',
      identityStrength: 'missing',
      headerConsistency: 'unavailable',
    });
  });

  it('normalizes missing sessionName, linked-worktree fields, and null raw session metadata', async () => {
    const { readJoinedSessionView } =
      await import('../../extensions/session-deck/identity/reader.js');

    const readdirImpl = vi
      .fn()
      .mockResolvedValue([{ name: 'rt-1.json', isFile: () => true } as unknown as Dirent]);

    const legacyRecord = {
      runtimeId: 'rt-1',
      sessionId: 'session-abc',
      sessionFile: '/tmp/session-abc.md',
      cwd: '/home/user/project',
      worktree: '/home/user/project',
      branch: 'main',
      prUrl: null,
      identityUpdatedAt: new Date().toISOString(),
      sessionStartedAt: new Date().toISOString(),
      gitRemote: null,
      gitRoot: null,
      identitySource: 'startup',
      sessionStart: null,
      sessionHeader: null,
    };

    const readFileImpl = vi.fn().mockResolvedValue(JSON.stringify(legacyRecord));

    const view = await readJoinedSessionView({
      presenceView: makePresenceView({
        records: [
          {
            runtimeId: 'rt-1',
            pid: 1234,
            startedAt: new Date().toISOString(),
            heartbeatAt: new Date().toISOString(),
            heartbeatAgeMs: 5_000,
            presenceState: 'live',
            reason: 'fresh_heartbeat',
          },
        ],
      }),
      readdir: readdirImpl,
      readFile: readFileImpl,
    });

    expect(view.records[0]?.sessionName).toBeNull();
    expect(view.records[0]?.repoName).toBeNull();
    expect(view.records[0]?.qualifiedRepoName).toBeNull();
    expect(view.records[0]?.isLinkedWorktree).toBeNull();
    expect(view.records[0]?.worktreeLabel).toBeNull();
    expect(view.records[0]?.derivedFacets).toEqual({
      persistence: 'file_backed',
      interactivity: 'unknown',
      lifecycle: 'unknown',
      lineage: 'root',
      identityStrength: 'strong',
      headerConsistency: 'unavailable',
    });
    expect(view.records[0]).not.toHaveProperty('sessionStart');
    expect(view.records[0]).not.toHaveProperty('sessionHeader');
  });

  it('keeps previousSessionFile separate from durable lineage', async () => {
    const record = await readSingleJoinedRecord(
      buildIdentityRecord({
        sessionStart: {
          reason: 'resume',
          previousSessionFile: '/tmp/session-prev.md',
          mode: 'rpc',
          hasUI: true,
        },
        sessionHeader: {
          id: 'session-abc',
          timestamp: '2026-06-17T11:59:00.000Z',
          cwd: '/home/user/project',
        },
      }),
    );

    expect(record.sessionStart).toEqual({
      reason: 'resume',
      previousSessionFile: '/tmp/session-prev.md',
      mode: 'rpc',
      hasUI: true,
    });
    expect(record.sessionHeader).toEqual({
      id: 'session-abc',
      timestamp: '2026-06-17T11:59:00.000Z',
      cwd: '/home/user/project',
    });
    expect(record.derivedFacets).toEqual({
      persistence: 'file_backed',
      interactivity: 'interactive',
      lifecycle: 'resume',
      lineage: 'previous',
      identityStrength: 'strong',
      headerConsistency: 'consistent',
    });
  });

  it('keeps matching headers weak without a session file and degrades future reason/mode safely', async () => {
    const record = await readSingleJoinedRecord(
      buildIdentityRecord({
        sessionFile: null,
        sessionStart: {
          reason: 'resume_from_handoff',
          mode: 'json-stream',
        },
        sessionHeader: {
          id: 'session-abc',
          timestamp: '2026-06-17T11:59:00.000Z',
          cwd: '/home/user/project',
        },
      }),
    );

    expect(record.sessionStart).toEqual({
      reason: 'resume_from_handoff',
      mode: 'json-stream',
    });
    expect(record.derivedFacets).toEqual({
      persistence: 'in_memory',
      interactivity: 'unknown',
      lifecycle: 'other',
      lineage: 'root',
      identityStrength: 'weak',
      headerConsistency: 'consistent',
    });
  });

  it.each([
    {
      name: 'sessionId null + matching cwd',
      overrides: {
        sessionId: null,
        sessionHeader: {
          id: 'session-abc',
          timestamp: '2026-06-17T11:59:00.000Z',
          cwd: '/home/user/project',
        },
      },
    },
    {
      name: 'matching sessionId + cwd null',
      overrides: {
        cwd: null,
        sessionHeader: {
          id: 'session-abc',
          timestamp: '2026-06-17T11:59:00.000Z',
          cwd: '/home/user/project',
        },
      },
    },
    {
      name: 'sessionId null + cwd null',
      overrides: {
        sessionId: null,
        cwd: null,
        sessionHeader: {
          id: 'session-abc',
          timestamp: '2026-06-17T11:59:00.000Z',
          cwd: '/home/user/project',
        },
      },
    },
  ])(
    'marks header consistency indeterminate when header exists with partial basis: $name',
    async ({ overrides }) => {
      const record = await readSingleJoinedRecord(buildIdentityRecord(overrides));

      expect(record.derivedFacets?.headerConsistency).toBe('indeterminate');
    },
  );

  it('distinguishes header id conflicts from cwd mismatches', async () => {
    const conflictingId = await readSingleJoinedRecord(
      buildIdentityRecord({
        sessionHeader: {
          id: 'session-other',
          timestamp: '2026-06-17T11:59:00.000Z',
          cwd: '/home/user/project',
        },
      }),
    );
    expect(conflictingId.derivedFacets?.identityStrength).toBe('conflicted');
    expect(conflictingId.derivedFacets?.headerConsistency).toBe('mismatch');

    const mismatchedCwd = await readSingleJoinedRecord(
      buildIdentityRecord({
        sessionHeader: {
          id: 'session-abc',
          timestamp: '2026-06-17T11:59:00.000Z',
          cwd: '/home/user/other-project',
        },
      }),
    );
    expect(mismatchedCwd.derivedFacets?.identityStrength).toBe('strong');
    expect(mismatchedCwd.derivedFacets?.headerConsistency).toBe('mismatch');
  });

  it('surfaces persisted identity diagnostics in record and top-level diagnostics', async () => {
    const { readJoinedSessionView } =
      await import('../../extensions/session-deck/identity/reader.js');

    const readdirImpl = vi
      .fn()
      .mockResolvedValue([{ name: 'rt-1.json', isFile: () => true } as unknown as Dirent]);

    const recordWithDiagnostics = {
      runtimeId: 'rt-1',
      sessionId: null,
      sessionFile: null,
      cwd: '/tmp',
      worktree: null,
      repoName: null,
      qualifiedRepoName: null,
      branch: null,
      prUrl: null,
      identityUpdatedAt: new Date().toISOString(),
      sessionStartedAt: new Date().toISOString(),
      gitRemote: null,
      gitRoot: null,
      identitySource: 'startup',
      diagnostics: [
        {
          code: 'not_git_repo',
          message: 'Not a git repository: /tmp',
          runtimeId: 'rt-1',
        },
      ],
    };

    const readFileImpl = vi.fn().mockResolvedValue(JSON.stringify(recordWithDiagnostics));

    const view = await readJoinedSessionView({
      presenceView: makePresenceView({
        records: [
          {
            runtimeId: 'rt-1',
            pid: 1234,
            startedAt: new Date().toISOString(),
            heartbeatAt: new Date().toISOString(),
            heartbeatAgeMs: 5_000,
            presenceState: 'live',
            reason: 'fresh_heartbeat',
          },
        ],
      }),
      readdir: readdirImpl,
      readFile: readFileImpl,
    });

    expect(view.records[0]?.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'not_git_repo',
    );
    expect(view.diagnostics.map((diagnostic) => diagnostic.code)).toContain('not_git_repo');
  });

  it('reports orphan identity records via diagnostics', async () => {
    const { readJoinedSessionView } =
      await import('../../extensions/session-deck/identity/reader.js');

    const readdirImpl = vi
      .fn()
      .mockResolvedValue([{ name: 'orphan.json', isFile: () => true } as unknown as Dirent]);

    const orphanRecord = {
      runtimeId: 'orphan',
      sessionId: null,
      sessionFile: null,
      cwd: null,
      worktree: null,
      repoName: null,
      qualifiedRepoName: null,
      branch: null,
      prUrl: null,
      identityUpdatedAt: new Date().toISOString(),
      sessionStartedAt: new Date().toISOString(),
      gitRemote: null,
      gitRoot: null,
      identitySource: 'startup',
    };

    const readFileImpl = vi.fn().mockResolvedValue(JSON.stringify(orphanRecord));

    const view = await readJoinedSessionView({
      presenceView: makePresenceView({ records: [] }),
      readdir: readdirImpl,
      readFile: readFileImpl,
    });

    expect(view.records).toHaveLength(0);
    expect(view.diagnostics.some((d) => d.code === 'orphan_identity')).toBe(true);
  });

  it('handles malformed identity JSON gracefully', async () => {
    const { readJoinedSessionView } =
      await import('../../extensions/session-deck/identity/reader.js');

    const readdirImpl = vi
      .fn()
      .mockResolvedValue([{ name: 'rt-1.json', isFile: () => true } as unknown as Dirent]);

    const readFileImpl = vi.fn().mockResolvedValue('not valid json {{{');

    const view = await readJoinedSessionView({
      presenceView: makePresenceView({
        records: [
          {
            runtimeId: 'rt-1',
            pid: 1234,
            startedAt: new Date().toISOString(),
            heartbeatAt: new Date().toISOString(),
            heartbeatAgeMs: 5_000,
            presenceState: 'live',
            reason: 'fresh_heartbeat',
          },
        ],
      }),
      readdir: readdirImpl,
      readFile: readFileImpl,
    });

    expect(view.records).toHaveLength(1);
    const record = view.records[0]!;
    expect(record.sessionId).toBeNull();
    expect(view.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'malformed_identity_record',
        runtimeId: 'rt-1',
        filePath: expect.stringContaining('rt-1.json'),
      }),
    );
  });

  it('rejects identity records whose embedded runtimeId mismatches the filename', async () => {
    const { readJoinedSessionView } =
      await import('../../extensions/session-deck/identity/reader.js');

    const readdirImpl = vi
      .fn()
      .mockResolvedValue([{ name: 'rt-1.json', isFile: () => true } as unknown as Dirent]);

    const readFileImpl = vi.fn().mockResolvedValue(
      JSON.stringify({
        runtimeId: 'rt-other',
        sessionId: 'session-abc',
        sessionFile: '/tmp/session-abc.md',
        cwd: '/tmp/project',
        worktree: '/tmp/project',
        repoName: null,
        qualifiedRepoName: null,
        branch: 'main',
        prUrl: null,
        identityUpdatedAt: new Date().toISOString(),
        sessionStartedAt: new Date().toISOString(),
        gitRemote: null,
        gitRoot: null,
        identitySource: 'startup',
      }),
    );

    const view = await readJoinedSessionView({
      presenceView: makePresenceView({
        records: [
          {
            runtimeId: 'rt-1',
            pid: 1234,
            startedAt: new Date().toISOString(),
            heartbeatAt: new Date().toISOString(),
            heartbeatAgeMs: 5_000,
            presenceState: 'live',
            reason: 'fresh_heartbeat',
          },
        ],
      }),
      readdir: readdirImpl,
      readFile: readFileImpl,
    });

    expect(view.records[0]?.sessionId).toBeNull();
    expect(view.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'malformed_identity_record',
        runtimeId: 'rt-1',
        filePath: expect.stringContaining('rt-1.json'),
      }),
    );
  });

  it('computes identity freshness correctly', async () => {
    const { computeIdentityFreshness } =
      await import('../../extensions/session-deck/identity/reader.js');
    const nowMs = new Date('2026-06-17T12:00:00.000Z').getTime();

    // Fresh (≤2m)
    const fresh = {
      runtimeId: 'rt-1',
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
      identityUpdatedAt: new Date('2026-06-17T11:59:00.000Z').toISOString(),
      sessionStartedAt: '2026-06-17T11:00:00.000Z',
      gitRemote: null,
      gitRoot: null,
      identitySource: 'startup',
    };
    expect(computeIdentityFreshness(fresh, nowMs)).toBe('fresh');

    // Stale (>2m, ≤30m)
    const stale = {
      ...fresh,
      identityUpdatedAt: new Date('2026-06-17T11:30:00.000Z').toISOString(),
    };
    expect(computeIdentityFreshness(stale, nowMs)).toBe('stale');

    // Very stale (>30m)
    const veryStale = {
      ...fresh,
      identityUpdatedAt: new Date('2026-06-17T11:00:00.000Z').toISOString(),
    };
    expect(computeIdentityFreshness(veryStale, nowMs)).toBe('very_stale');

    // Missing
    expect(computeIdentityFreshness(undefined, nowMs)).toBe('missing');
  });
});
