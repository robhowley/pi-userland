import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProcessRunner } from '../extensions/cmux-junction/process.js';
import {
  applyWorktreePlan,
  parseWorktreeList,
  planWorktree,
  slugPathLabel,
  type GitWorktreeEntry,
} from '../extensions/cmux-junction/worktree.js';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-cmux-junction-'));
  tempDirectories.push(directory);
  return directory;
}

function mockGit(options: {
  topLevel: string;
  commonGitDir: string;
  remoteHead?: string | null;
  validRefs?: Record<string, string>;
  branchValid?: boolean;
  worktrees?: GitWorktreeEntry[];
}) {
  const calls: Array<{ file: string; args: readonly string[]; cwd: string }> = [];
  let worktrees = options.worktrees ?? [];
  const runner: ProcessRunner = async (file, args, processOptions) => {
    calls.push({ file, args, cwd: processOptions.cwd });
    if (file !== 'git') {
      return { stdout: '', stderr: 'unexpected command', exitCode: 1 };
    }
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return { stdout: `${options.topLevel}\n`, stderr: '', exitCode: 0 };
    }
    if (args[0] === 'rev-parse' && args[1] === '--path-format=absolute') {
      return { stdout: `${options.commonGitDir}\n`, stderr: '', exitCode: 0 };
    }
    if (args[0] === 'check-ref-format') {
      return { stdout: '', stderr: '', exitCode: options.branchValid === false ? 1 : 0 };
    }
    if (args[0] === 'symbolic-ref') {
      return options.remoteHead
        ? { stdout: `${options.remoteHead}\n`, stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 1 };
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      const ref = String(args[2]).replace(/\^\{commit\}$/u, '');
      const sha = options.validRefs?.[ref];
      return sha === undefined
        ? { stdout: '', stderr: 'unknown ref', exitCode: 1 }
        : { stdout: `${sha}\n`, stderr: '', exitCode: 0 };
    }
    if (args[0] === 'worktree' && args[1] === 'list') {
      return { stdout: porcelain(worktrees), stderr: '', exitCode: 0 };
    }
    if (args[0] === 'worktree' && args[1] === 'add') {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: `unexpected git args: ${args.join(' ')}`, exitCode: 1 };
  };
  return {
    calls,
    runner,
    setWorktrees(value: GitWorktreeEntry[]) {
      worktrees = value;
    },
  };
}

