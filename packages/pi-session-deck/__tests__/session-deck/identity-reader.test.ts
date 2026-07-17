import type { Dirent } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  normalizeSessionRuntimeSignalsMetadata,
  normalizeSessionTerminalMetadata,
} from '../../extensions/session-deck/identity/metadata.js';
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

describe('identity terminal metadata normalization', () => {
  it('trims session ids, derives revealUrl, and preserves selected context fields', () => {
    expect(
      normalizeSessionTerminalMetadata({
        kind: 'iterm2',
        sessionId: '  w0t0p0:abc/def?x=1  ',
        revealUrl: 'iterm2:///reveal?sessionid=ignored',
        termProgram: ' iTerm.app ',
        lcTerminal: ' iTerm2 ',
        lcTerminalVersion: ' 3.6.11 ',
        extra: 'ignored',
      }),
    ).toEqual({
      kind: 'iterm2',
      sessionId: 'w0t0p0:abc/def?x=1',
      revealUrl: 'iterm2:///reveal?sessionid=w0t0p0%3Aabc%2Fdef%3Fx%3D1',
      termProgram: 'iTerm.app',
      lcTerminal: 'iTerm2',
      lcTerminalVersion: '3.6.11',
    });
  });

  it('normalizes tmux metadata and ignores persisted attach commands', () => {
    expect(
      normalizeSessionTerminalMetadata({
        kind: 'tmux',
        socketPath: ' /tmp/tmux socket/default ',
        socketName: 'ignored-when-socket-path-exists',
        sessionName: ' prod ',
        sessionId: ' $1 ',
        windowName: ' editor ',
        windowId: ' @2 ',
        paneId: ' %12 ',
        windowIndex: '3',
        paneIndex: 4,
        panePid: '12345',
        attachCommand: 'exec pi',
      }),
    ).toEqual({
      kind: 'tmux',
      socketPath: '/tmp/tmux socket/default',
      sessionName: 'prod',
      sessionId: '$1',
      windowName: 'editor',
      windowId: '@2',
      paneId: '%12',
      windowIndex: 3,
      paneIndex: 4,
      panePid: 12345,
    });
  });

  it.each([
    ['missing', undefined],
    ['non-object', 'w0t0p0'],
    ['wrong kind', { kind: 'terminal', sessionId: 'w0t0p0' }],
    ['empty sessionId', { kind: 'iterm2', sessionId: '' }],
    ['trimmed-empty sessionId', { kind: 'iterm2', sessionId: '   ' }],
    ['tmux without sessionName', { kind: 'tmux', socketPath: '/tmp/tmux/default' }],
    ['tmux without socket selector', { kind: 'tmux', sessionName: 'prod' }],
    ['tmux with unsafe socketName', { kind: 'tmux', socketName: 'bad/name', sessionName: 'prod' }],
  ] as const)('omits %s terminal metadata', (_name, candidate) => {
    expect(normalizeSessionTerminalMetadata(candidate)).toBeUndefined();
  });
});

