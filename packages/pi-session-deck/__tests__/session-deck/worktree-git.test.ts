import { describe, expect, it } from 'vitest';
import { parseGitWorktreeList } from '../../extensions/session-deck/worktree/git.js';
import { slugifyWorktreeLabel } from '../../extensions/session-deck/worktree/create.js';

describe('session-deck worktree git helpers', () => {
  it('slugifies labels into bounded worktree branch segments', () => {
    expect(slugifyWorktreeLabel('  Feature: Ship Worktree + Pi!  ')).toBe(
      'feature-ship-worktree-pi',
    );
    expect(slugifyWorktreeLabel('   ')).toBeNull();
    expect(slugifyWorktreeLabel('x'.repeat(80))).toHaveLength(48);
  });

  it('parses git worktree porcelain output without shell commands', () => {
    const source = [
      'worktree /repo',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      'worktree /repo-wt-task',
      'HEAD def',
      'branch refs/heads/worktree/task',
      '',
      '',
    ].join('\0');

    expect(parseGitWorktreeList(source)).toEqual([
      { path: '/repo', head: 'abc', branch: 'main' },
      { path: '/repo-wt-task', head: 'def', branch: 'worktree/task' },
    ]);
  });
});
