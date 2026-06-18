import { describe, expect, it, vi } from 'vitest';
import type { GitExec } from '../../extensions/session-deck/identity/types.js';

function makeExecGit(results: Record<string, { stdout: string; exitCode: number }>): GitExec {
  return vi.fn(async (_cwd: string, ...args: string[]) => {
    const key = args.join(' ');
    const result = results[key];
    if (result === undefined) {
      return { stdout: '', exitCode: 1 };
    }
    return result;
  }) as unknown as GitExec;
}

describe('identity collector', () => {
  it('collects session identity with Git info', async () => {
    const { collectSessionIdentity } =
      await import('../../extensions/session-deck/identity/collector.js');

    const execGit = makeExecGit({
      'rev-parse --show-toplevel': { stdout: '/home/user/project\n', exitCode: 0 },
      'rev-parse --abbrev-ref HEAD': { stdout: 'main\n', exitCode: 0 },
      'remote get-url origin': { stdout: 'https://github.com/owner/repo.git\n', exitCode: 0 },
      'rev-parse --git-dir': { stdout: '/home/user/project/.git\n', exitCode: 0 },
    });

    const mockSessionManager = {
      getSessionId: () => 'session-123',
      getSessionFile: () => '/tmp/session-123.json',
      getSessionName: () => 'Focused session',
    };

    const record = await collectSessionIdentity('rt-1', {
      runtimeId: 'rt-1',
      sessionManager: mockSessionManager,
      execGit,
      execGhCli: null,
      identitySource: 'startup',
      cwd: '/home/user/project',
      now: () => new Date('2026-06-17T12:00:00.000Z'),
    });

    expect(record.runtimeId).toBe('rt-1');
    expect(record.sessionId).toBe('session-123');
    expect(record.sessionFile).toBe('/tmp/session-123.json');
    expect(record.sessionName).toBe('Focused session');
    expect(record.cwd).toBe('/home/user/project');
    expect(record.worktree).toBe('/home/user/project');
    expect(record.branch).toBe('main');
    expect(record.gitRemote).toBe('https://github.com/owner/repo.git');
    expect(record.identitySource).toBe('startup');
  });

  it('omits sessionName when it is not set', async () => {
    const { collectSessionIdentity } =
      await import('../../extensions/session-deck/identity/collector.js');

    const execGit = makeExecGit({
      'rev-parse --show-toplevel': { stdout: '', exitCode: 128 },
    });

    const record = await collectSessionIdentity('rt-1', {
      runtimeId: 'rt-1',
      sessionManager: {
        getSessionId: () => 'session-123',
        getSessionFile: () => '/tmp/session-123.json',
        getSessionName: () => undefined,
      },
      execGit,
      execGhCli: null,
      identitySource: 'startup',
      cwd: '/tmp',
      now: () => new Date('2026-06-17T12:00:00.000Z'),
    });

    expect(record).not.toHaveProperty('sessionName');
  });

  it('falls back to process.cwd() when cwd option is not provided', async () => {
    const { collectSessionIdentity } =
      await import('../../extensions/session-deck/identity/collector.js');

    const execGit = makeExecGit({
      'rev-parse --show-toplevel': { stdout: '', exitCode: 128 },
    });

    const record = await collectSessionIdentity('rt-1', {
      runtimeId: 'rt-1',
      execGit,
      execGhCli: null,
      identitySource: 'startup',
      now: () => new Date('2026-06-17T12:00:00.000Z'),
    });

    expect(record.cwd).toBe(process.cwd());
  });

  it('preserves sessionStartedAt across periodic refreshes via existingRecord', async () => {
    const { collectSessionIdentity } =
      await import('../../extensions/session-deck/identity/collector.js');

    const execGit = makeExecGit({
      'rev-parse --show-toplevel': { stdout: '', exitCode: 128 },
    });

    const mockSessionManager = {
      getSessionId: () => 'session-456',
      getSessionFile: () => '/tmp/session-456.json',
    };

    const firstRecord = await collectSessionIdentity('rt-1', {
      runtimeId: 'rt-1',
      sessionManager: mockSessionManager,
      execGit,
      execGhCli: null,
      identitySource: 'startup',
      cwd: '/tmp',
      now: () => new Date('2026-06-17T12:00:00.000Z'),
    });

    expect(firstRecord.sessionStartedAt).toBe('2026-06-17T12:00:00.000Z');
    expect(firstRecord.identityUpdatedAt).toBe('2026-06-17T12:00:00.000Z');

    const secondRecord = await collectSessionIdentity('rt-1', {
      runtimeId: 'rt-1',
      sessionManager: mockSessionManager,
      execGit,
      execGhCli: null,
      identitySource: 'periodic',
      cwd: '/tmp',
      existingRecord: firstRecord,
      now: () => new Date('2026-06-17T12:05:00.000Z'),
    });

    expect(secondRecord.sessionStartedAt).toBe('2026-06-17T12:00:00.000Z');
    expect(secondRecord.identityUpdatedAt).toBe('2026-06-17T12:05:00.000Z');
  });

  it('emits diagnostics for missing session fields', async () => {
    const { collectSessionIdentity } =
      await import('../../extensions/session-deck/identity/collector.js');

    const execGit = makeExecGit({
      'rev-parse --show-toplevel': { stdout: '', exitCode: 128 },
    });

    const diagnostics: unknown[] = [];
    const onDiagnostic = vi.fn((d: unknown) => diagnostics.push(d));

    await collectSessionIdentity('rt-1', {
      runtimeId: 'rt-1',
      execGit,
      execGhCli: null,
      identitySource: 'startup',
      cwd: '/tmp',
      now: () => new Date('2026-06-17T12:00:00.000Z'),
      onDiagnostic,
    });

    expect(onDiagnostic).toHaveBeenCalled();
    const codes = diagnostics.map((d: any) => d.code);
    expect(codes).toContain('session_id_missing');
    expect(codes).toContain('session_file_missing');
  });

  it('emits diagnostics for non-git directory', async () => {
    const { collectSessionIdentity } =
      await import('../../extensions/session-deck/identity/collector.js');

    const execGit = makeExecGit({
      'rev-parse --show-toplevel': { stdout: '', exitCode: 128 },
    });

    const diagnostics: unknown[] = [];
    const onDiagnostic = vi.fn((d: unknown) => diagnostics.push(d));

    await collectSessionIdentity('rt-1', {
      runtimeId: 'rt-1',
      execGit,
      execGhCli: null,
      identitySource: 'startup',
      cwd: '/tmp',
      now: () => new Date('2026-06-17T12:00:00.000Z'),
      onDiagnostic,
    });

    expect(onDiagnostic).toHaveBeenCalled();
    const codes = diagnostics.map((d: any) => d.code);
    expect(codes).toContain('not_git_repo');
  });

  it('emits diagnostics for detached HEAD', async () => {
    const { collectSessionIdentity } =
      await import('../../extensions/session-deck/identity/collector.js');

    const execGit = makeExecGit({
      'rev-parse --show-toplevel': { stdout: '/home/user/project\n', exitCode: 0 },
      'rev-parse --abbrev-ref HEAD': { stdout: 'HEAD\n', exitCode: 0 },
      'remote get-url origin': { stdout: 'https://github.com/owner/repo.git\n', exitCode: 0 },
      'rev-parse --git-dir': { stdout: '/home/user/project/.git\n', exitCode: 0 },
    });

    const diagnostics: unknown[] = [];
    const onDiagnostic = vi.fn((d: unknown) => diagnostics.push(d));

    await collectSessionIdentity('rt-1', {
      runtimeId: 'rt-1',
      execGit,
      execGhCli: null,
      identitySource: 'startup',
      cwd: '/home/user/project',
      now: () => new Date('2026-06-17T12:00:00.000Z'),
      onDiagnostic,
    });

    const codes = diagnostics.map((d: any) => d.code);
    expect(codes).toContain('detached_head');
  });

  it('persists collector diagnostics on the returned record', async () => {
    const { collectSessionIdentity } =
      await import('../../extensions/session-deck/identity/collector.js');

    const execGit = makeExecGit({
      'rev-parse --show-toplevel': { stdout: '', exitCode: 128 },
    });

    const record = await collectSessionIdentity('rt-1', {
      runtimeId: 'rt-1',
      execGit,
      execGhCli: null,
      identitySource: 'startup',
      cwd: '/tmp',
      now: () => new Date('2026-06-17T12:00:00.000Z'),
    });

    expect(record.diagnostics?.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(['session_id_missing', 'session_file_missing', 'not_git_repo']),
    );
  });
});
