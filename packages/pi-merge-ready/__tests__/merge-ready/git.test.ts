import { describe, expect, it } from 'vitest';
import {
  discoverMergeReadyGitFacts,
  parseGitHubRemoteUrl,
  type MergeReadyExec,
  type MergeReadyExecResult,
  type MergeReadyGitCommandIssue,
  type MergeReadyGitLocalFacts,
} from '../../extensions/merge-ready/index.js';

type ExpectedExecCall = {
  command: string;
  args: string[];
  cwd?: string;
  timeout?: number;
  result?: MergeReadyExecResult;
  error?: unknown;
};

function createFakeExec(expectedCalls: ExpectedExecCall[]): {
  exec: MergeReadyExec;
  assertDone: () => void;
} {
  let index = 0;

  const exec: MergeReadyExec = async (command, args, options) => {
    const expectedCall = expectedCalls[index];
    expect(expectedCall, `Unexpected exec call ${command} ${args.join(' ')}`).toBeDefined();

    index += 1;

    expect({
      command,
      args,
      cwd: options?.cwd,
      timeout: options?.timeout,
    }).toEqual({
      command: expectedCall?.command,
      args: expectedCall?.args,
      cwd: expectedCall?.cwd,
      timeout: expectedCall?.timeout,
    });

    if (expectedCall?.error !== undefined) {
      throw expectedCall.error;
    }

    return expectedCall?.result ?? {};
  };

  return {
    exec,
    assertDone: () => {
      expect(index).toBe(expectedCalls.length);
    },
  };
}

function issueReasons(facts: MergeReadyGitLocalFacts): MergeReadyGitCommandIssue['reason'][] {
  return facts.issues.map((issue) => issue.reason);
}

