import { describe, expect, it, vi } from 'vitest';
import type {
  GitExec,
  SessionIdentityRecord,
  SessionManagerLike,
} from '../../extensions/session-deck/identity/types.js';

type UnsafeSessionManager = Omit<SessionManagerLike, 'getTerminal'> & {
  getTerminal?: () => unknown;
};

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

async function collectGitlessIdentityWithTerminal(
  terminal: unknown,
  options: {
    sessionId?: string;
    sessionFile?: string;
    existingRecord?: SessionIdentityRecord;
    now?: string;
  } = {},
): Promise<SessionIdentityRecord> {
  const { collectSessionIdentity } =
    await import('../../extensions/session-deck/identity/collector.js');
  const sessionId = options.sessionId ?? 'session-123';
  const sessionFile = options.sessionFile ?? '/tmp/session-123.json';
  const sessionManager: UnsafeSessionManager = {
    getSessionId: () => sessionId,
    getSessionFile: () => sessionFile,
    getCwd: () => '/tmp',
    ...(terminal === undefined ? {} : { getTerminal: () => terminal }),
  };

  return collectSessionIdentity('rt-1', {
    runtimeId: 'rt-1',
    sessionManager: sessionManager as SessionManagerLike,
    execGit: makeExecGit({
      'rev-parse --show-toplevel': { stdout: '', exitCode: 128 },
    }),
    execGhCli: null,
    identitySource: options.existingRecord === undefined ? 'startup' : 'periodic',
    ...(options.existingRecord === undefined ? {} : { existingRecord: options.existingRecord }),
    now: () => new Date(options.now ?? '2026-06-17T12:00:00.000Z'),
  });
}

