import { describe, expect, it } from 'vitest';
import {
  buildManagedTmuxSessionName,
  buildPiLauncherCommand,
  launchDetachedTmuxPi,
} from '../../extensions/session-deck/worktree/launch.js';
import {
  defaultWorktreeExecFile,
  type WorktreeExecFile,
  type WorktreeExecFileOptions,
} from '../../extensions/session-deck/worktree/git.js';

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

  it('returns launched with one explicit environment and a symbolic pi command', async () => {
    const env: NodeJS.ProcessEnv = {
      HOME: '/Users/test',
      PATH: "/runtime/tools/bin:/tmp/with space:$HOME;`echo hi`:/tmp/O'Hare",
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

    const expectedLaunchCommand = buildPiLauncherCommand("Feature O'Hare", env['PATH'] ?? '');
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
    expect(expectedLaunchCommand).toContain(' pi --name ');
    expect(expectedLaunchCommand).not.toContain(whichPiPath);
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
      }),
    ).resolves.toMatchObject({
      requested: true,
      ok: false,
      reason: 'tmux-unavailable',
      manualCommand: `cd /tmp/repo-wt-feature && ${buildPiLauncherCommand('Feature', '', {
        mode: 'default',
      })}`,
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
});
