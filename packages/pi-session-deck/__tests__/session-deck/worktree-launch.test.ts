import { describe, expect, it } from 'vitest';
import {
  buildFreshTmuxSessionName,
  buildManagedTmuxSessionName,
  buildPiLauncherCommand,
  buildTmuxEnvironmentArgs,
  launchDetachedTmuxPi,
  launchDetachedTmuxPiForCwd,
  launchFreshDetachedTmuxPiForCwd,
} from '../../extensions/session-deck/worktree/launch.js';
import {
  defaultWorktreeExecFile,
  type WorktreeExecFile,
  type WorktreeExecFileOptions,
} from '../../extensions/session-deck/worktree/git.js';

const FRESH_RUNTIME_IDS = [
  '123e4567-e89b-42d3-a456-426614174000',
  '223e4567-e89b-42d3-a456-426614174000',
  '323e4567-e89b-42d3-a456-426614174000',
] as const;

const CREATED_WORKTREE = {
  ok: true as const,
  status: 'created' as const,
  path: '/tmp/repo-wt-feature',
  branch: 'worktree/feature',
  baseRef: 'origin/main',
  repoName: 'repo',
  qualifiedRepoName: 'owner/repo',
  manualCommand: 'git worktree add ...',
};

type ExecCall = {
  file: string;
  args: readonly string[];
  options: WorktreeExecFileOptions;
};

