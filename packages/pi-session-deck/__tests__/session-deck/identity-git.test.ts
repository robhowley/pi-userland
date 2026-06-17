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

describe('identity git resolution', () => {
  it('resolves worktree, branch, remote, and root for a normal repo', async () => {
    const { resolveGitInfo } = await import('../../extensions/session-deck/identity/git.js');

    const execGit = makeExecGit({
      'rev-parse --show-toplevel': { stdout: '/home/user/project\n', exitCode: 0 },
      'rev-parse --abbrev-ref HEAD': { stdout: 'main\n', exitCode: 0 },
      'remote get-url origin': { stdout: 'https://github.com/owner/repo.git\n', exitCode: 0 },
      'rev-parse --git-dir': { stdout: '/home/user/project/.git\n', exitCode: 0 },
    });

    const info = await resolveGitInfo('/home/user/project', { execGit });

    expect(info.worktree).toBe('/home/user/project');
    expect(info.branch).toBe('main');
    expect(info.remote).toBe('https://github.com/owner/repo.git');
    expect(info.root).toBe('/home/user/project/.git');
  });

  it('returns null fields when not in a git repo', async () => {
    const { resolveGitInfo } = await import('../../extensions/session-deck/identity/git.js');

    const execGit = makeExecGit({
      'rev-parse --show-toplevel': { stdout: '', exitCode: 128 },
    });

    const info = await resolveGitInfo('/tmp', { execGit });

    expect(info.worktree).toBeNull();
    expect(info.branch).toBeNull();
    expect(info.remote).toBeNull();
    expect(info.root).toBeNull();
  });

  it('returns null branch on detached HEAD', async () => {
    const { resolveGitInfo } = await import('../../extensions/session-deck/identity/git.js');

    const execGit = makeExecGit({
      'rev-parse --show-toplevel': { stdout: '/home/user/project\n', exitCode: 0 },
      'rev-parse --abbrev-ref HEAD': { stdout: 'HEAD\n', exitCode: 0 },
      'remote get-url origin': { stdout: 'https://github.com/owner/repo.git\n', exitCode: 0 },
      'rev-parse --git-dir': { stdout: '/home/user/project/.git\n', exitCode: 0 },
    });

    const info = await resolveGitInfo('/home/user/project', { execGit });

    expect(info.worktree).toBe('/home/user/project');
    expect(info.branch).toBeNull();
    expect(info.remote).toBe('https://github.com/owner/repo.git');
  });

  it('uses gh CLI for PR URL when available', async () => {
    const { resolvePrUrl } = await import('../../extensions/session-deck/identity/git.js');

    const execGhCli = vi.fn().mockResolvedValue({
      stdout: 'https://github.com/owner/repo/pull/42\n',
      exitCode: 0,
    });

    const result = await resolvePrUrl('/home/user/project', 'feature-x', {
      execGhCli,
    });

    expect(result.prUrl).toBe('https://github.com/owner/repo/pull/42');
    expect(result.strategy).toBe('gh_cli');
  });

  it('falls back to git remote construction when gh CLI fails', async () => {
    const { resolvePrUrl } = await import('../../extensions/session-deck/identity/git.js');

    const execGhCli = vi.fn().mockRejectedValue(new Error('gh not installed'));
    const execGit = makeExecGit({
      'remote get-url origin': { stdout: 'https://github.com/owner/repo.git\n', exitCode: 0 },
    });

    const result = await resolvePrUrl('/home/user/project', 'feature-x', {
      execGhCli,
      execGit,
    });

    expect(result.prUrl).toBe('https://github.com/owner/repo/pull/feature-x');
    expect(result.strategy).toBe('git_remote_based');
  });

  it('returns null PR URL when git remote is not GitHub', async () => {
    const { resolvePrUrl } = await import('../../extensions/session-deck/identity/git.js');

    const execGhCli = vi.fn().mockRejectedValue(new Error('gh not installed'));
    const execGit = makeExecGit({
      'remote get-url origin': { stdout: 'https://gitlab.com/owner/repo.git\n', exitCode: 0 },
    });

    const result = await resolvePrUrl('/home/user/project', 'feature-x', {
      execGhCli,
      execGit,
    });

    expect(result.prUrl).toBeNull();
    expect(result.diagnostic).toBe('pr_lookup_failed');
  });

  it('returns null PR URL on detached HEAD', async () => {
    const { resolvePrUrl } = await import('../../extensions/session-deck/identity/git.js');

    const result = await resolvePrUrl('/home/user/project', null as never);

    expect(result.prUrl).toBeNull();
    expect(result.diagnostic).toBe('detached_head');
  });
});
