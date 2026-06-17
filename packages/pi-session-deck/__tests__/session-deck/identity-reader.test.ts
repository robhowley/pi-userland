import type { Dirent } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { PresenceView } from '../../extensions/session-deck/presence/types.js';

function makePresenceView(overrides?: Partial<PresenceView>): PresenceView {
  return {
    records: [],
    diagnostics: [],
    ...overrides,
  };
}

describe('identity reader — join', () => {
  it('joins presence records with matching identity records', async () => {
    const { readJoinedSessionView } = await import(
      '../../extensions/session-deck/identity/reader.js'
    );

    const identityRecords: Record<string, unknown> = {
      'rt-1': {
        runtimeId: 'rt-1',
        sessionId: 'session-abc',
        sessionFile: '/tmp/session-abc.md',
        cwd: '/home/user/project',
        worktree: '/home/user/project',
        branch: 'main',
        prUrl: 'https://github.com/owner/repo/pull/42',
        identityUpdatedAt: new Date().toISOString(),
        sessionStartedAt: new Date().toISOString(),
        gitRemote: null,
        gitRoot: null,
        identitySource: 'startup',
      },
    };

    const readdirImpl = vi.fn().mockResolvedValue([
      { name: 'rt-1.json', isFile: () => true } as unknown as Dirent,
    ]);

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
    expect(record.branch).toBe('main');
    expect(record.cwd).toBe('/home/user/project');
    expect(record.prUrl).toBe('https://github.com/owner/repo/pull/42');
    expect(record.identityFreshness).toBe('fresh');
    expect(view.diagnostics).toHaveLength(0);
  });

  it('sets identity fields to null when identity record is missing', async () => {
    const { readJoinedSessionView } = await import(
      '../../extensions/session-deck/identity/reader.js'
    );

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
    expect(record.branch).toBeNull();
    expect(record.prUrl).toBeNull();
    expect(record.identityFreshness).toBe('missing');
  });

  it('reports orphan identity records via diagnostics', async () => {
    const { readJoinedSessionView } = await import(
      '../../extensions/session-deck/identity/reader.js'
    );

    const readdirImpl = vi.fn().mockResolvedValue([
      { name: 'orphan.json', isFile: () => true } as unknown as Dirent,
    ]);

    const orphanRecord = {
      runtimeId: 'orphan',
      sessionId: null,
      sessionFile: null,
      cwd: null,
      worktree: null,
      branch: null,
      prUrl: null,
      identityUpdatedAt: new Date().toISOString(),
      sessionStartedAt: new Date().toISOString(),
      gitRemote: null,
      gitRoot: null,
      identitySource: 'startup',
    };

    const readFileImpl = vi
      .fn()
      .mockResolvedValue(JSON.stringify(orphanRecord));

    const view = await readJoinedSessionView({
      presenceView: makePresenceView({ records: [] }),
      readdir: readdirImpl,
      readFile: readFileImpl,
    });

    expect(view.records).toHaveLength(0);
    expect(view.diagnostics.some((d) => d.code === 'orphan_identity')).toBe(true);
  });

  it('handles malformed identity JSON gracefully', async () => {
    const { readJoinedSessionView } = await import(
      '../../extensions/session-deck/identity/reader.js'
    );

    const readdirImpl = vi.fn().mockResolvedValue([
      { name: 'rt-1.json', isFile: () => true } as unknown as Dirent,
    ]);

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
    expect(view.diagnostics.some((d) => d.code === 'malformed_identity_record')).toBe(true);
  });

  it('computes identity freshness correctly', async () => {
    const { computeIdentityFreshness } = await import(
      '../../extensions/session-deck/identity/reader.js'
    );
    const nowMs = new Date('2026-06-17T12:00:00.000Z').getTime();

    // Fresh (≤2m)
    const fresh = {
      runtimeId: 'rt-1',
      sessionId: null,
      sessionFile: null,
      cwd: null,
      worktree: null,
      branch: null,
      prUrl: null,
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