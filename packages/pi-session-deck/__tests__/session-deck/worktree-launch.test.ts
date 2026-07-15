import { describe, expect, it } from 'vitest';
import {
  buildManagedTmuxSessionName,
  buildPiLauncherCommand,
  launchDetachedTmuxPi,
} from '../../extensions/session-deck/worktree/launch.js';
import type { WorktreeExecFile } from '../../extensions/session-deck/worktree/git.js';

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

describe('session-deck detached tmux launch', () => {
  it('builds safe bounded tmux session names and quoted Pi launcher commands', () => {
    const sessionName = buildManagedTmuxSessionName({
      repoName: 'owner/repo',
      worktreePath: '/tmp/repo-wt-feature',
      label: "Feature O'Hare",
    });

    expect(sessionName).toMatch(/^pi-owner-repo-feature-o-hare-[a-f0-9]{8}$/u);
    expect(sessionName.length).toBeLessThanOrEqual(80);
    expect(buildPiLauncherCommand("Feature O'Hare")).toBe("exec pi --name 'Feature O'\\''Hare'");
  });

  it('returns launched as soon as tmux new-session succeeds', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const execFile: WorktreeExecFile = async (file, args) => {
      calls.push({ file, args });
      if (file === 'tmux' && args[0] === '-V') {
        return { stdout: 'tmux 3.4\n', stderr: '', exitCode: 0 };
      }
      if (file === 'which') {
        return { stdout: '/usr/local/bin/pi\n', stderr: '', exitCode: 0 };
      }
      if (file === 'tmux' && args[0] === 'has-session') {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      if (file === 'tmux' && args[0] === 'new-session') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: `unexpected ${file} ${args.join(' ')}`, exitCode: 1 };
    };

    const result = await launchDetachedTmuxPi(CREATED_WORKTREE, 'Feature', { execFile });

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

    expect(calls).toEqual([
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
          'feature',
          'exec pi --name Feature',
        ],
      },
    ]);
  });

  it('reuses only the generated session name when cwd matches exactly', async () => {
    let expectedSessionName = '';
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const execFile: WorktreeExecFile = async (file, args) => {
      calls.push({ file, args });
      if (file === 'tmux' && args[0] === '-V') {
        return { stdout: 'tmux 3.4\n', stderr: '', exitCode: 0 };
      }
      if (file === 'which') {
        return { stdout: '/usr/local/bin/pi\n', stderr: '', exitCode: 0 };
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

    const result = await launchDetachedTmuxPi(CREATED_WORKTREE, 'Feature', { execFile });

    expect(result).toMatchObject({
      requested: true,
      ok: true,
      mode: 'tmux-detached',
      status: 'reused-existing',
      tmuxSessionName: expectedSessionName,
    });
    expect(calls.some((call) => call.args[0] === 'new-session')).toBe(false);
  });

  it('fails when the generated tmux name is already bound to another cwd', async () => {
    const execFile: WorktreeExecFile = async (file, args) => {
      if (file === 'tmux' && args[0] === '-V') {
        return { stdout: 'tmux 3.4\n', stderr: '', exitCode: 0 };
      }
      if (file === 'which') {
        return { stdout: '/usr/local/bin/pi\n', stderr: '', exitCode: 0 };
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

  it('returns spawn-failed when tmux new-session exits nonzero', async () => {
    const execFile: WorktreeExecFile = async (file, args) => {
      if (file === 'tmux' && args[0] === '-V') {
        return { stdout: 'tmux 3.4\n', stderr: '', exitCode: 0 };
      }
      if (file === 'which') {
        return { stdout: '/usr/local/bin/pi\n', stderr: '', exitCode: 0 };
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
});