describe('session-deck detached tmux launch', () => {
  it('passes explicit env to the default exec helper without mutating process.env', async () => {
    const envKey = 'PI_SESSION_DECK_WORKTREE_EXEC_TEST';
    const originalValue = process.env[envKey];
    delete process.env[envKey];

    try {
      const result = await defaultWorktreeExecFile(
        process.execPath,
        ['-e', `process.stdout.write(process.env.${envKey} ?? 'missing')`],
        {
          env: { ...process.env, [envKey]: 'from-child' },
          timeoutMs: 10_000,
        },
      );

      expect(result).toEqual({ stdout: 'from-child', stderr: '', exitCode: 0 });
      expect(process.env[envKey]).toBeUndefined();
    } finally {
      if (originalValue === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = originalValue;
      }
    }
  });

  it('builds safe bounded tmux session names and quoted Pi launcher commands', () => {
    const sessionName = buildManagedTmuxSessionName({
      repoName: 'owner/repo',
      worktreePath: '/tmp/repo-wt-feature',
      label: "Feature O'Hare",
    });

    expect(sessionName).toMatch(/^pi-owner-repo-feature-o-hare-[a-f0-9]{8}$/u);
    expect(sessionName.length).toBeLessThanOrEqual(80);
    expect(
      buildFreshTmuxSessionName({
        cwd: '/tmp/repo-wt-feature',
        label: "Feature O'Hare",
        runtimeId: FRESH_RUNTIME_IDS[0],
      }),
    ).toMatch(/^pi-repo-wt-feature-feature-o-hare-123e4567-e89b-42d3-a456-426614174000$/u);
    expect(
      buildFreshTmuxSessionName({
        cwd: `/tmp/${'long-name-'.repeat(20)}`,
        label: 'long session name',
        runtimeId: FRESH_RUNTIME_IDS[0],
      }).length,
    ).toBeLessThanOrEqual(80);
    expect(
      buildPiLauncherCommand(
        "Feature O'Hare",
        "/runtime/tools/bin:/tmp/with space:$HOME;`echo hi`:/tmp/O'Hare",
      ),
    ).toBe(
      "exec /usr/bin/env 'PATH=/runtime/tools/bin:/tmp/with space:$HOME;`echo hi`:/tmp/O'\\''Hare' pi --name 'Feature O'\\''Hare'",
    );
    expect(buildPiLauncherCommand('Feature', '/runtime/bin', { mode: 'default' })).toBe(
      'exec /usr/bin/env -u PI_CODING_AGENT_DIR PATH=/runtime/bin pi --name Feature',
    );
    expect(
      buildPiLauncherCommand('Feature', '/runtime/bin', {
        mode: 'custom',
        customDir: "/Users/test/.pi/agent O'Hare",
      }),
    ).toBe(
      "exec /usr/bin/env PATH=/runtime/bin 'PI_CODING_AGENT_DIR=/Users/test/.pi/agent O'\\''Hare' pi --name Feature",
    );
  });

  it('starts every fresh same-cwd request with its one UUID in the private name and child command', async () => {
    const env: NodeJS.ProcessEnv = {
      PATH: '/runtime/bin',
      PI_SESSION_DECK_RUNTIME_ID: 'parent-runtime',
    };
    const newSessionArgs: (readonly string[])[] = [];
    const execFile: WorktreeExecFile = async (file, args) => {
      if (file === 'tmux' && args[0] === '-V') {
        return { stdout: 'tmux 3.4\n', stderr: '', exitCode: 0 };
      }
      if (file === 'which') {
        return { stdout: '/runtime/pi/bin/pi\n', stderr: '', exitCode: 0 };
      }
      if (file === 'tmux' && args[0] === 'has-session') {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      if (file === 'tmux' && args[0] === 'new-session') {
        newSessionArgs.push(args);
        return { stdout: `$${newSessionArgs.length}\n`, stderr: '', exitCode: 0 };
      }
      if (file === 'tmux' && args[0] === 'display-message') {
        return { stdout: '/tmp/scratch\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: `unexpected ${file} ${args.join(' ')}`, exitCode: 1 };
    };

    const results = [];
    for (const runtimeId of FRESH_RUNTIME_IDS) {
      results.push(
        await launchFreshDetachedTmuxPiForCwd({ cwd: '/tmp/scratch', repoName: null }, 'scratch', {
          execFile,
          env,
          postLaunchVerifyDelayMs: 0,
          randomUUID: () => runtimeId,
        }),
      );
    }

    expect(results.map((result) => result.ok && result.runtimeId)).toEqual(FRESH_RUNTIME_IDS);
    const names = results.map((result) => result.ok && result.tmuxSessionName);
    expect(new Set(names).size).toBe(3);
    expect(names).toEqual(FRESH_RUNTIME_IDS.map((runtimeId) => `pi-scratch-scratch-${runtimeId}`));
    expect(newSessionArgs).toHaveLength(3);
    for (const [index, args] of newSessionArgs.entries()) {
      const command = args.at(-1) ?? '';
      const assignment = `PI_SESSION_DECK_ASSIGNED_RUNTIME_ID=${FRESH_RUNTIME_IDS[index]}`;
      expect(command.split(assignment)).toHaveLength(2);
      expect(args.slice(0, 4)).toEqual(['new-session', '-P', '-F', '#{session_id}']);
      expect(args).toContain('PI_SESSION_DECK_RUNTIME_ID=parent-runtime');
      expect(args.slice(0, -1).join(' ')).not.toContain('PI_SESSION_DECK_ASSIGNED_RUNTIME_ID');
    }
  });

  it('rejects an invalid fresh runtime identity before touching tmux', async () => {
    const execFile: WorktreeExecFile = async () => {
      throw new Error('tmux must not run');
    };

    await expect(
      launchFreshDetachedTmuxPiForCwd({ cwd: '/tmp/scratch', repoName: null }, 'scratch', {
        execFile,
        randomUUID: () => '../not-a-uuid',
      }),
    ).rejects.toThrow('Fresh runtime identity generator must return a safe UUID v4.');
  });

  it('fails a fresh generated-name collision without inspecting, reusing, or killing it', async () => {
    const operations: string[] = [];
    const execFile: WorktreeExecFile = async (file, args) => {
      operations.push(`${file} ${args[0] ?? ''}`);
      if (file === 'tmux' && args[0] === '-V') {
        return { stdout: 'tmux 3.4\n', stderr: '', exitCode: 0 };
      }
      if (file === 'which') {
        return { stdout: '/runtime/pi/bin/pi\n', stderr: '', exitCode: 0 };
      }
      if (file === 'tmux' && args[0] === 'has-session') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: 'unexpected', exitCode: 1 };
    };

    await expect(
      launchFreshDetachedTmuxPiForCwd({ cwd: '/tmp/scratch', repoName: null }, 'scratch', {
        execFile,
        randomUUID: () => FRESH_RUNTIME_IDS[0],
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'tmux-name-collision' });
    expect(operations).toEqual(['tmux -V', 'which pi', 'tmux has-session']);
  });

  it('does not kill a fresh target when tmux spawn fails', async () => {
    const operations: string[] = [];
    const execFile: WorktreeExecFile = async (file, args) => {
      operations.push(`${file} ${args[0] ?? ''}`);
      if (file === 'tmux' && args[0] === '-V') {
        return { stdout: 'tmux 3.4\n', stderr: '', exitCode: 0 };
      }
      if (file === 'which') {
        return { stdout: '/runtime/pi/bin/pi\n', stderr: '', exitCode: 0 };
      }
      if (file === 'tmux' && args[0] === 'has-session') {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      if (file === 'tmux' && args[0] === 'new-session') {
        return { stdout: '', stderr: 'spawn failed', exitCode: 1 };
      }
      return { stdout: '', stderr: 'unexpected', exitCode: 1 };
    };

    await expect(
      launchFreshDetachedTmuxPiForCwd({ cwd: '/tmp/scratch', repoName: null }, 'scratch', {
        execFile,
        randomUUID: () => FRESH_RUNTIME_IDS[0],
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'spawn-failed' });
    expect(operations).not.toContain('tmux kill-session');
  });

  it.each(['throws', 'exits nonzero'] as const)(
    'returns a non-retryable cleanup failure when cleanup %s',
    async (cleanupMode) => {
      const calls: ExecCall[] = [];
      const execFile: WorktreeExecFile = async (file, args, options) => {
        calls.push({ file, args, options });
        if (file === 'tmux' && args[0] === '-V') {
          return { stdout: 'tmux 3.4\n', stderr: '', exitCode: 0 };
        }
        if (file === 'which') {
          return { stdout: '/runtime/pi/bin/pi\n', stderr: '', exitCode: 0 };
        }
        if (file === 'tmux' && args[0] === 'has-session') {
          return { stdout: '', stderr: '', exitCode: 1 };
        }
        if (file === 'tmux' && args[0] === 'new-session') {
          return { stdout: '$42\n', stderr: '', exitCode: 0 };
        }
        if (file === 'tmux' && args[0] === 'display-message') {
          return { stdout: '/tmp/wrong\n', stderr: '', exitCode: 0 };
        }
        if (file === 'tmux' && args[0] === 'kill-session') {
          if (cleanupMode === 'throws') {
            throw new Error('cleanup unavailable');
          }
          return { stdout: '', stderr: 'cleanup unavailable', exitCode: 1 };
        }
        return { stdout: '', stderr: 'unexpected', exitCode: 1 };
      };

      await expect(
        launchFreshDetachedTmuxPiForCwd({ cwd: '/tmp/scratch', repoName: null }, 'scratch', {
          execFile,
          postLaunchVerifyDelayMs: 0,
          randomUUID: () => FRESH_RUNTIME_IDS[0],
        }),
      ).resolves.toMatchObject({
        ok: false,
        reason: 'cleanup-failed',
        recoverable: false,
        runtimeId: FRESH_RUNTIME_IDS[0],
      });
      expect(calls.filter((call) => call.args[0] === 'kill-session')).toEqual([
        expect.objectContaining({
          file: 'tmux',
          args: ['kill-session', '-t', '$42'],
        }),
      ]);
    },
  );

  it.each(['\n', 'not-a-session-id\n'] as const)(
    'uses the exact generated session name when tmux reports an invalid session ID (%j)',
    async (stdout) => {
      const calls: ExecCall[] = [];
      const execFile: WorktreeExecFile = async (file, args, options) => {
        calls.push({ file, args, options });
        if (file === 'tmux' && args[0] === '-V') {
          return { stdout: 'tmux 3.4\n', stderr: '', exitCode: 0 };
        }
        if (file === 'which') {
          return { stdout: '/runtime/pi/bin/pi\n', stderr: '', exitCode: 0 };
        }
        if (file === 'tmux' && args[0] === 'has-session') {
          return { stdout: '', stderr: '', exitCode: 1 };
        }
        if (file === 'tmux' && args[0] === 'new-session') {
          return { stdout, stderr: '', exitCode: 0 };
        }
        if (file === 'tmux' && args[0] === 'display-message') {
          return { stdout: '/tmp/wrong\n', stderr: '', exitCode: 0 };
        }
        if (file === 'tmux' && args[0] === 'kill-session') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: 'unexpected', exitCode: 1 };
      };

      const result = await launchFreshDetachedTmuxPiForCwd(
        { cwd: '/tmp/scratch', repoName: null },
        'scratch',
        {
          execFile,
          postLaunchVerifyDelayMs: 0,
          randomUUID: () => FRESH_RUNTIME_IDS[0],
        },
      );

      expect(result).toMatchObject({
        ok: false,
        reason: 'presence-timeout',
        recoverable: true,
      });
      expect(result).not.toHaveProperty('runtimeId');
      const sessionName = buildFreshTmuxSessionName({
        cwd: '/tmp/scratch',
        label: 'scratch',
        runtimeId: FRESH_RUNTIME_IDS[0],
      });
      expect(calls.filter((call) => call.args[0] === 'kill-session')).toEqual([
        expect.objectContaining({
          file: 'tmux',
          args: ['kill-session', '-t', `=${sessionName}`],
        }),
      ]);
    },
  );

  it('passes current Session Deck handoff env through tmux-owned launches explicitly', async () => {
    const env: NodeJS.ProcessEnv = {
      PI_SESSION_DECK_RUNTIME_ID: 'rt-parent',
      PI_SESSION_DECK_SESSION_ID: 'session-parent',
      PI_SESSION_DECK_SESSION_FILE: '/tmp/session-parent.md',
      PI_SESSION_DECK_RUNTIME_STARTED_AT: '2026-07-17T12:00:00.000Z',
      PI_SESSION_DECK_ASSIGNED_RUNTIME_ID: 'not-a-parent-handoff',
    };

    expect(buildTmuxEnvironmentArgs(env)).toEqual([
      '-e',
      'PI_SESSION_DECK_RUNTIME_ID=rt-parent',
      '-e',
      'PI_SESSION_DECK_SESSION_ID=session-parent',
      '-e',
      'PI_SESSION_DECK_SESSION_FILE=/tmp/session-parent.md',
      '-e',
      'PI_SESSION_DECK_RUNTIME_STARTED_AT=2026-07-17T12:00:00.000Z',
    ]);
  });

  it('returns launched with one assigned runtime and the exact resolved Pi executable', async () => {
    const env: NodeJS.ProcessEnv = {
      HOME: '/Users/test',
      PATH: "/runtime/tools/bin:/tmp/with space:$HOME;`echo hi`:/tmp/O'Hare",
      PI_SESSION_DECK_RUNTIME_ID: 'rt-parent',
      PI_SESSION_DECK_SESSION_ID: 'session-parent',
      PI_SESSION_DECK_RUNTIME_STARTED_AT: '2026-07-17T12:00:00.000Z',
    };
    const whichPiPath = '/custom/tools/pi';
    const calls: ExecCall[] = [];
    const execFile: WorktreeExecFile = async (file, args, options) => {
      calls.push({ file, args, options });
      if (file === 'tmux' && args[0] === '-V') {
        return { stdout: 'tmux 3.4\n', stderr: '', exitCode: 0 };
      }
      if (file === 'which') {
        return { stdout: `${whichPiPath}\n`, stderr: '', exitCode: 0 };
      }
      if (file === 'tmux' && args[0] === 'has-session') {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      if (file === 'tmux' && args[0] === 'new-session') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (file === 'tmux' && args[0] === 'display-message') {
        return { stdout: '/tmp/repo-wt-feature\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: `unexpected ${file} ${args.join(' ')}`, exitCode: 1 };
    };

    const result = await launchDetachedTmuxPi(CREATED_WORKTREE, "Feature O'Hare", {
      execFile,
      env,
      postLaunchVerifyDelayMs: 0,
      randomUUID: () => FRESH_RUNTIME_IDS[0],
    });

    expect(result).toMatchObject({
      requested: true,
      ok: true,
      mode: 'tmux-detached',
      status: 'launched',
      message: 'Started a detached tmux Pi session.',
    });
    if (!result.requested || !result.ok) {
      throw new Error('Expected successful launch result.');
    }

    const expectedLaunchCommand = buildPiLauncherCommand(
      "Feature O'Hare",
      env['PATH'] ?? '',
      { mode: 'ambient' },
      FRESH_RUNTIME_IDS[0],
      whichPiPath,
      null,
    );
    expect(calls.map(({ file, args }) => ({ file, args }))).toEqual([
      { file: 'tmux', args: ['-V'] },
      { file: 'which', args: ['pi'] },
      { file: 'tmux', args: ['has-session', '-t', `=${result.tmuxSessionName}`] },
      {
        file: 'tmux',
        args: [
          'new-session',
          '-e',
          'PI_SESSION_DECK_RUNTIME_ID=rt-parent',
          '-e',
          'PI_SESSION_DECK_SESSION_ID=session-parent',
          '-e',
          'PI_SESSION_DECK_RUNTIME_STARTED_AT=2026-07-17T12:00:00.000Z',
          '-d',
          '-s',
          result.tmuxSessionName,
          '-c',
          '/tmp/repo-wt-feature',
          '-n',
          'feature-o-hare',
          expectedLaunchCommand,
        ],
      },
      {
        file: 'tmux',
        args: [
          'display-message',
          '-p',
          '-t',
          `=${result.tmuxSessionName}:0.0`,
          '#{pane_current_path}',
        ],
      },
    ]);
    for (const call of calls) {
      expect(call.options.env).toBe(env);
      expect(call.options.timeoutMs).toBe(10_000);
    }
    expect(expectedLaunchCommand).toContain('/usr/bin/env');
    expect(expectedLaunchCommand).toContain(` ${whichPiPath} --name `);
    expect(expectedLaunchCommand).not.toContain(' pi --name ');
  });

  it('reuses only the generated session name when cwd matches exactly', async () => {
    const originalPath = process.env['PATH'];
    const env: NodeJS.ProcessEnv = {
      HOME: '/Users/test',
      PATH: '/custom/reuse/path:$HOME;`echo hi`',
    };
    let expectedSessionName = '';
    const calls: ExecCall[] = [];
    const execFile: WorktreeExecFile = async (file, args, options) => {
      calls.push({ file, args, options });
      if (file === 'tmux' && args[0] === '-V') {
        return { stdout: 'tmux 3.4\n', stderr: '', exitCode: 0 };
      }
      if (file === 'which') {
        return { stdout: '/runtime/pi/bin/pi\n', stderr: '', exitCode: 0 };
      }
      if (file === 'tmux' && args[0] === 'has-session') {
        expect(args[2]).toBe(`=${expectedSessionName}`);
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (file === 'tmux' && args[0] === 'display-message') {
        return { stdout: '/tmp/repo-wt-feature\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: `unexpected ${file} ${args.join(' ')}`, exitCode: 1 };
    };

    expectedSessionName = buildManagedTmuxSessionName({
      repoName: CREATED_WORKTREE.repoName,
      worktreePath: CREATED_WORKTREE.path,
      label: 'Feature',
    });

    const result = await launchDetachedTmuxPi(CREATED_WORKTREE, 'Feature', { execFile, env });

    expect(result).toMatchObject({
      requested: true,
      ok: true,
      mode: 'tmux-detached',
      status: 'reused-existing',
      tmuxSessionName: expectedSessionName,
    });
    expect(calls.some((call) => call.args[0] === 'new-session')).toBe(false);
    expect(calls.some((call) => call.args[0] === 'set-environment')).toBe(false);
    for (const call of calls) {
      expect(call.options.env).toBe(env);
      expect(call.options.timeoutMs).toBe(10_000);
    }
    expect(process.env['PATH']).toBe(originalPath);
  });

  it('fails closed for explicit agent dir modes on existing unmarked sessions', async () => {
    const execFile: WorktreeExecFile = async (file, args) => {
      if (file === 'tmux' && args[0] === '-V') {
        return { stdout: 'tmux 3.4\n', stderr: '', exitCode: 0 };
      }
      if (file === 'which') {
        return { stdout: '/runtime/pi/bin/pi\n', stderr: '', exitCode: 0 };
      }
      if (file === 'tmux' && args[0] === 'has-session') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (file === 'tmux' && args[0] === 'display-message') {
        return { stdout: '/tmp/repo-wt-feature\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: `unexpected ${file} ${args.join(' ')}`, exitCode: 1 };
    };

    await expect(
      launchDetachedTmuxPi(CREATED_WORKTREE, 'Feature', {
        execFile,
        agentDir: { mode: 'default' },
      }),
    ).resolves.toMatchObject({
      requested: true,
      ok: false,
      mode: 'tmux-detached',
      status: 'failed',
      reason: 'launch-context-mismatch',
    });
  });

  it('fails when the generated tmux name is already bound to another cwd', async () => {
    const execFile: WorktreeExecFile = async (file, args) => {
      if (file === 'tmux' && args[0] === '-V') {
        return { stdout: 'tmux 3.4\n', stderr: '', exitCode: 0 };
      }
      if (file === 'which') {
        return { stdout: '/runtime/pi/bin/pi\n', stderr: '', exitCode: 0 };
      }
      if (file === 'tmux' && args[0] === 'has-session') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (file === 'tmux' && args[0] === 'display-message') {
        return { stdout: '/tmp/other-worktree\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: `unexpected ${file} ${args.join(' ')}`, exitCode: 1 };
    };

    await expect(
      launchDetachedTmuxPi(CREATED_WORKTREE, 'Feature', { execFile }),
    ).resolves.toMatchObject({
      requested: true,
      ok: false,
      mode: 'tmux-detached',
      status: 'failed',
      reason: 'tmux-name-collision',
    });
  });

  it('uses the same agent dir env plan in manual fallback commands', async () => {
    const execFile: WorktreeExecFile = async (file) => {
      if (file === 'tmux') {
        return { stdout: '', stderr: 'tmux missing', exitCode: 1 };
      }
      return { stdout: '', stderr: `unexpected ${file}`, exitCode: 1 };
    };

    await expect(
      launchDetachedTmuxPi(CREATED_WORKTREE, 'Feature', {
        execFile,
        env: { PATH: '' },
        agentDir: { mode: 'default' },
        randomUUID: () => FRESH_RUNTIME_IDS[0],
      }),
    ).resolves.toMatchObject({
      requested: true,
      ok: false,
      reason: 'tmux-unavailable',
      manualCommand: `cd /tmp/repo-wt-feature && ${buildPiLauncherCommand(
        'Feature',
        '',
        { mode: 'default' },
        FRESH_RUNTIME_IDS[0],
      )}`,
    });
  });

  it('returns spawn-failed when tmux new-session exits nonzero', async () => {
    const execFile: WorktreeExecFile = async (file, args) => {
      if (file === 'tmux' && args[0] === '-V') {
        return { stdout: 'tmux 3.4\n', stderr: '', exitCode: 0 };
      }
      if (file === 'which') {
        return { stdout: '/runtime/pi/bin/pi\n', stderr: '', exitCode: 0 };
      }
      if (file === 'tmux' && args[0] === 'has-session') {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      if (file === 'tmux' && args[0] === 'new-session') {
        return { stdout: '', stderr: 'spawn boom', exitCode: 1 };
      }
      return { stdout: '', stderr: `unexpected ${file} ${args.join(' ')}`, exitCode: 1 };
    };

    await expect(
      launchDetachedTmuxPi(CREATED_WORKTREE, 'Feature', { execFile }),
    ).resolves.toMatchObject({
      requested: true,
      ok: false,
      mode: 'tmux-detached',
      status: 'failed',
      reason: 'spawn-failed',
      message: 'Created worktree, but tmux could not start Pi: spawn boom',
    });
  });

  it('returns presence-timeout when the launched tmux session is gone before verification', async () => {
    const execFile: WorktreeExecFile = async (file, args) => {
      if (file === 'tmux' && args[0] === '-V') {
        return { stdout: 'tmux 3.4\n', stderr: '', exitCode: 0 };
      }
      if (file === 'which') {
        return { stdout: '/runtime/pi/bin/pi\n', stderr: '', exitCode: 0 };
      }
      if (file === 'tmux' && args[0] === 'has-session') {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      if (file === 'tmux' && args[0] === 'new-session') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (file === 'tmux' && args[0] === 'display-message') {
        return { stdout: '', stderr: "can't find pane", exitCode: 1 };
      }
      return { stdout: '', stderr: `unexpected ${file} ${args.join(' ')}`, exitCode: 1 };
    };

    await expect(
      launchDetachedTmuxPi(CREATED_WORKTREE, 'Feature', {
        execFile,
        postLaunchVerifyDelayMs: 0,
      }),
    ).resolves.toMatchObject({
      requested: true,
      ok: false,
      mode: 'tmux-detached',
      status: 'failed',
      reason: 'presence-timeout',
      message: 'Created worktree, but Pi did not remain running in tmux.',
    });
  });

  it('launchDetachedTmuxPiForCwd launches tmux with the cwd target and custom agent dir', async () => {
    const env: NodeJS.ProcessEnv = { PATH: '/runtime/bin' };
    const calls: ExecCall[] = [];
    const execFile: WorktreeExecFile = async (file, args, options) => {
      calls.push({ file, args, options });
      if (file === 'tmux' && args[0] === '-V') {
        return { stdout: 'tmux 3.4\n', stderr: '', exitCode: 0 };
      }
      if (file === 'which') {
        return { stdout: '/runtime/pi/bin/pi\n', stderr: '', exitCode: 0 };
      }
      if (file === 'tmux' && args[0] === 'has-session') {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      if (file === 'tmux' && args[0] === 'new-session') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (file === 'tmux' && args[0] === 'display-message') {
        return { stdout: '/tmp/scratch\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: `unexpected ${file} ${args.join(' ')}`, exitCode: 1 };
    };

    const result = await launchDetachedTmuxPiForCwd(
      { cwd: '/tmp/scratch', repoName: null },
      'scratch',
      {
        execFile,
        env,
        postLaunchVerifyDelayMs: 0,
        agentDir: { mode: 'custom', customDir: '/Users/test/.pi/agent-custom' },
        randomUUID: () => FRESH_RUNTIME_IDS[0],
      },
    );

    expect(result).toMatchObject({
      requested: true,
      ok: true,
      mode: 'tmux-detached',
      status: 'launched',
    });
    if (!result.requested || !result.ok) {
      throw new Error('Expected successful launch result.');
    }
    expect(calls.map(({ file, args }) => ({ file, args }))).toEqual([
      { file: 'tmux', args: ['-V'] },
      { file: 'which', args: ['pi'] },
      { file: 'tmux', args: ['has-session', '-t', `=${result.tmuxSessionName}`] },
      {
        file: 'tmux',
        args: [
          'new-session',
          '-d',
          '-s',
          result.tmuxSessionName,
          '-c',
          '/tmp/scratch',
          '-n',
          'scratch',
          buildPiLauncherCommand(
            'scratch',
            '/runtime/bin',
            { mode: 'custom', customDir: '/Users/test/.pi/agent-custom' },
            FRESH_RUNTIME_IDS[0],
            '/runtime/pi/bin/pi',
            null,
          ),
        ],
      },
      {
        file: 'tmux',
        args: [
          'display-message',
          '-p',
          '-t',
          `=${result.tmuxSessionName}:0.0`,
          '#{pane_current_path}',
        ],
      },
    ]);
  });

  it('launchDetachedTmuxPiForCwd reuses an existing session when cwd matches', async () => {
    const calls: ExecCall[] = [];
    let expectedSessionName = '';
    const execFile: WorktreeExecFile = async (file, args, options) => {
      calls.push({ file, args, options });
      if (file === 'tmux' && args[0] === '-V') {
        return { stdout: 'tmux 3.4\n', stderr: '', exitCode: 0 };
      }
      if (file === 'which') {
        return { stdout: '/runtime/pi/bin/pi\n', stderr: '', exitCode: 0 };
      }
      if (file === 'tmux' && args[0] === 'has-session') {
        expect(args[2]).toBe(`=${expectedSessionName}`);
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (file === 'tmux' && args[0] === 'display-message') {
        return { stdout: '/tmp/scratch\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: `unexpected ${file} ${args.join(' ')}`, exitCode: 1 };
    };

    expectedSessionName = buildManagedTmuxSessionName({
      repoName: null,
      worktreePath: '/tmp/scratch',
      label: 'scratch',
    });

    const result = await launchDetachedTmuxPiForCwd(
      { cwd: '/tmp/scratch', repoName: null },
      'scratch',
      { execFile },
    );

    expect(result).toMatchObject({
      requested: true,
      ok: true,
      mode: 'tmux-detached',
      status: 'reused-existing',
      tmuxSessionName: expectedSessionName,
    });
    expect(calls.some((call) => call.args[0] === 'new-session')).toBe(false);
  });

  it('launchDetachedTmuxPiForCwd uses session-specific collision copy', async () => {
    const execFile: WorktreeExecFile = async (file, args) => {
      if (file === 'tmux' && args[0] === '-V') {
        return { stdout: 'tmux 3.4\n', stderr: '', exitCode: 0 };
      }
      if (file === 'which') {
        return { stdout: '/runtime/pi/bin/pi\n', stderr: '', exitCode: 0 };
      }
      if (file === 'tmux' && args[0] === 'has-session') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (file === 'tmux' && args[0] === 'display-message') {
        return { stdout: '/tmp/other\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: `unexpected ${file} ${args.join(' ')}`, exitCode: 1 };
    };

    await expect(
      launchDetachedTmuxPiForCwd({ cwd: '/tmp/scratch', repoName: null }, 'scratch', { execFile }),
    ).resolves.toMatchObject({
      requested: true,
      ok: false,
      mode: 'tmux-detached',
      status: 'failed',
      reason: 'tmux-name-collision',
      message:
        'Pi did not start because the generated tmux session name is already in use for a different cwd.',
    });
  });

  it('launchDetachedTmuxPiForCwd uses session-specific verification copy', async () => {
    const execFile: WorktreeExecFile = async (file, args) => {
      if (file === 'tmux' && args[0] === '-V') {
        return { stdout: 'tmux 3.4\n', stderr: '', exitCode: 0 };
      }
      if (file === 'which') {
        return { stdout: '/runtime/pi/bin/pi\n', stderr: '', exitCode: 0 };
      }
      if (file === 'tmux' && args[0] === 'has-session') {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      if (file === 'tmux' && args[0] === 'new-session') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (file === 'tmux' && args[0] === 'display-message') {
        return { stdout: '/tmp/other\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: `unexpected ${file} ${args.join(' ')}`, exitCode: 1 };
    };

    await expect(
      launchDetachedTmuxPiForCwd({ cwd: '/tmp/scratch', repoName: null }, 'scratch', {
        execFile,
        postLaunchVerifyDelayMs: 0,
      }),
    ).resolves.toMatchObject({
      requested: true,
      ok: false,
      mode: 'tmux-detached',
      status: 'failed',
      reason: 'presence-timeout',
      message: 'The launched tmux pane is not in the requested cwd.',
    });
  });
});
