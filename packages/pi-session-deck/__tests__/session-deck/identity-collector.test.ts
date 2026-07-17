import { describe, expect, it, vi } from 'vitest';
import type {
  GitExec,
  SessionIdentityRecord,
  SessionManagerLike,
} from '../../extensions/session-deck/identity/types.js';

type UnsafeSessionManager = Omit<SessionManagerLike, 'getTerminal' | 'getRuntimeSignals'> & {
  getTerminal?: () => unknown;
  getRuntimeSignals?: () => unknown;
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
    runtimeSignals?: unknown;
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
    ...(options.runtimeSignals === undefined
      ? {}
      : { getRuntimeSignals: () => options.runtimeSignals }),
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

  it('collects normalized tmux terminal metadata from the session manager', async () => {
    const record = await collectGitlessIdentityWithTerminal({
      kind: 'tmux',
      socketPath: ' /tmp/tmux/default ',
      sessionName: ' prod ',
      sessionId: ' $1 ',
      windowName: ' editor ',
      paneId: ' %12 ',
      panePid: '12345',
      attachCommand: 'exec pi',
    });

    expect(record.terminal).toEqual({
      kind: 'tmux',
      socketPath: '/tmp/tmux/default',
      sessionName: 'prod',
      sessionId: '$1',
      windowName: 'editor',
      paneId: '%12',
      panePid: 12345,
    });
  });

  it.each([
    ['non-object', 'w0t0p0'],
    ['wrong kind', { kind: 'terminal', sessionId: 'w0t0p0' }],
    ['empty sessionId', { kind: 'iterm2', sessionId: '' }],
    ['trimmed-empty sessionId', { kind: 'iterm2', sessionId: '   ' }],
    ['tmux without sessionName', { kind: 'tmux', socketPath: '/tmp/tmux/default' }],
    ['tmux without socket selector', { kind: 'tmux', sessionName: 'prod' }],
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

  it('preserves existing terminal metadata when later refreshes omit it for the same Pi session', async () => {
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

  it('does not preserve existing terminal metadata across different Pi sessions', async () => {
    const firstRecord = await collectGitlessIdentityWithTerminal(
      {
        kind: 'tmux',
        socketPath: '/tmp/tmux/default',
        sessionName: 'prod',
      },
      {
        sessionId: 'session-old',
        sessionFile: '/tmp/session-old.json',
      },
    );

    const secondRecord = await collectGitlessIdentityWithTerminal(undefined, {
      sessionId: 'session-new',
      sessionFile: '/tmp/session-new.json',
      existingRecord: firstRecord,
      now: '2026-06-17T12:05:00.000Z',
    });

    expect(secondRecord).not.toHaveProperty('terminal');
  });

  it('collects normalized runtime signals from the session manager', async () => {
    const record = await collectGitlessIdentityWithTerminal(undefined, {
      runtimeSignals: {
        process: {
          pid: '321',
          ppid: '123',
          processStartedAt: ' 2026-07-16T12:00:00.000Z ',
          ancestors: [
            { pid: '123', ppid: '1', processStartedAt: '2026-07-16T11:59:00.000Z' },
            { pid: 1, ppid: 0, processStartedAt: '' },
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
      },
    });

    expect(record.runtimeSignals).toEqual({
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

  it('preserves existing runtime signals when later refreshes omit them for the same Pi session', async () => {
    const firstRecord = await collectGitlessIdentityWithTerminal(undefined, {
      sessionId: 'session-456',
      sessionFile: '/tmp/session-456.json',
      runtimeSignals: {
        process: {
          pid: 321,
          ppid: 123,
          ancestors: [{ pid: 123 }],
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
          stdoutTTY: false,
          stderrTTY: false,
        },
      },
    });

    const secondRecord = await collectGitlessIdentityWithTerminal(undefined, {
      sessionId: 'session-456',
      sessionFile: '/tmp/session-456.json',
      existingRecord: firstRecord,
      now: '2026-06-17T12:05:00.000Z',
    });

    expect(secondRecord.runtimeSignals).toEqual(firstRecord.runtimeSignals);
  });

  it('does not preserve existing runtime signals across different Pi sessions', async () => {
    const firstRecord = await collectGitlessIdentityWithTerminal(undefined, {
      sessionId: 'session-old',
      sessionFile: '/tmp/session-old.json',
      runtimeSignals: {
        process: {
          pid: 321,
          ppid: 123,
          ancestors: [{ pid: 123 }],
        },
        stdio: {
          stdinTTY: false,
          stdoutTTY: false,
          stderrTTY: false,
        },
      },
    });

    const secondRecord = await collectGitlessIdentityWithTerminal(undefined, {
      sessionId: 'session-new',
      sessionFile: '/tmp/session-new.json',
      existingRecord: firstRecord,
      now: '2026-06-17T12:05:00.000Z',
    });

    expect(secondRecord).not.toHaveProperty('runtimeSignals');
  });

  it('drops malformed runtime signal subobjects without rejecting the identity record', async () => {
    const record = await collectGitlessIdentityWithTerminal(undefined, {
      runtimeSignals: {
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
      },
    });

    expect(record.sessionId).toBe('session-123');
    expect(record.runtimeSignals).toEqual({
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