describe('worktree planning and apply', () => {
  it('uses ctx.cwd for repo resolution, common Git dir for repo slug, and branch only for path slug', async () => {
    const root = await tempDir();
    const topLevel = join(root, 'Current Checkout');
    const commonGitDir = join(root, 'Primary Repo.git');
    await mkdir(topLevel);
    const mock = mockGit({
      topLevel,
      commonGitDir,
      remoteHead: 'origin/main',
      validRefs: { 'origin/main': 'abc123' },
    });

    const plan = await planWorktree(join(topLevel, 'nested'), 'Feature/Keep-Case', {
      runner: mock.runner,
    });

    expect(plan).toMatchObject({
      ok: true,
      branch: 'Feature/Keep-Case',
      path: join(dirname(topLevel), 'primary-repo-wt-feature-keep-case'),
      repository: { topLevel, commonGitDir, repoLabel: 'primary-repo' },
    });
    expect(mock.calls.slice(0, 2)).toEqual([
      {
        file: 'git',
        args: ['rev-parse', '--show-toplevel'],
        cwd: join(topLevel, 'nested'),
      },
      {
        file: 'git',
        args: ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        cwd: join(topLevel, 'nested'),
      },
    ]);
    expect(mock.calls).toContainEqual({
      file: 'git',
      args: ['check-ref-format', '--branch', 'Feature/Keep-Case'],
      cwd: topLevel,
    });
  });

  it('rejects a branch that Git does not accept before worktree inspection', async () => {
    const root = await tempDir();
    const topLevel = join(root, 'project');
    await mkdir(topLevel);
    const mock = mockGit({
      topLevel,
      commonGitDir: join(topLevel, '.git'),
      branchValid: false,
    });

    await expect(
      planWorktree(topLevel, 'bad branch', { runner: mock.runner }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-branch',
    });
    expect(mock.calls.some((call) => call.args[0] === 'worktree')).toBe(false);
  });

  it('matches bounded Session Deck path cleaning', () => {
    expect(slugPathLabel('  Feature: Ship Worktree + Pi!  ', 48)).toBe('feature-ship-worktree-pi');
    expect(slugPathLabel('x'.repeat(80), 48)).toHaveLength(48);
    expect(slugPathLabel(' +++ ', 48)).toBeNull();
  });

  it('selects bases in order and pins the selected SHA into worktree add', async () => {
    const root = await tempDir();
    const topLevel = join(root, 'project');
    const lockRoot = join(root, 'locks');
    await mkdir(topLevel);
    const mock = mockGit({
      topLevel,
      commonGitDir: join(topLevel, '.git'),
      remoteHead: 'origin/trunk',
      validRefs: {
        'origin/main': 'main-sha',
        main: 'local-main-sha',
        HEAD: 'head-sha',
      },
    });

    const plan = await planWorktree(topLevel, 'feature/exact', { runner: mock.runner });
    expect(plan).toMatchObject({ ok: true, baseRef: 'origin/main', baseSha: 'main-sha' });
    if (!plan.ok) throw new Error(plan.message);

    await expect(applyWorktreePlan(plan, { runner: mock.runner, lockRoot })).resolves.toMatchObject(
      { ok: true, status: 'created' },
    );
    expect(mock.calls).toContainEqual({
      file: 'git',
      args: ['worktree', 'add', '-b', 'feature/exact', plan.path, 'main-sha'],
      cwd: topLevel,
    });
    const verifyRefs = mock.calls
      .filter((call) => call.args[0] === 'rev-parse' && call.args[1] === '--verify')
      .map((call) => call.args[2]);
    expect(verifyRefs).toEqual([
      'origin/trunk^{commit}',
      'origin/main^{commit}',
      'origin/main^{commit}',
    ]);
  });

  it('reuses only the exact branch and path pair', async () => {
    const root = await tempDir();
    const topLevel = join(root, 'project');
    await mkdir(topLevel);
    const expectedPath = join(root, 'project-wt-feature-test');
    const mock = mockGit({
      topLevel,
      commonGitDir: join(topLevel, '.git'),
      validRefs: { main: 'abc123' },
      worktrees: [{ path: expectedPath, head: 'abc123', branch: 'feature/test' }],
    });

    const plan = await planWorktree(topLevel, 'feature/test', { runner: mock.runner });
    expect(plan).toMatchObject({ ok: true, action: 'reuse', path: expectedPath });
    if (!plan.ok) throw new Error(plan.message);
    await expect(
      applyWorktreePlan(plan, { runner: mock.runner, lockRoot: join(root, 'locks') }),
    ).resolves.toMatchObject({
      ok: true,
      status: 'reused',
    });
    expect(mock.calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add')).toBe(
      false,
    );
  });

  it.each([
    ['path-collision', 'other/branch', 'project-wt-feature-test'],
    ['branch-collision', 'feature/test', 'somewhere-else'],
  ] as const)('rejects %s without mutation', async (reason, existingBranch, directory) => {
    const root = await tempDir();
    const topLevel = join(root, 'project');
    await mkdir(topLevel);
    const mock = mockGit({
      topLevel,
      commonGitDir: join(topLevel, '.git'),
      validRefs: { main: 'abc123' },
      worktrees: [{ path: join(root, directory), head: 'abc123', branch: existingBranch }],
    });

    await expect(
      planWorktree(topLevel, 'feature/test', { runner: mock.runner }),
    ).resolves.toMatchObject({
      ok: false,
      reason,
    });
    expect(mock.calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add')).toBe(
      false,
    );
  });

  it('rejects an unmanaged target directory', async () => {
    const root = await tempDir();
    const topLevel = join(root, 'project');
    await mkdir(topLevel);
    await mkdir(join(root, 'project-wt-feature-test'));
    const mock = mockGit({
      topLevel,
      commonGitDir: join(topLevel, '.git'),
      validRefs: { main: 'abc123' },
    });

    await expect(
      planWorktree(topLevel, 'feature/test', { runner: mock.runner }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'path-collision',
    });
  });

  it('rechecks under the common-Git-dir lock and converts an exact race to reuse', async () => {
    const root = await tempDir();
    const topLevel = join(root, 'project');
    await mkdir(topLevel);
    const mock = mockGit({
      topLevel,
      commonGitDir: join(topLevel, '.git'),
      validRefs: { main: 'abc123' },
    });
    const plan = await planWorktree(topLevel, 'feature/test', { runner: mock.runner });
    if (!plan.ok) throw new Error(plan.message);

    mock.setWorktrees([{ path: plan.path, head: 'abc123', branch: plan.branch }]);
    await expect(
      applyWorktreePlan(plan, { runner: mock.runner, lockRoot: join(root, 'locks') }),
    ).resolves.toMatchObject({ ok: true, status: 'reused' });
    expect(mock.calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add')).toBe(
      false,
    );
  });

  it('uses the absolute common Git dir as the lock key', async () => {
    const root = await tempDir();
    const topLevel = join(root, 'project');
    const commonGitDir = join(topLevel, '.git');
    const lockRoot = join(root, 'locks');
    await mkdir(topLevel);
    const mock = mockGit({ topLevel, commonGitDir, validRefs: { main: 'abc123' } });
    const plan = await planWorktree(topLevel, 'feature/test', { runner: mock.runner });
    if (!plan.ok) throw new Error(plan.message);

    const hash = createHash('sha256').update(commonGitDir).digest('hex').slice(0, 32);
    await mkdir(join(lockRoot, `${hash}.lock`), { recursive: true });
    await expect(applyWorktreePlan(plan, { runner: mock.runner, lockRoot })).resolves.toMatchObject(
      { ok: false, reason: 'lock-busy' },
    );
  });

  it('parses NUL-delimited worktree porcelain', () => {
    expect(
      parseWorktreeList(
        ['worktree /repo', 'HEAD abc', 'branch refs/heads/main', '', ''].join('\0'),
      ),
    ).toEqual([{ path: '/repo', head: 'abc', branch: 'main' }]);
  });
});

function porcelain(entries: readonly GitWorktreeEntry[]): string {
  return entries
    .flatMap((entry) => [
      `worktree ${entry.path}`,
      ...(entry.head === null ? [] : [`HEAD ${entry.head}`]),
      ...(entry.branch === null ? [] : [`branch refs/heads/${entry.branch}`]),
      '',
    ])
    .concat('')
    .join('\0');
}
