import { describe, expect, it, vi } from 'vitest';
import type { GhExec, GitExec } from '../../extensions/session-deck/identity/types.js';

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
  it('resolves repo identity from origin before checkout metadata fallbacks', async () => {
    const { resolveGitInfo } = await import('../../extensions/session-deck/identity/git.js');

    const execGit = makeExecGit({
      'rev-parse --show-toplevel': { stdout: '/home/user/project\n', exitCode: 0 },
      'rev-parse --abbrev-ref HEAD': { stdout: 'main\n', exitCode: 0 },
      'remote get-url origin': { stdout: 'https://github.com/owner/repo.git\n', exitCode: 0 },
      'remote -v': {
        stdout:
          'origin\thttps://github.com/owner/repo.git (fetch)\n' +
          'origin\thttps://github.com/owner/repo.git (push)\n',
        exitCode: 0,
      },
      'rev-parse --absolute-git-dir': { stdout: '/home/user/project/.git\n', exitCode: 0 },
      'rev-parse --path-format=absolute --git-common-dir': {
        stdout: '/home/user/project/.git\n',
        exitCode: 0,
      },
    });

    const info = await resolveGitInfo('/home/user/project', { execGit });

    expect(info.worktree).toBe('/home/user/project');
    expect(info.branch).toBe('main');
    expect(info.remote).toBe('https://github.com/owner/repo.git');
    expect(info.root).toBe('/home/user/project/.git');
    expect(info.repoName).toBe('repo');
    expect(info.qualifiedRepoName).toBe('owner/repo');
    expect(info.isLinkedWorktree).toBe(false);
    expect(info.worktreeLabel).toBeNull();
  });

  it('returns null repo fields when not in a git repo', async () => {
    const { resolveGitInfo } = await import('../../extensions/session-deck/identity/git.js');

    const execGit = makeExecGit({
      'rev-parse --show-toplevel': { stdout: '', exitCode: 128 },
    });

    const info = await resolveGitInfo('/tmp', { execGit });

    expect(info.worktree).toBeNull();
    expect(info.branch).toBeNull();
    expect(info.remote).toBeNull();
    expect(info.root).toBeNull();
    expect(info.repoName).toBeNull();
    expect(info.qualifiedRepoName).toBeNull();
    expect(info.isLinkedWorktree).toBeNull();
    expect(info.worktreeLabel).toBeNull();
  });

  it('returns null branch on detached HEAD while keeping repo identity', async () => {
    const { resolveGitInfo } = await import('../../extensions/session-deck/identity/git.js');

    const execGit = makeExecGit({
      'rev-parse --show-toplevel': { stdout: '/home/user/project\n', exitCode: 0 },
      'rev-parse --abbrev-ref HEAD': { stdout: 'HEAD\n', exitCode: 0 },
      'remote get-url origin': { stdout: 'https://github.com/owner/repo.git\n', exitCode: 0 },
      'remote -v': {
        stdout:
          'origin\thttps://github.com/owner/repo.git (fetch)\n' +
          'origin\thttps://github.com/owner/repo.git (push)\n',
        exitCode: 0,
      },
      'rev-parse --absolute-git-dir': { stdout: '/home/user/project/.git\n', exitCode: 0 },
      'rev-parse --path-format=absolute --git-common-dir': {
        stdout: '/home/user/project/.git\n',
        exitCode: 0,
      },
    });

    const info = await resolveGitInfo('/home/user/project', { execGit });

    expect(info.worktree).toBe('/home/user/project');
    expect(info.branch).toBeNull();
    expect(info.remote).toBe('https://github.com/owner/repo.git');
    expect(info.repoName).toBe('repo');
    expect(info.qualifiedRepoName).toBe('owner/repo');
    expect(info.isLinkedWorktree).toBe(false);
    expect(info.worktreeLabel).toBeNull();
  });

  it('falls back to the first non-origin fetch remote for qualified repo identity', async () => {
    const { resolveGitInfo } = await import('../../extensions/session-deck/identity/git.js');

    const execGit = makeExecGit({
      'rev-parse --show-toplevel': { stdout: '/home/user/worktrees/pr-123\n', exitCode: 0 },
      'rev-parse --abbrev-ref HEAD': { stdout: 'feature-x\n', exitCode: 0 },
      'remote get-url origin': { stdout: '', exitCode: 128 },
      'remote -v': {
        stdout:
          'upstream\tgit@github.com:Shopify/shop-ml.git (fetch)\n' +
          'upstream\tgit@github.com:Shopify/shop-ml.git (push)\n' +
          'fork\tgit@github.com:someone/other.git (fetch)\n',
        exitCode: 0,
      },
      'rev-parse --absolute-git-dir': {
        stdout: '/home/user/project/.git/worktrees/pr-123\n',
        exitCode: 0,
      },
      'rev-parse --path-format=absolute --git-common-dir': {
        stdout: '/home/user/project/.git\n',
        exitCode: 0,
      },
    });

    const info = await resolveGitInfo('/home/user/worktrees/pr-123', { execGit });

    expect(info.remote).toBeNull();
    expect(info.repoName).toBe('shop-ml');
    expect(info.qualifiedRepoName).toBe('Shopify/shop-ml');
    expect(info.isLinkedWorktree).toBe(true);
    expect(info.worktreeLabel).toBe('pr-123');
  });

  it('falls back to the normalized common git dir when no remote can be parsed', async () => {
    const { resolveGitInfo } = await import('../../extensions/session-deck/identity/git.js');

    const execGit = makeExecGit({
      'rev-parse --show-toplevel': { stdout: '/home/user/worktrees/pr-123\n', exitCode: 0 },
      'rev-parse --abbrev-ref HEAD': { stdout: 'feature-x\n', exitCode: 0 },
      'remote get-url origin': { stdout: 'file:///srv/git/shop-ml.git\n', exitCode: 0 },
      'remote -v': {
        stdout:
          'origin\tfile:///srv/git/shop-ml.git (fetch)\n' +
          'origin\tfile:///srv/git/shop-ml.git (push)\n' +
          'fork\tfile:///srv/git/fork.git (fetch)\n',
        exitCode: 0,
      },
      'rev-parse --absolute-git-dir': {
        stdout: '/home/user/project/.git/worktrees/pr-123\n',
        exitCode: 0,
      },
      'rev-parse --path-format=absolute --git-common-dir': {
        stdout: '/home/user/shop-ml/.git\n',
        exitCode: 0,
      },
    });

    const info = await resolveGitInfo('/home/user/worktrees/pr-123', { execGit });

    expect(info.repoName).toBe('shop-ml');
    expect(info.qualifiedRepoName).toBeNull();
    expect(info.isLinkedWorktree).toBe(false);
    expect(info.worktreeLabel).toBeNull();
  });

  it('falls back to the worktree basename when common git-dir lookup is unavailable', async () => {
    const { resolveGitInfo } = await import('../../extensions/session-deck/identity/git.js');

    const execGit = makeExecGit({
      'rev-parse --show-toplevel': { stdout: '/home/user/worktrees/pr-123\n', exitCode: 0 },
      'rev-parse --abbrev-ref HEAD': { stdout: 'feature-x\n', exitCode: 0 },
      'remote get-url origin': { stdout: 'file:///srv/git/shop-ml.git\n', exitCode: 0 },
      'remote -v': {
        stdout:
          'origin\tfile:///srv/git/shop-ml.git (fetch)\n' +
          'origin\tfile:///srv/git/shop-ml.git (push)\n',
        exitCode: 0,
      },
      'rev-parse --absolute-git-dir': {
        stdout: '/home/user/project/.git/worktrees/pr-123\n',
        exitCode: 0,
      },
      'rev-parse --path-format=absolute --git-common-dir': { stdout: '', exitCode: 128 },
    });

    const info = await resolveGitInfo('/home/user/worktrees/pr-123', { execGit });

    expect(info.root).toBe('/home/user/project/.git/worktrees/pr-123');
    expect(info.repoName).toBe('pr-123');
    expect(info.qualifiedRepoName).toBeNull();
    expect(info.isLinkedWorktree).toBeNull();
    expect(info.worktreeLabel).toBeNull();
  });

  it('uses gh CLI for PR URL when available', async () => {
    const { resolvePrUrl } = await import('../../extensions/session-deck/identity/git.js');

    const execGhCli: GhExec = vi.fn().mockResolvedValue({
      stdout: 'https://github.com/owner/repo/pull/42\n',
      exitCode: 0,
    });

    const result = await resolvePrUrl('/home/user/project', 'feature-x', {
      execGhCli,
    });

    expect(result.prUrl).toBe('https://github.com/owner/repo/pull/42');
    expect(result.strategy).toBe('gh_cli');
    expect(vi.mocked(execGhCli)).toHaveBeenCalledWith('/home/user/project', [
      'pr',
      'view',
      'feature-x',
      '--json',
      'url',
      '--jq',
      '.url',
    ]);
  });

  it('returns null with pr_ambiguous when gh CLI is unavailable', async () => {
    const { resolvePrUrl } = await import('../../extensions/session-deck/identity/git.js');

    const execGhCli: GhExec = vi.fn().mockRejectedValue(new Error('gh not installed'));
    const execGit = makeExecGit({
      'remote get-url origin': { stdout: 'https://github.com/owner/repo.git\n', exitCode: 0 },
    });

    const result = await resolvePrUrl('/home/user/project', 'feature-x', {
      execGhCli,
      execGit,
    });

    expect(result.prUrl).toBeNull();
    expect(result.strategy).toBe('gh_cli_unavailable');
    expect(result.diagnostic).toBe('pr_ambiguous');
  });

  it('returns null PR URL when git remote is not GitHub', async () => {
    const { resolvePrUrl } = await import('../../extensions/session-deck/identity/git.js');

    const execGhCli: GhExec = vi.fn().mockRejectedValue(new Error('gh not installed'));
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

  it('returns null PR URL when gh CLI fails and git remote also fails', async () => {
    const { resolvePrUrl } = await import('../../extensions/session-deck/identity/git.js');

    const execGhCli: GhExec = vi.fn().mockRejectedValue(new Error('gh not installed'));
    const execGit = makeExecGit({
      'remote get-url origin': { stdout: '', exitCode: 128 },
    });

    const result = await resolvePrUrl('/home/user/project', 'feature-x', {
      execGhCli,
      execGit,
    });

    expect(result.prUrl).toBeNull();
    expect(result.strategy).toBe('git_remote_failed');
    expect(result.diagnostic).toBe('pr_lookup_failed');
  });
});