describe('identity collector', () => {
  it('collects session identity with session-owned cwd, Git info, and future raw sessionStart strings', async () => {
    const { collectSessionIdentity } =
      await import('../../extensions/session-deck/identity/collector.js');

    const execGit = makeExecGit({
      'rev-parse --show-toplevel': { stdout: '/home/user/project\n', exitCode: 0 },
      'rev-parse --abbrev-ref HEAD': { stdout: 'main\n', exitCode: 0 },
      'remote get-url origin': { stdout: 'https://github.com/owner/repo.git\n', exitCode: 0 },
      'rev-parse --absolute-git-dir': { stdout: '/home/user/project/.git\n', exitCode: 0 },
      'rev-parse --path-format=absolute --git-common-dir': {
        stdout: '/home/user/project/.git\n',
        exitCode: 0,
      },
    });

    const mockSessionManager = {
      getSessionId: () => 'session-123',
      getSessionFile: () => '/tmp/session-123.json',
      getSessionName: () => 'Focused session',
      getCwd: () => '/home/user/project',
      getSessionStart: () => ({
        reason: 'reload_from_reconnect',
        previousSessionFile: '/tmp/session-122.json',
        mode: 'rpc-stream',
        hasUI: true,
      }),
      getHeader: () => ({
        id: 'session-123',
        timestamp: '2026-06-17T11:59:00.000Z',
        cwd: '/home/user/project',
        parentSession: '/tmp/session-parent.json',
      }),
    };

    const record = await collectSessionIdentity('rt-1', {
      runtimeId: 'rt-1',
      sessionManager: mockSessionManager,
      execGit,
      execGhCli: null,
      identitySource: 'startup',
      cwd: '/tmp/wrong-fallback',
      now: () => new Date('2026-06-17T12:00:00.000Z'),
    });

    expect(record.runtimeId).toBe('rt-1');
    expect(record.sessionId).toBe('session-123');
    expect(record.sessionFile).toBe('/tmp/session-123.json');
    expect(record.sessionName).toBe('Focused session');
    expect(record.cwd).toBe('/home/user/project');
    expect(record.worktree).toBe('/home/user/project');
    expect(record.repoName).toBe('repo');
    expect(record.qualifiedRepoName).toBe('owner/repo');
    expect(record.branch).toBe('main');
    expect(record.gitRemote).toBe('https://github.com/owner/repo.git');
    expect(record.isLinkedWorktree).toBe(false);
    expect(record.worktreeLabel).toBeNull();
    expect(record.identitySource).toBe('startup');
    expect(record.sessionStart).toEqual({
      reason: 'reload_from_reconnect',
      previousSessionFile: '/tmp/session-122.json',
      mode: 'rpc-stream',
      hasUI: true,
    });
    expect(record.sessionHeader).toEqual({
      id: 'session-123',
      timestamp: '2026-06-17T11:59:00.000Z',
      cwd: '/home/user/project',
      parentSession: '/tmp/session-parent.json',
    });
    expect(execGit).toHaveBeenCalledWith('/home/user/project', 'rev-parse', '--show-toplevel');
  });

  it('persists linked-worktree metadata as derived fields only', async () => {
    const { collectSessionIdentity } =
      await import('../../extensions/session-deck/identity/collector.js');

    const execGit = makeExecGit({
      'rev-parse --show-toplevel': { stdout: '/home/user/project-feature\n', exitCode: 0 },
      'rev-parse --abbrev-ref HEAD': { stdout: 'feature-x\n', exitCode: 0 },
      'remote get-url origin': { stdout: 'https://github.com/owner/repo.git\n', exitCode: 0 },
      'rev-parse --absolute-git-dir': {
        stdout: '/home/user/project/.git/worktrees/project-feature\n',
        exitCode: 0,
      },
      'rev-parse --path-format=absolute --git-common-dir': {
        stdout: '/home/user/project/.git\n',
        exitCode: 0,
      },
    });

    const record = await collectSessionIdentity('rt-1', {
      runtimeId: 'rt-1',
      sessionManager: {
        getSessionId: () => 'session-123',
        getSessionFile: () => '/tmp/session-123.json',
        getCwd: () => '/home/user/project-feature',
      },
      execGit,
      execGhCli: null,
      identitySource: 'startup',
      now: () => new Date('2026-06-17T12:00:00.000Z'),
    });

    expect(record.repoName).toBe('repo');
    expect(record.qualifiedRepoName).toBe('owner/repo');
    expect(record.isLinkedWorktree).toBe(true);
    expect(record.worktreeLabel).toBe('project-feature');
    expect(record.gitRoot).toBe('/home/user/project/.git/worktrees/project-feature');
  });

  it('falls back to explicit cwd when session-owned cwd is unavailable', async () => {
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
      },
      execGit,
      execGhCli: null,
      identitySource: 'startup',
      cwd: '/tmp/explicit-cwd',
      now: () => new Date('2026-06-17T12:00:00.000Z'),
    });

    expect(record.cwd).toBe('/tmp/explicit-cwd');
  });

  it('fails open when sessionManager callbacks throw', async () => {
    const { collectSessionIdentity } =
      await import('../../extensions/session-deck/identity/collector.js');

    const execGit = makeExecGit({
      'rev-parse --show-toplevel': { stdout: '', exitCode: 128 },
    });

    const record = await collectSessionIdentity('rt-1', {
      runtimeId: 'rt-1',
      sessionManager: {
        getSessionId: () => {
          throw new Error('session id unavailable');
        },
        getSessionFile: () => {
          throw new Error('session file unavailable');
        },
        getSessionName: () => {
          throw new Error('session name unavailable');
        },
        getCwd: () => {
          throw new Error('cwd unavailable');
        },
      },
      execGit,
      execGhCli: null,
      identitySource: 'startup',
      cwd: '/tmp/explicit-cwd',
      now: () => new Date('2026-06-17T12:00:00.000Z'),
    });

    expect(record.sessionId).toBeNull();
    expect(record.sessionFile).toBeNull();
    expect(record).not.toHaveProperty('sessionName');
    expect(record.cwd).toBe('/tmp/explicit-cwd');
    expect(record.diagnostics?.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(['session_id_missing', 'session_file_missing', 'not_git_repo']),
    );
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

  it('preserves sessionStartedAt across periodic refreshes for the same session identity', async () => {
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

  it('resets sessionStartedAt when existingRecord belongs to a different session identity', async () => {
    const { collectSessionIdentity } =
      await import('../../extensions/session-deck/identity/collector.js');

    const execGit = makeExecGit({
      'rev-parse --show-toplevel': { stdout: '', exitCode: 128 },
    });

    const firstRecord = await collectSessionIdentity('rt-1', {
      runtimeId: 'rt-1',
      sessionManager: {
        getSessionId: () => 'session-old',
        getSessionFile: () => '/tmp/session-old.json',
      },
      execGit,
      execGhCli: null,
      identitySource: 'startup',
      cwd: '/tmp',
      now: () => new Date('2026-06-17T12:00:00.000Z'),
    });

    const secondRecord = await collectSessionIdentity('rt-1', {
      runtimeId: 'rt-1',
      sessionManager: {
        getSessionId: () => 'session-new',
        getSessionFile: () => '/tmp/session-new.json',
      },
      execGit,
      execGhCli: null,
      identitySource: 'resume',
      cwd: '/tmp',
      existingRecord: firstRecord,
      now: () => new Date('2026-06-17T12:05:00.000Z'),
    });

    expect(secondRecord.sessionStartedAt).toBe('2026-06-17T12:05:00.000Z');
    expect(secondRecord.identityUpdatedAt).toBe('2026-06-17T12:05:00.000Z');
  });

  it('preserves raw session metadata from existingRecord when later refreshes omit it', async () => {
    const { collectSessionIdentity } =
      await import('../../extensions/session-deck/identity/collector.js');

    const execGit = makeExecGit({
      'rev-parse --show-toplevel': { stdout: '', exitCode: 128 },
    });

    const firstRecord = await collectSessionIdentity('rt-1', {
      runtimeId: 'rt-1',
      sessionManager: {
        getSessionId: () => 'session-456',
        getSessionFile: () => '/tmp/session-456.json',
        getSessionStart: () => ({
          reason: 'fork',
          previousSessionFile: '/tmp/session-123.json',
          mode: 'json',
          hasUI: false,
        }),
        getHeader: () => ({
          id: 'session-456',
          timestamp: '2026-06-17T12:00:00.000Z',
          cwd: '/tmp',
          parentSession: '/tmp/session-123.json',
        }),
      },
      execGit,
      execGhCli: null,
      identitySource: 'fork',
      cwd: '/tmp',
      now: () => new Date('2026-06-17T12:00:00.000Z'),
    });

    const secondRecord = await collectSessionIdentity('rt-1', {
      runtimeId: 'rt-1',
      sessionManager: {
        getSessionId: () => 'session-456',
        getSessionFile: () => '/tmp/session-456.json',
      },
      execGit,
      execGhCli: null,
      identitySource: 'periodic',
      cwd: '/tmp',
      existingRecord: firstRecord,
      now: () => new Date('2026-06-17T12:05:00.000Z'),
    });

    expect(secondRecord.sessionStart).toEqual(firstRecord.sessionStart);
    expect(secondRecord.sessionHeader).toEqual(firstRecord.sessionHeader);
  });

  it('collects normalized terminal metadata from the session manager', async () => {
    const record = await collectGitlessIdentityWithTerminal({
      kind: 'iterm2',
      sessionId: '  session:weird/value?  ',
      revealUrl: 'iterm2:///reveal?sessionid=ignored',
      termProgram: 'iTerm.app',
      lcTerminal: 'iTerm2',
      lcTerminalVersion: '3.6.11',
    });

    expect(record.terminal).toEqual({
      kind: 'iterm2',
      sessionId: 'session:weird/value?',
      revealUrl: 'iterm2:///reveal?sessionid=session%3Aweird%2Fvalue%3F',
      termProgram: 'iTerm.app',
      lcTerminal: 'iTerm2',
      lcTerminalVersion: '3.6.11',
    });
  });

  it.each([
    ['non-object', 'w0t0p0'],
    ['wrong kind', { kind: 'terminal', sessionId: 'w0t0p0' }],
    ['empty sessionId', { kind: 'iterm2', sessionId: '' }],
    ['trimmed-empty sessionId', { kind: 'iterm2', sessionId: '   ' }],
  ] as const)('omits malformed terminal metadata: %s', async (_name, terminal) => {
    const record = await collectGitlessIdentityWithTerminal(terminal);

    expect(record).not.toHaveProperty('terminal');
  });

  it('accepts non-empty terminal session ids without regex validation', async () => {
    const record = await collectGitlessIdentityWithTerminal({
      kind: 'iterm2',
      sessionId: 'definitely-not-a-uuid',
      revealUrl: 'ignored',
    });

    expect(record.terminal).toEqual({
      kind: 'iterm2',
      sessionId: 'definitely-not-a-uuid',
      revealUrl: 'iterm2:///reveal?sessionid=definitely-not-a-uuid',
    });
  });

  it('preserves existing terminal metadata when later refreshes omit it', async () => {
    const firstRecord = await collectGitlessIdentityWithTerminal(
      {
        kind: 'iterm2',
        sessionId: 'w0t0p0:terminal',
        revealUrl: 'ignored',
      },
      {
        sessionId: 'session-456',
        sessionFile: '/tmp/session-456.json',
      },
    );

    const secondRecord = await collectGitlessIdentityWithTerminal(undefined, {
      sessionId: 'session-456',
      sessionFile: '/tmp/session-456.json',
      existingRecord: firstRecord,
      now: '2026-06-17T12:05:00.000Z',
    });

    expect(secondRecord.terminal).toEqual(firstRecord.terminal);
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
      'rev-parse --absolute-git-dir': { stdout: '/home/user/project/.git\n', exitCode: 0 },
      'rev-parse --path-format=absolute --git-common-dir': {
        stdout: '/home/user/project/.git\n',
        exitCode: 0,
      },
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
