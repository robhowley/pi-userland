import { describe, expect, it, vi } from 'vitest';
import type { SessionIdentityRecord } from '../../extensions/session-deck/identity/types.js';

describe('identity writer', () => {
  it('serializes a complete identity record to JSON', async () => {
    const { serializeIdentityRecord } =
      await import('../../extensions/session-deck/identity/writer.js');

    const record: SessionIdentityRecord = {
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
      isLinkedWorktree: false,
      worktreeLabel: null,
      identityUpdatedAt: '2026-06-17T12:00:00.000Z',
      sessionStartedAt: '2026-06-17T11:00:00.000Z',
      gitRemote: 'https://github.com/owner/repo.git',
      gitRoot: '/home/user/project/.git',
      identitySource: 'startup',
      sessionStart: {
        reason: 'resume',
        previousSessionFile: '/tmp/session-prev.md',
        mode: 'json',
        hasUI: false,
      },
      sessionHeader: {
        id: 'session-abc',
        timestamp: '2026-06-17T11:00:00.000Z',
        cwd: '/home/user/project',
        parentSession: '/tmp/session-parent.md',
      },
    };

    const json = serializeIdentityRecord(record);
    const parsed = JSON.parse(json);
    expect(parsed.runtimeId).toBe('rt-1');
    expect(parsed.sessionName).toBe('Focused session');
    expect(parsed.repoName).toBe('repo');
    expect(parsed.qualifiedRepoName).toBe('owner/repo');
    expect(parsed.branch).toBe('main');
    expect(parsed.prUrl).toBe('https://github.com/owner/repo/pull/42');
    expect(parsed.identitySource).toBe('startup');
    expect(parsed.sessionStart).toEqual({
      reason: 'resume',
      previousSessionFile: '/tmp/session-prev.md',
      mode: 'json',
      hasUI: false,
    });
    expect(parsed.sessionHeader).toEqual({
      id: 'session-abc',
      timestamp: '2026-06-17T11:00:00.000Z',
      cwd: '/home/user/project',
      parentSession: '/tmp/session-parent.md',
    });
  });

  it('serializes nullable fields correctly', async () => {
    const { serializeIdentityRecord } =
      await import('../../extensions/session-deck/identity/writer.js');

    const record: SessionIdentityRecord = {
      runtimeId: 'rt-2',
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
      identityUpdatedAt: '2026-06-17T12:00:00.000Z',
      sessionStartedAt: '2026-06-17T12:00:00.000Z',
      gitRemote: null,
      gitRoot: null,
      identitySource: 'new',
    };

    const json = serializeIdentityRecord(record);
    const parsed = JSON.parse(json);
    expect(parsed.runtimeId).toBe('rt-2');
    expect(parsed.sessionId).toBeNull();
    expect(parsed).not.toHaveProperty('sessionName');
    expect(parsed.cwd).toBeNull();
    expect(parsed.branch).toBeNull();
    expect(parsed.prUrl).toBeNull();
    expect(parsed.identitySource).toBe('new');
  });

  it('writes identity record atomically (temp + rename)', async () => {
    const { writeIdentityRecord } =
      await import('../../extensions/session-deck/identity/writer.js');

    const mkdir = vi.fn().mockResolvedValue(undefined);
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const rename = vi.fn().mockResolvedValue(undefined);
    const createTempPath = vi.fn().mockReturnValue('/tmp/.dir/rt-1.mock-temp.tmp');

    const record: SessionIdentityRecord = {
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
      identityUpdatedAt: '2026-06-17T12:00:00.000Z',
      sessionStartedAt: '2026-06-17T12:00:00.000Z',
      gitRemote: null,
      gitRoot: null,
      identitySource: 'startup',
    };

    const path = await writeIdentityRecord(record, {
      directory: '/tmp/.dir',
      mkdir,
      writeFile,
      rename,
      createTempPath,
    });

    expect(path).toBe('/tmp/.dir/rt-1.json');
    expect(mkdir).toHaveBeenCalledWith('/tmp/.dir', { recursive: true });
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledWith('/tmp/.dir/rt-1.mock-temp.tmp', '/tmp/.dir/rt-1.json');
  });

  it('rejects when mkdir fails', async () => {
    const { writeIdentityRecord } =
      await import('../../extensions/session-deck/identity/writer.js');

    const mkdir = vi.fn().mockRejectedValue(new Error('permission denied'));

    const record: SessionIdentityRecord = {
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
      identityUpdatedAt: '2026-06-17T12:00:00.000Z',
      sessionStartedAt: '2026-06-17T12:00:00.000Z',
      gitRemote: null,
      gitRoot: null,
      identitySource: 'startup',
    };

    await expect(
      writeIdentityRecord(record, {
        directory: '/tmp/.dir',
        mkdir,
      }),
    ).rejects.toThrow('permission denied');
  });
});