describe('merge-ready git discovery primitives', () => {
  it('discovers local git facts on the happy path', async () => {
    const { exec, assertDone } = createFakeExec([
      {
        command: 'pwd',
        args: [],
        result: { stdout: '/repo/packages/pi-merge-ready\n' },
      },
      {
        command: 'git',
        args: ['rev-parse', '--show-toplevel'],
        cwd: '/repo/packages/pi-merge-ready',
        result: { stdout: '/repo\n' },
      },
      {
        command: 'git',
        args: ['branch', '--show-current'],
        cwd: '/repo',
        result: { stdout: 'feat/merge-ready\n' },
      },
      {
        command: 'git',
        args: ['remote'],
        cwd: '/repo',
        result: { stdout: 'origin\nupstream\n' },
      },
      {
        command: 'git',
        args: ['remote', 'get-url', 'origin'],
        cwd: '/repo',
        result: { stdout: 'git@github.com:robhowley/pi-userland.git\n' },
      },
      {
        command: 'git',
        args: ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
        cwd: '/repo',
        result: { stdout: 'origin/main\n' },
      },
      {
        command: 'git',
        args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
        cwd: '/repo',
        result: { stdout: 'origin/main\n' },
      },
      {
        command: 'git',
        args: ['rev-list', '--left-right', '--count', 'origin/main...HEAD'],
        cwd: '/repo',
        result: { stdout: '2\t5\n' },
      },
      {
        command: 'git',
        args: ['status', '--porcelain', '--untracked-files=normal'],
        cwd: '/repo',
        result: { stdout: '' },
      },
    ]);

    const facts = await discoverMergeReadyGitFacts({ exec });

    assertDone();

    expect(facts).toEqual({
      cwd: { kind: 'known', path: '/repo/packages/pi-merge-ready' },
      repository: { kind: 'git', root: '/repo' },
      branch: { kind: 'known', name: 'feat/merge-ready' },
      remote: {
        kind: 'github',
        name: 'origin',
        url: 'git@github.com:robhowley/pi-userland.git',
        owner: 'robhowley',
        repo: 'pi-userland',
      },
      baseBranch: { kind: 'known', name: 'main', remoteName: 'origin' },
      upstream: {
        kind: 'known',
        ref: 'origin/main',
        remoteName: 'origin',
        branchName: 'main',
      },
      aheadBehind: { kind: 'known', ahead: 5, behind: 2 },
      dirty: { kind: 'known', dirty: false },
      issues: [],
    });
  });

  it('returns typed not-git-repo facts instead of throwing', async () => {
    const { exec, assertDone } = createFakeExec([
      {
        command: 'git',
        args: ['rev-parse', '--show-toplevel'],
        cwd: '/tmp/not-a-repo',
        result: {
          exitCode: 128,
          stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
        },
      },
    ]);

    const facts = await discoverMergeReadyGitFacts({ exec, cwd: '/tmp/not-a-repo' });

    assertDone();

    expect(facts.cwd).toEqual({ kind: 'known', path: '/tmp/not-a-repo' });
    expect(facts.repository).toEqual({ kind: 'not_git_repo' });
    expect(facts.branch).toEqual({ kind: 'unknown', reason: 'not_git_repo' });
    expect(facts.remote).toEqual({ kind: 'unknown', reason: 'not_git_repo' });
    expect(facts.baseBranch).toEqual({ kind: 'unknown', reason: 'not_git_repo' });
    expect(facts.upstream).toEqual({ kind: 'unknown', reason: 'not_git_repo' });
    expect(facts.aheadBehind).toEqual({ kind: 'unknown', reason: 'not_git_repo' });
    expect(facts.dirty).toEqual({ kind: 'unknown', reason: 'not_git_repo' });
    expect(facts.issues).toHaveLength(1);
    expect(facts.issues[0]).toMatchObject({
      command: 'git',
      args: ['rev-parse', '--show-toplevel'],
      cwd: '/tmp/not-a-repo',
      exitCode: 128,
      reason: 'non_zero_exit',
    });
  });

  it('returns a typed non-github remote while keeping other local facts', async () => {
    const { exec, assertDone } = createFakeExec([
      {
        command: 'git',
        args: ['rev-parse', '--show-toplevel'],
        cwd: '/repo',
        result: { stdout: '/repo\n' },
      },
      {
        command: 'git',
        args: ['branch', '--show-current'],
        cwd: '/repo',
        result: { stdout: 'feature/non-github\n' },
      },
      {
        command: 'git',
        args: ['remote'],
        cwd: '/repo',
        result: { stdout: 'origin\n' },
      },
      {
        command: 'git',
        args: ['remote', 'get-url', 'origin'],
        cwd: '/repo',
        result: { stdout: 'git@gitlab.com:team/repo.git\n' },
      },
      {
        command: 'git',
        args: ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
        cwd: '/repo',
        result: { stdout: 'origin/main\n' },
      },
      {
        command: 'git',
        args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
        cwd: '/repo',
        result: { stdout: 'origin/main\n' },
      },
      {
        command: 'git',
        args: ['rev-list', '--left-right', '--count', 'origin/main...HEAD'],
        cwd: '/repo',
        result: { stdout: '0 0\n' },
      },
      {
        command: 'git',
        args: ['status', '--porcelain', '--untracked-files=normal'],
        cwd: '/repo',
        result: { stdout: '' },
      },
    ]);

    const facts = await discoverMergeReadyGitFacts({ exec, cwd: '/repo' });

    assertDone();

    expect(facts.remote).toEqual({
      kind: 'non_github',
      name: 'origin',
      url: 'git@gitlab.com:team/repo.git',
    });
    expect(facts.baseBranch).toEqual({ kind: 'known', name: 'main', remoteName: 'origin' });
    expect(facts.upstream).toEqual({
      kind: 'known',
      ref: 'origin/main',
      remoteName: 'origin',
      branchName: 'main',
    });
    expect(facts.aheadBehind).toEqual({ kind: 'known', ahead: 0, behind: 0 });
    expect(facts.issues).toEqual([]);
  });

  it('marks the working tree dirty when porcelain output is non-empty', async () => {
    const { exec, assertDone } = createFakeExec([
      {
        command: 'git',
        args: ['rev-parse', '--show-toplevel'],
        cwd: '/repo',
        result: { stdout: '/repo\n' },
      },
      {
        command: 'git',
        args: ['branch', '--show-current'],
        cwd: '/repo',
        result: { stdout: 'feature/dirty\n' },
      },
      {
        command: 'git',
        args: ['remote'],
        cwd: '/repo',
        result: { stdout: 'origin\n' },
      },
      {
        command: 'git',
        args: ['remote', 'get-url', 'origin'],
        cwd: '/repo',
        result: { stdout: 'git@github.com:robhowley/pi-userland.git\n' },
      },
      {
        command: 'git',
        args: ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
        cwd: '/repo',
        result: { stdout: 'origin/main\n' },
      },
      {
        command: 'git',
        args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
        cwd: '/repo',
        result: { stdout: 'origin/main\n' },
      },
      {
        command: 'git',
        args: ['rev-list', '--left-right', '--count', 'origin/main...HEAD'],
        cwd: '/repo',
        result: { stdout: '0 1\n' },
      },
      {
        command: 'git',
        args: ['status', '--porcelain', '--untracked-files=normal'],
        cwd: '/repo',
        result: { stdout: ' M extensions/merge-ready/git.ts\n?? scratch.txt\n' },
      },
    ]);

    const facts = await discoverMergeReadyGitFacts({ exec, cwd: '/repo' });

    assertDone();

    expect(facts.dirty).toEqual({ kind: 'known', dirty: true });
    expect(facts.issues).toEqual([]);
  });

  it('treats missing upstream as typed missing state and leaves ahead/behind unknown', async () => {
    const { exec, assertDone } = createFakeExec([
      {
        command: 'git',
        args: ['rev-parse', '--show-toplevel'],
        cwd: '/repo',
        result: { stdout: '/repo\n' },
      },
      {
        command: 'git',
        args: ['branch', '--show-current'],
        cwd: '/repo',
        result: { stdout: 'feature/no-upstream\n' },
      },
      {
        command: 'git',
        args: ['remote'],
        cwd: '/repo',
        result: { stdout: 'origin\n' },
      },
      {
        command: 'git',
        args: ['remote', 'get-url', 'origin'],
        cwd: '/repo',
        result: { stdout: 'git@github.com:robhowley/pi-userland.git\n' },
      },
      {
        command: 'git',
        args: ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
        cwd: '/repo',
        result: { stdout: 'origin/main\n' },
      },
      {
        command: 'git',
        args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
        cwd: '/repo',
        result: {
          exitCode: 128,
          stderr: "fatal: no upstream configured for branch 'feature/no-upstream'\n",
        },
      },
      {
        command: 'git',
        args: ['status', '--porcelain', '--untracked-files=normal'],
        cwd: '/repo',
        result: { stdout: '' },
      },
    ]);

    const facts = await discoverMergeReadyGitFacts({ exec, cwd: '/repo' });

    assertDone();

    expect(facts.upstream).toEqual({ kind: 'missing' });
    expect(facts.aheadBehind).toEqual({ kind: 'unknown', reason: 'missing_upstream' });
    expect(issueReasons(facts)).toEqual(['non_zero_exit']);
    expect(facts.issues[0]?.stderr).toContain('no upstream configured');
  });

  it('degrades typed facts when git commands fail unexpectedly', async () => {
    const { exec, assertDone } = createFakeExec([
      {
        command: 'git',
        args: ['rev-parse', '--show-toplevel'],
        cwd: '/repo',
        result: { stdout: '/repo\n' },
      },
      {
        command: 'git',
        args: ['branch', '--show-current'],
        cwd: '/repo',
        error: new Error('spawn git EACCES'),
      },
      {
        command: 'git',
        args: ['remote'],
        cwd: '/repo',
        result: { stdout: 'origin\n' },
      },
      {
        command: 'git',
        args: ['remote', 'get-url', 'origin'],
        cwd: '/repo',
        result: { stdout: 'https://github.com/robhowley/pi-userland.git\n' },
      },
      {
        command: 'git',
        args: ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
        cwd: '/repo',
        result: {
          exitCode: 128,
          stderr: 'fatal: ref refs/remotes/origin/HEAD is not a symbolic ref\n',
        },
      },
      {
        command: 'git',
        args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
        cwd: '/repo',
        result: { stdout: 'origin/main\n' },
      },
      {
        command: 'git',
        args: ['rev-list', '--left-right', '--count', 'origin/main...HEAD'],
        cwd: '/repo',
        result: { stdout: 'oops\n' },
      },
      {
        command: 'git',
        args: ['status', '--porcelain', '--untracked-files=normal'],
        cwd: '/repo',
        result: { stdout: '' },
      },
    ]);

    const facts = await discoverMergeReadyGitFacts({ exec, cwd: '/repo' });

    assertDone();

    expect(facts.branch).toEqual({ kind: 'unknown', reason: 'command_failed' });
    expect(facts.remote).toEqual({
      kind: 'github',
      name: 'origin',
      url: 'https://github.com/robhowley/pi-userland.git',
      owner: 'robhowley',
      repo: 'pi-userland',
    });
    expect(facts.baseBranch).toEqual({ kind: 'unknown', reason: 'missing_remote_head' });
    expect(facts.upstream).toEqual({
      kind: 'known',
      ref: 'origin/main',
      remoteName: 'origin',
      branchName: 'main',
    });
    expect(facts.aheadBehind).toEqual({ kind: 'unknown', reason: 'command_failed' });
    expect(facts.dirty).toEqual({ kind: 'known', dirty: false });
    expect(issueReasons(facts)).toEqual(['threw', 'non_zero_exit', 'invalid_output']);
    expect(facts.issues[0]?.message).toContain('threw');
    expect(facts.issues[1]?.stderr).toContain('not a symbolic ref');
    expect(facts.issues[2]?.stdout).toBe('oops\n');
  });

  it('parses GitHub SSH and HTTPS remotes', () => {
    expect(parseGitHubRemoteUrl('git@github.com:robhowley/pi-userland.git')).toEqual({
      owner: 'robhowley',
      repo: 'pi-userland',
    });
    expect(parseGitHubRemoteUrl('https://github.com/robhowley/pi-userland.git')).toEqual({
      owner: 'robhowley',
      repo: 'pi-userland',
    });
    expect(parseGitHubRemoteUrl('git@gitlab.com:robhowley/pi-userland.git')).toBeNull();
  });
});
