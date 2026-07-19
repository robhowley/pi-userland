import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeActivityRecord } from '../../extensions/session-deck/activity/writer.js';
import { writeChipRecord } from '../../extensions/session-deck/chips/writer.js';
import { writeIdentityRecord } from '../../extensions/session-deck/identity/writer.js';
import { writePresenceRecord } from '../../extensions/session-deck/presence/writer.js';
import { readSessionDeckSnapshot } from '../../extensions/session-deck/reader.js';
import type { SessionActivityRecord } from '../../extensions/session-deck/activity/types.js';
import type { SessionDeckChipRecord } from '../../extensions/session-deck/chips/types.js';
import type { SessionIdentityRecord } from '../../extensions/session-deck/identity/types.js';
import type { PresenceRecord } from '../../extensions/session-deck/presence/types.js';

const createdDirectories: string[] = [];

function buildPresenceRecord(overrides: Partial<PresenceRecord> = {}): PresenceRecord {
  return {
    runtimeId: 'rt-1',
    pid: 101,
    startedAt: '2026-06-23T12:00:00.000Z',
    heartbeatAt: '2026-06-23T12:09:55.000Z',
    ...overrides,
  };
}

function buildIdentityRecord(
  overrides: Partial<SessionIdentityRecord> = {},
): SessionIdentityRecord {
  return {
    runtimeId: 'rt-1',
    sessionId: 'session-1',
    sessionFile: '/tmp/session-1.json',
    sessionName: 'alpha',
    cwd: '/tmp/project',
    worktree: '/tmp/project',
    repoName: 'repo',
    qualifiedRepoName: 'owner/repo',
    branch: 'main',
    prUrl: 'https://github.com/owner/repo/pull/42',
    isLinkedWorktree: false,
    worktreeLabel: null,
    identityUpdatedAt: '2026-06-23T12:09:50.000Z',
    sessionStartedAt: '2026-06-23T12:00:00.000Z',
    gitRemote: 'git@github.com:owner/repo.git',
    gitRoot: '/tmp/project',
    identitySource: 'startup',
    sessionStart: {
      reason: 'resume',
      previousSessionFile: '/tmp/session-0.json',
      mode: 'rpc',
      hasUI: false,
    },
    sessionHeader: {
      id: 'session-1',
      timestamp: '2026-06-23T12:00:00.000Z',
      cwd: '/tmp/project',
      parentSession: '/tmp/session-0.json',
    },
    ...overrides,
  };
}

function buildActivityRecord(
  overrides: Partial<SessionActivityRecord> = {},
): SessionActivityRecord {
  return {
    runtimeId: 'rt-1',
    sessionId: 'session-1',
    activityState: 'idle',
    idle: true,
    busy: false,
    currentTurnStartedAt: null,
    currentToolName: null,
    lastEventAt: '2026-06-23T12:09:58.000Z',
    lastError: null,
    activityUpdatedAt: '2026-06-23T12:09:58.000Z',
    ...overrides,
  };
}

function buildChipRecord(overrides: Partial<SessionDeckChipRecord> = {}): SessionDeckChipRecord {
  return {
    schemaVersion: 1,
    runtimeId: 'rt-1',
    sessionId: 'session-1',
    source: 'alpha',
    chipId: 'default',
    scope: 'session',
    text: 'merge ready',
    level: 'ok',
    updatedAt: '2026-06-23T12:09:30.000Z',
    ...overrides,
  };
}

async function createSnapshotDirectories(): Promise<{
  presenceDirectory: string;
  identityDirectory: string;
  activityDirectory: string;
  chipsDirectory: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'pi-session-deck-snapshot-'));
  createdDirectories.push(root);
  return {
    presenceDirectory: join(root, 'presence'),
    identityDirectory: join(root, 'identity'),
    activityDirectory: join(root, 'activity'),
    chipsDirectory: join(root, 'chips'),
  };
}

