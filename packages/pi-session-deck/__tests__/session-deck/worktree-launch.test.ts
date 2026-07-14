import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildManagedTmuxSessionName,
  buildPiLauncherCommand,
  launchDetachedTmuxPi,
} from '../../extensions/session-deck/worktree/launch.js';
import type { WorktreeExecFile } from '../../extensions/session-deck/worktree/git.js';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'session-deck-worktree-launch-'));
  tempDirectories.push(directory);
  return directory;
}

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

  it('starts tmux with fixed argv and returns requested-unobserved when presence has not appeared', async () => {
    const identityDirectory = await tempDir();
    const presenceDirectory = await tempDir();
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
        return {
          stdout: '',
          stderr: '',
          exitCode: calls.filter((call) => call.args[0] === 'has-session').length === 1 ? 1 : 0,
        };
      }
      if (file === 'tmux' && args[0] === 'new-session') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: 'unexpected', exitCode: 1 };
    };

    const result = await launchDetachedTmuxPi(
      {
        ok: true,
        status: 'created',
        path: '/tmp/repo-wt-feature',
        branch: 'worktree/feature',
        baseRef: 'origin/main',
        repoName: 'repo',
        qualifiedRepoName: 'owner/repo',
        manualCommand: 'git worktree add ...',
      },
      'Feature',
      { execFile, identityDirectory, presenceDirectory, observeTimeoutMs: 0 },
    );

    expect(result).toMatchObject({
      requested: true,
      ok: true,
      mode: 'tmux-detached',
      status: 'requested-unobserved',
    });
    if (!result.requested || !result.ok) {
      throw new Error('Expected successful launch result.');
    }
    expect(calls).toContainEqual({ file: 'tmux', args: ['-V'] });
    expect(calls).toContainEqual({ file: 'which', args: ['pi'] });
    expect(calls).toContainEqual({
      file: 'tmux',
      args: expect.arrayContaining([
        'new-session',
        '-d',
        '-s',
        result.tmuxSessionName,
        '-c',
        '/tmp/repo-wt-feature',
        'exec pi --name Feature',
      ]),
    });
  });
});