describe('identity runtime signal metadata normalization', () => {
  it('normalizes runtime signals and drops extra launch payloads', () => {
    expect(
      normalizeSessionRuntimeSignalsMetadata({
        process: {
          pid: '321',
          ppid: '123',
          processStartedAt: ' 2026-07-16T12:00:00.000Z ',
          ancestors: [
            { pid: '123', ppid: '1', processStartedAt: '2026-07-16T11:59:00.000Z' },
            { pid: 1, ppid: 0 },
          ],
        },
        launch: {
          noSession: true,
          print: false,
          mode: 'json',
          sessionArgPresent: false,
          forkArgPresent: true,
          argv: ['secret'],
        },
        stdio: {
          stdinTTY: false,
          stdoutTTY: true,
          stderrTTY: false,
        },
        inheritedDeckRuntime: {
          runtimeId: ' parent-runtime ',
          sessionId: ' parent-session ',
          sessionFile: ' /tmp/parent.md ',
          startedAt: ' 2026-07-16T11:58:00.000Z ',
        },
      }),
    ).toEqual({
      process: {
        pid: 321,
        ppid: 123,
        processStartedAt: '2026-07-16T12:00:00.000Z',
        ancestors: [
          { pid: 123, ppid: 1, processStartedAt: '2026-07-16T11:59:00.000Z' },
          { pid: 1 },
        ],
      },
      launch: {
        noSession: true,
        print: false,
        mode: 'json',
        sessionArgPresent: false,
        forkArgPresent: true,
      },
      stdio: {
        stdinTTY: false,
        stdoutTTY: true,
        stderrTTY: false,
      },
      inheritedDeckRuntime: {
        runtimeId: 'parent-runtime',
        sessionId: 'parent-session',
        sessionFile: '/tmp/parent.md',
        startedAt: '2026-07-16T11:58:00.000Z',
      },
    });
  });

  it('drops malformed runtime signal subobjects independently', () => {
    expect(
      normalizeSessionRuntimeSignalsMetadata({
        process: {
          pid: 'bad',
          ancestors: [{ pid: 123 }],
        },
        launch: {
          noSession: true,
          print: false,
          mode: 'json',
          sessionArgPresent: false,
          forkArgPresent: false,
        },
        stdio: {
          stdinTTY: 'yes',
          stdoutTTY: true,
          stderrTTY: false,
        },
        inheritedDeckRuntime: {
          runtimeId: 'parent-runtime',
        },
      }),
    ).toEqual({
      launch: {
        noSession: true,
        print: false,
        mode: 'json',
        sessionArgPresent: false,
        forkArgPresent: false,
      },
      inheritedDeckRuntime: {
        runtimeId: 'parent-runtime',
      },
    });
  });
});

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

  it('normalizes persisted terminal metadata and joins it into internal records', async () => {
    const record = await readSingleJoinedRecord(
      buildIdentityRecord({
        terminal: {
          kind: 'iterm2',
          sessionId: '  w0t0p0:abc/def?x=1  ',
          revealUrl: 'iterm2:///reveal?sessionid=ignored',
          termProgram: ' iTerm.app ',
          lcTerminal: ' iTerm2 ',
          lcTerminalVersion: ' 3.6.11 ',
          extra: 'ignored',
        },
      }),
    );

    expect(record.terminal).toEqual({
      kind: 'iterm2',
      sessionId: 'w0t0p0:abc/def?x=1',
      revealUrl: 'iterm2:///reveal?sessionid=w0t0p0%3Aabc%2Fdef%3Fx%3D1',
      termProgram: 'iTerm.app',
      lcTerminal: 'iTerm2',
      lcTerminalVersion: '3.6.11',
    });
  });

  it('normalizes persisted tmux metadata and joins it into internal records', async () => {
    const record = await readSingleJoinedRecord(
      buildIdentityRecord({
        terminal: {
          kind: 'tmux',
          socketPath: '/tmp/tmux/default',
          sessionName: 'prod',
          sessionId: '$1',
          windowName: 'editor',
          paneId: '%12',
          attachCommand: 'exec pi',
        },
      }),
    );

    expect(record.terminal).toEqual({
      kind: 'tmux',
      socketPath: '/tmp/tmux/default',
      sessionName: 'prod',
      sessionId: '$1',
      windowName: 'editor',
      paneId: '%12',
    });
  });

  it('normalizes persisted runtime signals and joins them into internal records', async () => {
    const record = await readSingleJoinedRecord(
      buildIdentityRecord({
        runtimeSignals: {
          process: {
            pid: '321',
            ppid: '123',
            ancestors: [{ pid: '123', ppid: '1' }],
          },
          launch: {
            noSession: true,
            print: false,
            mode: 'rpc',
            sessionArgPresent: false,
            forkArgPresent: true,
            prompt: 'secret',
          },
          stdio: {
            stdinTTY: false,
            stdoutTTY: true,
            stderrTTY: false,
          },
          inheritedDeckRuntime: {
            runtimeId: ' parent-runtime ',
            sessionFile: ' /tmp/parent.md ',
          },
        },
      }),
    );

    expect(record.runtimeSignals).toEqual({
      process: {
        pid: 321,
        ppid: 123,
        ancestors: [{ pid: 123, ppid: 1 }],
      },
      launch: {
        noSession: true,
        print: false,
        mode: 'rpc',
        sessionArgPresent: false,
        forkArgPresent: true,
      },
      stdio: {
        stdinTTY: false,
        stdoutTTY: true,
        stderrTTY: false,
      },
      inheritedDeckRuntime: {
        runtimeId: 'parent-runtime',
        sessionFile: '/tmp/parent.md',
      },
    });
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
    expect(view.records[0]).not.toHaveProperty('terminal');
  });

  it('ignores malformed terminal metadata without treating the identity record as malformed', async () => {
    const record = await readSingleJoinedRecord(
      buildIdentityRecord({
        terminal: {
          kind: 'iterm2',
          sessionId: '   ',
          revealUrl: 'iterm2:///reveal?sessionid=ignored',
        },
      }),
    );

    expect(record.sessionId).toBe('session-abc');
    expect(record).not.toHaveProperty('terminal');
    expect(record.diagnostics).toEqual([]);
  });

  it('ignores malformed runtime signal subobjects without treating the identity record as malformed', async () => {
    const record = await readSingleJoinedRecord(
      buildIdentityRecord({
        runtimeSignals: {
          process: {
            pid: 'bad',
          },
          launch: {
            noSession: true,
            print: false,
            mode: 'json',
            sessionArgPresent: false,
            forkArgPresent: false,
          },
          stdio: {
            stdinTTY: 'yes',
            stdoutTTY: true,
            stderrTTY: false,
          },
        },
      }),
    );

    expect(record.sessionId).toBe('session-abc');
    expect(record.runtimeSignals).toEqual({
      launch: {
        noSession: true,
        print: false,
        mode: 'json',
        sessionArgPresent: false,
        forkArgPresent: false,
      },
    });
    expect(record.diagnostics).toEqual([]);
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