afterEach(async () => {
  await Promise.all(
    createdDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('readSessionDeckSnapshot', () => {
  it('returns a slim joined row with presence, identity, activity, and chip texts', async () => {
    const directories = await createSnapshotDirectories();

    await writePresenceRecord(buildPresenceRecord(), { directory: directories.presenceDirectory });
    await writeIdentityRecord(
      buildIdentityRecord({
        terminal: {
          kind: 'tmux',
          socketPath: '/tmp/tmux/default',
          sessionName: 'prod',
          windowName: 'editor',
          paneId: '%12',
        },
        runtimeSignals: {
          process: {
            pid: 101,
            ppid: 99,
            processStartedAt: '2026-06-23T11:59:30.000Z',
            ancestors: [{ pid: 99, ppid: 1, processStartedAt: '2026-06-23T11:59:00.000Z' }],
          },
          launch: {
            noSession: true,
            print: false,
            mode: 'rpc',
            sessionArgPresent: false,
            forkArgPresent: false,
          },
          stdio: {
            stdinTTY: false,
            stdoutTTY: true,
            stderrTTY: true,
          },
          inheritedDeckRuntime: {
            runtimeId: 'parent-runtime',
            sessionId: 'parent-session',
            sessionFile: '/tmp/parent-session.json',
            startedAt: '2026-06-23T11:58:00.000Z',
          },
        },
      }),
      { directory: directories.identityDirectory },
    );
    await writeActivityRecord(buildActivityRecord(), { directory: directories.activityDirectory });
    await writeChipRecord(buildChipRecord({ source: 'alpha', text: 'merge ready' }), {
      directory: directories.chipsDirectory,
    });
    await writeChipRecord(buildChipRecord({ source: 'beta', chipId: 'queue', text: 'queue 2' }), {
      directory: directories.chipsDirectory,
    });

    const snapshot = await readSessionDeckSnapshot({
      directory: directories.presenceDirectory,
      identityDirectory: directories.identityDirectory,
      activityDirectory: directories.activityDirectory,
      chipsDirectory: directories.chipsDirectory,
      now: new Date('2026-06-23T12:10:00.000Z'),
      inspectPid: vi.fn().mockResolvedValue({ status: 'matches' }),
    });

    expect(snapshot.generatedAt).toBe('2026-06-23T12:10:00.000Z');
    expect(snapshot.diagnostics).toEqual([]);
    expect(snapshot.records).toEqual([
      {
        runtimeId: 'rt-1',
        pid: 101,
        presenceState: 'live',
        presenceReason: 'fresh_heartbeat',
        heartbeatAgeMs: 5_000,
        sessionId: 'session-1',
        sessionName: 'alpha',
        repoName: 'repo',
        qualifiedRepoName: 'owner/repo',
        cwd: '/tmp/project',
        branch: 'main',
        prUrl: 'https://github.com/owner/repo/pull/42',
        isLinkedWorktree: false,
        worktreeLabel: null,
        derivedFacets: {
          persistence: 'file_backed',
          rowKind: 'durable_session',
          interactivity: 'headless',
          lifecycle: 'resume',
          lineage: 'previous_and_parent',
          identityStrength: 'strong',
          headerConsistency: 'consistent',
        },
        activityState: 'idle',
        activityAgeMs: null,
        currentToolName: null,
        lastError: null,
        compaction: null,
        chips: ['merge ready', 'queue 2'],
        diagnostics: [],
      },
    ]);

    const record = snapshot.records[0]!;
    for (const field of [
      'startedAt',
      'sessionFile',
      'worktree',
      'identityFreshness',
      'idle',
      'busy',
      'currentTurnStartedAt',
      'lastEventAt',
      'activityUpdatedAt',
      'inputSummary',
      'recentToolWindows',
      'sessionStartedAt',
      'sessionStart',
      'sessionHeader',
      'terminal',
      'terminalDisplay',
      'runtimeSignals',
      'socketPath',
      'paneId',
      'attachCommand',
      'sessionTarget',
      'previousSessionFile',
      'parentSession',
      'schemaVersion',
      'chipId',
      'scope',
      'level',
      'ttlMs',
      'updatedAt',
    ]) {
      expect(record).not.toHaveProperty(field);
    }
  });

  it('projects compacting as activity state with metadata even when chips are empty', async () => {
    const directories = await createSnapshotDirectories();

    await writePresenceRecord(buildPresenceRecord(), { directory: directories.presenceDirectory });
    await writeIdentityRecord(buildIdentityRecord(), { directory: directories.identityDirectory });
    await writeActivityRecord(
      buildActivityRecord({
        activityState: 'compacting',
        idle: false,
        busy: true,
        lastEventAt: '2026-06-23T12:09:58.000Z',
        activityUpdatedAt: '2026-06-23T12:09:58.000Z',
        activitySource: 'compaction_start',
        compaction: {
          state: 'running',
          startedAt: '2026-06-23T12:09:45.000Z',
          updatedAt: '2026-06-23T12:09:45.000Z',
          reason: 'manual',
          willRetry: false,
        },
      }),
      { directory: directories.activityDirectory },
    );

    const snapshot = await readSessionDeckSnapshot({
      directory: directories.presenceDirectory,
      identityDirectory: directories.identityDirectory,
      activityDirectory: directories.activityDirectory,
      chipsDirectory: directories.chipsDirectory,
      now: new Date('2026-06-23T12:10:00.000Z'),
      inspectPid: vi.fn().mockResolvedValue({ status: 'matches' }),
    });

    expect(snapshot.records[0]).toMatchObject({
      activityState: 'compacting',
      chips: [],
      compaction: {
        state: 'running',
        ageMs: 15_000,
        startedAt: '2026-06-23T12:09:45.000Z',
        reason: 'manual',
        willRetry: false,
      },
    });
  });

  it('projects only sanitized child runtime evidence into the public snapshot', async () => {
    const directories = await createSnapshotDirectories();

    await writePresenceRecord(
      buildPresenceRecord({
        runtimeId: 'rt-parent',
        pid: 101,
        startedAt: '2026-06-23T12:00:00.000Z',
      }),
      { directory: directories.presenceDirectory },
    );
    await writeIdentityRecord(
      buildIdentityRecord({
        runtimeId: 'rt-parent',
        sessionId: 'session-parent',
        sessionFile: '/tmp/session-parent.json',
        sessionHeader: {
          id: 'session-parent',
          timestamp: '2026-06-23T12:00:00.000Z',
          cwd: '/tmp/project',
        },
        runtimeSignals: {
          process: {
            pid: 101,
            ppid: 1,
            processStartedAt: '2026-06-23T12:00:00.000Z',
            ancestors: [],
          },
        },
      }),
      { directory: directories.identityDirectory },
    );
    await writeActivityRecord(
      buildActivityRecord({
        runtimeId: 'rt-parent',
        sessionId: 'session-parent',
        recentToolWindows: [
          {
            toolCallId: 'raw-tool-id',
            toolName: 'bash',
            startedAt: '2026-06-23T12:01:00.000Z',
            endedAt: '2026-06-23T12:02:00.000Z',
          },
        ],
      }),
      { directory: directories.activityDirectory },
    );

    await writePresenceRecord(
      buildPresenceRecord({
        runtimeId: 'rt-child',
        pid: 202,
        startedAt: '2026-06-23T12:01:30.000Z',
        heartbeatAt: '2026-06-23T12:09:56.000Z',
      }),
      { directory: directories.presenceDirectory },
    );
    await writeIdentityRecord(
      buildIdentityRecord({
        runtimeId: 'rt-child',
        sessionId: 'session-child',
        sessionFile: null,
        sessionName: 'child',
        sessionStartedAt: '2026-06-23T12:01:30.000Z',
        sessionStart: { reason: 'startup', mode: 'json', hasUI: false },
        sessionHeader: {
          id: 'session-child',
          timestamp: '2026-06-23T12:01:30.000Z',
          cwd: '/tmp/project',
        },
        runtimeSignals: {
          process: {
            pid: 202,
            ppid: 101,
            processStartedAt: '2026-06-23T12:01:30.000Z',
            ancestors: [{ pid: 101, ppid: 1, processStartedAt: '2026-06-23T12:00:00.000Z' }],
          },
          launch: {
            noSession: true,
            print: true,
            mode: 'json',
            sessionArgPresent: false,
            forkArgPresent: false,
          },
          inheritedDeckRuntime: {
            runtimeId: 'rt-parent',
            sessionId: 'session-parent',
            sessionFile: '/tmp/session-parent.json',
            startedAt: '2026-06-23T12:00:00.000Z',
          },
        },
      }),
      { directory: directories.identityDirectory },
    );
    await writeActivityRecord(
      buildActivityRecord({
        runtimeId: 'rt-child',
        sessionId: 'session-child',
        inputSummary: { lastSource: 'extension', counts: { extension: 1 } },
      }),
      { directory: directories.activityDirectory },
    );

    const snapshot = await readSessionDeckSnapshot({
      directory: directories.presenceDirectory,
      identityDirectory: directories.identityDirectory,
      activityDirectory: directories.activityDirectory,
      chipsDirectory: directories.chipsDirectory,
      now: new Date('2026-06-23T12:10:00.000Z'),
      inspectPid: vi.fn().mockResolvedValue({ status: 'matches' }),
    });

    const child = snapshot.records.find((record) => record.runtimeId === 'rt-child');
    expect(child?.derivedFacets?.rowKind).toBe('ephemeral_child_runtime');
    expect(child?.derivedFacets?.childRuntime).toMatchObject({
      candidate: true,
      confidence: 'high',
      parentRuntimeId: 'rt-parent',
      parentSessionId: 'session-parent',
    });
    expect(child?.derivedFacets?.childRuntime?.evidence.map((evidence) => evidence.code)).toEqual(
      expect.arrayContaining(['inherited_deck_runtime', 'process_ancestor_match']),
    );

    const serialized = JSON.stringify(child ?? {});
    expect(serialized).not.toContain('/tmp/session-parent.json');
    expect(serialized).not.toContain('raw-tool-id');
    expect(serialized).not.toContain('recentToolWindows');
    expect(serialized).not.toContain('inputSummary');
    expect(serialized).not.toContain('runtimeSignals');
  });

  it('orders session-deck rows by startedAt ascending before projecting the slim snapshot', async () => {
    const directories = await createSnapshotDirectories();

    await writePresenceRecord(
      buildPresenceRecord({
        runtimeId: 'rt-older',
        pid: 201,
        startedAt: '2026-06-23T11:00:00.000Z',
        heartbeatAt: '2026-06-23T12:09:40.000Z',
      }),
      { directory: directories.presenceDirectory },
    );
    await writePresenceRecord(
      buildPresenceRecord({
        runtimeId: 'rt-newer',
        pid: 202,
        startedAt: '2026-06-23T11:30:00.000Z',
        heartbeatAt: '2026-06-23T12:09:55.000Z',
      }),
      { directory: directories.presenceDirectory },
    );

    const snapshot = await readSessionDeckSnapshot({
      directory: directories.presenceDirectory,
      identityDirectory: directories.identityDirectory,
      activityDirectory: directories.activityDirectory,
      chipsDirectory: directories.chipsDirectory,
      now: new Date('2026-06-23T12:10:00.000Z'),
      inspectPid: vi.fn().mockResolvedValue({ status: 'matches' }),
    });

    expect(snapshot.records.map((record) => record.runtimeId)).toEqual(['rt-older', 'rt-newer']);
  });

  it('orders equal startedAt session-deck rows by runtimeId instead of heartbeat recency', async () => {
    const directories = await createSnapshotDirectories();

    await writePresenceRecord(
      buildPresenceRecord({
        runtimeId: 'rt-c',
        pid: 203,
        startedAt: '2026-06-23T11:00:00.000Z',
        heartbeatAt: '2026-06-23T12:09:59.000Z',
      }),
      { directory: directories.presenceDirectory },
    );
    await writePresenceRecord(
      buildPresenceRecord({
        runtimeId: 'rt-a',
        pid: 201,
        startedAt: '2026-06-23T11:00:00.000Z',
        heartbeatAt: '2026-06-23T12:09:30.000Z',
      }),
      { directory: directories.presenceDirectory },
    );
    await writePresenceRecord(
      buildPresenceRecord({
        runtimeId: 'rt-b',
        pid: 202,
        startedAt: '2026-06-23T11:00:00.000Z',
        heartbeatAt: '2026-06-23T12:09:45.000Z',
      }),
      { directory: directories.presenceDirectory },
    );

    const snapshot = await readSessionDeckSnapshot({
      directory: directories.presenceDirectory,
      identityDirectory: directories.identityDirectory,
      activityDirectory: directories.activityDirectory,
      chipsDirectory: directories.chipsDirectory,
      now: new Date('2026-06-23T12:10:00.000Z'),
      inspectPid: vi.fn().mockResolvedValue({ status: 'matches' }),
    });

    expect(snapshot.records.map((record) => record.runtimeId)).toEqual(['rt-a', 'rt-b', 'rt-c']);
  });

  it('prefers persisted repo fields even when worktree metadata is incomplete', async () => {
    const directories = await createSnapshotDirectories();

    await writePresenceRecord(buildPresenceRecord(), { directory: directories.presenceDirectory });
    await writeIdentityRecord(buildIdentityRecord({ worktree: null }), {
      directory: directories.identityDirectory,
    });
    await writeActivityRecord(buildActivityRecord(), { directory: directories.activityDirectory });

    const snapshot = await readSessionDeckSnapshot({
      directory: directories.presenceDirectory,
      identityDirectory: directories.identityDirectory,
      activityDirectory: directories.activityDirectory,
      chipsDirectory: directories.chipsDirectory,
      now: new Date('2026-06-23T12:10:00.000Z'),
      inspectPid: vi.fn().mockResolvedValue({ status: 'matches' }),
    });

    expect(snapshot.records[0]?.repoName).toBe('repo');
    expect(snapshot.records[0]?.qualifiedRepoName).toBe('owner/repo');
    expect(snapshot.records[0]).not.toHaveProperty('worktree');
    expect(snapshot.records[0]).not.toHaveProperty('gitRoot');
  });

  it('falls back to the worktree basename for legacy identity records without repo fields', async () => {
    const directories = await createSnapshotDirectories();

    await writePresenceRecord(buildPresenceRecord(), { directory: directories.presenceDirectory });
    await writeIdentityRecord(buildIdentityRecord({ repoName: null, qualifiedRepoName: null }), {
      directory: directories.identityDirectory,
    });
    await writeActivityRecord(buildActivityRecord(), { directory: directories.activityDirectory });

    const snapshot = await readSessionDeckSnapshot({
      directory: directories.presenceDirectory,
      identityDirectory: directories.identityDirectory,
      activityDirectory: directories.activityDirectory,
      chipsDirectory: directories.chipsDirectory,
      now: new Date('2026-06-23T12:10:00.000Z'),
      inspectPid: vi.fn().mockResolvedValue({ status: 'matches' }),
    });

    expect(snapshot.records[0]?.repoName).toBe('project');
    expect(snapshot.records[0]?.qualifiedRepoName).toBeNull();
  });

  it('projects linked-worktree display fields without exposing raw git paths', async () => {
    const directories = await createSnapshotDirectories();

    await writePresenceRecord(buildPresenceRecord(), { directory: directories.presenceDirectory });
    await writeIdentityRecord(
      buildIdentityRecord({
        isLinkedWorktree: true,
        worktreeLabel: 'feature-sandbox',
        gitRoot: '/tmp/project/.git/worktrees/feature-sandbox',
      }),
      { directory: directories.identityDirectory },
    );
    await writeActivityRecord(buildActivityRecord(), { directory: directories.activityDirectory });

    const snapshot = await readSessionDeckSnapshot({
      directory: directories.presenceDirectory,
      identityDirectory: directories.identityDirectory,
      activityDirectory: directories.activityDirectory,
      chipsDirectory: directories.chipsDirectory,
      now: new Date('2026-06-23T12:10:00.000Z'),
      inspectPid: vi.fn().mockResolvedValue({ status: 'matches' }),
    });

    expect(snapshot.records[0]?.isLinkedWorktree).toBe(true);
    expect(snapshot.records[0]?.worktreeLabel).toBe('feature-sandbox');
    expect(snapshot.records[0]).not.toHaveProperty('worktree');
    expect(snapshot.records[0]).not.toHaveProperty('gitRoot');
  });

  it('preserves duplicate visible chip texts from distinct raw records', async () => {
    const directories = await createSnapshotDirectories();

    await writePresenceRecord(buildPresenceRecord(), { directory: directories.presenceDirectory });
    await writeIdentityRecord(buildIdentityRecord(), { directory: directories.identityDirectory });
    await writeActivityRecord(buildActivityRecord(), { directory: directories.activityDirectory });
    await writeChipRecord(
      buildChipRecord({
        source: 'alpha',
        scope: 'runtime',
        sessionId: null,
        chipId: 'a',
        text: 'ready',
      }),
      { directory: directories.chipsDirectory },
    );
    await writeChipRecord(
      buildChipRecord({
        source: 'beta',
        scope: 'runtime',
        sessionId: null,
        chipId: 'b',
        text: 'ready',
      }),
      { directory: directories.chipsDirectory },
    );

    const snapshot = await readSessionDeckSnapshot({
      directory: directories.presenceDirectory,
      identityDirectory: directories.identityDirectory,
      activityDirectory: directories.activityDirectory,
      chipsDirectory: directories.chipsDirectory,
      now: new Date('2026-06-23T12:10:00.000Z'),
      inspectPid: vi.fn().mockResolvedValue({ status: 'matches' }),
    });

    expect(snapshot.records[0]?.chips).toEqual(['ready', 'ready']);
  });

  it('suppresses session-scoped chips when session membership is not trustworthy', async () => {
    const directories = await createSnapshotDirectories();

    await writePresenceRecord(buildPresenceRecord(), { directory: directories.presenceDirectory });
    await writeActivityRecord(
      buildActivityRecord({ sessionId: null, activityUpdatedAt: '2026-06-23T12:09:58.000Z' }),
      { directory: directories.activityDirectory },
    );
    await writeChipRecord(
      buildChipRecord({ sessionId: 'session-old', text: 'stale session chip' }),
      { directory: directories.chipsDirectory },
    );

    const snapshot = await readSessionDeckSnapshot({
      directory: directories.presenceDirectory,
      identityDirectory: directories.identityDirectory,
      activityDirectory: directories.activityDirectory,
      chipsDirectory: directories.chipsDirectory,
      now: new Date('2026-06-23T12:10:00.000Z'),
      inspectPid: vi.fn().mockResolvedValue({ status: 'matches' }),
    });

    expect(snapshot.records[0]?.sessionId).toBeNull();
    expect(snapshot.records[0]?.chips).toEqual([]);
    expect(snapshot.records[0]?.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'chip_session_mismatch',
    );
    expect(snapshot.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'chip_session_mismatch',
    );
  });

  it('suppresses old session chips when activity has moved to a new sessionId', async () => {
    const directories = await createSnapshotDirectories();

    await writePresenceRecord(buildPresenceRecord(), { directory: directories.presenceDirectory });
    await writeIdentityRecord(
      buildIdentityRecord({ sessionId: 'session-old', sessionFile: '/tmp/session-old.json' }),
      { directory: directories.identityDirectory },
    );
    await writeActivityRecord(
      buildActivityRecord({
        sessionId: 'session-new',
        activityUpdatedAt: '2026-06-23T12:09:58.000Z',
      }),
      { directory: directories.activityDirectory },
    );
    await writeChipRecord(
      buildChipRecord({ sessionId: 'session-old', text: 'stale session chip' }),
      { directory: directories.chipsDirectory },
    );

    const snapshot = await readSessionDeckSnapshot({
      directory: directories.presenceDirectory,
      identityDirectory: directories.identityDirectory,
      activityDirectory: directories.activityDirectory,
      chipsDirectory: directories.chipsDirectory,
      now: new Date('2026-06-23T12:10:00.000Z'),
      inspectPid: vi.fn().mockResolvedValue({ status: 'matches' }),
    });

    expect(snapshot.records[0]?.sessionId).toBe('session-old');
    expect(snapshot.records[0]?.activityState).toBe('unknown');
    expect(snapshot.records[0]?.chips).toEqual([]);
    expect(snapshot.records[0]?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(['session_mismatch', 'chip_session_mismatch']),
    );
    expect(snapshot.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(['session_mismatch', 'chip_session_mismatch']),
    );
  });

  it('carries expired chip diagnostics onto the row and top-level snapshot', async () => {
    const directories = await createSnapshotDirectories();

    await writePresenceRecord(buildPresenceRecord(), { directory: directories.presenceDirectory });
    await writeIdentityRecord(buildIdentityRecord(), { directory: directories.identityDirectory });
    await writeActivityRecord(buildActivityRecord(), { directory: directories.activityDirectory });
    await writeChipRecord(
      buildChipRecord({
        scope: 'runtime',
        sessionId: null,
        text: 'expired',
        updatedAt: '2026-06-23T12:00:00.000Z',
        ttlMs: 30_000,
      }),
      { directory: directories.chipsDirectory },
    );

    const snapshot = await readSessionDeckSnapshot({
      directory: directories.presenceDirectory,
      identityDirectory: directories.identityDirectory,
      activityDirectory: directories.activityDirectory,
      chipsDirectory: directories.chipsDirectory,
      now: new Date('2026-06-23T12:01:00.000Z'),
      inspectPid: vi.fn().mockResolvedValue({ status: 'matches' }),
    });

    expect(snapshot.records[0]?.chips).toEqual([]);
    expect(snapshot.records[0]?.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'chip_expired',
    );
    expect(snapshot.diagnostics.map((diagnostic) => diagnostic.code)).toContain('chip_expired');
  });
});
