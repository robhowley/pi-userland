import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProcessRunner } from '../extensions/cmux-junction/process.js';
import {
  applyWorktreePlan,
  parseWorktreeList,
  planWorktree,
  resolveWorktreeRoot,
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

function expectedWorktreePath(homeDir: string, branch: string, repoLabel: string): string {
  const branchSlug = slugPathLabel(branch, 48);
  if (branchSlug === null) throw new Error('Expected a valid branch slug.');
  return join(homeDir, '.pi', 'cmux-junction-worktrees', `${repoLabel}-${branchSlug}`);
}

function mockGit(options: {
  topLevel: string;
  commonGitDir: string;
  remoteHead?: string | null;
  validRefs?: Record<string, string>;
  branchValid?: boolean;
  worktrees?: GitWorktreeEntry[];
  originRemote?: string | null;
  remoteList?: string | null;
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
    if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
      return options.originRemote === undefined || options.originRemote === null
        ? { stdout: '', stderr: 'origin not configured', exitCode: 1 }
        : { stdout: `${options.originRemote}\n`, stderr: '', exitCode: 0 };
    }
    if (args[0] === 'remote' && args[1] === '-v') {
      return options.remoteList === undefined || options.remoteList === null
        ? { stdout: '', stderr: 'no remotes', exitCode: 1 }
        : { stdout: `${options.remoteList}\n`, stderr: '', exitCode: 0 };
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

describe('worktree root', () => {
  const homeDir = '/tmp/pi-cmux-junction-home';

  it.each([
    [undefined, join(homeDir, '.pi', 'cmux-junction-worktrees')],
    ['', join(homeDir, '.pi', 'cmux-junction-worktrees')],
    ['   ', join(homeDir, '.pi', 'cmux-junction-worktrees')],
    ['/tmp/worktrees/../central', '/tmp/central'],
    ['  /tmp/worktrees/../central  ', '/tmp/central'],
    ['~', homeDir],
    ['~/worktrees/../central', join(homeDir, 'central')],
  ])('resolves %j without global environment changes', (value, expected) => {
    const env = value === undefined ? {} : { PI_CMUX_JUNCTION_WORKTREE_ROOT: value };
    expect(resolveWorktreeRoot({ env, homeDir })).toEqual({ ok: true, path: expected });
  });

  it.each(['relative/path', './relative', '~other/path', '~other'])('rejects %j', (value) => {
    expect(
      resolveWorktreeRoot({
        env: { PI_CMUX_JUNCTION_WORKTREE_ROOT: value },
        homeDir,
      }),
    ).toMatchObject({ ok: false, reason: 'invalid-worktree-root' });
  });
});

describe('worktree planning and apply', () => {
  it('uses ctx.cwd and builds a flat repo-and-branch path', async () => {
    const root = await tempDir();
    const topLevel = join(root, 'Current Checkout');
    const commonGitDir = join(root, 'Primary Repo.git');
    await mkdir(topLevel);
    const mock = mockGit({
      topLevel,
      commonGitDir,
      remoteHead: 'origin/main',
      validRefs: { 'origin/main': 'abc123' },
      originRemote: 'https://github.com/robhowley/pi-userland.git',
    });

    const plan = await planWorktree(join(topLevel, 'nested'), 'Feature/Keep-Case', {
      runner: mock.runner,
      env: {},
      homeDir: root,
    });

    expect(plan).toMatchObject({
      ok: true,
      branch: 'Feature/Keep-Case',
      path: expectedWorktreePath(root, 'Feature/Keep-Case', 'robhowley-pi-userland'),
      repository: { topLevel, commonGitDir, repoLabel: 'robhowley-pi-userland' },
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

  it('qualifies same-label repositories by remote owner and rejects branch-slug collisions', async () => {
    const root = await tempDir();
    const topLevelA = join(root, 'one', 'project');
    const topLevelB = join(root, 'two', 'project');
    const commonGitDirA = join(topLevelA, '.git');
    const commonGitDirB = join(topLevelB, '.git');
    await mkdir(topLevelA, { recursive: true });
    await mkdir(topLevelB, { recursive: true });

    const mockA = mockGit({
      topLevel: topLevelA,
      commonGitDir: commonGitDirA,
      validRefs: { main: 'sha' },
      originRemote: 'https://github.com/owner-a/project.git',
    });
    const mockB = mockGit({
      topLevel: topLevelB,
      commonGitDir: commonGitDirB,
      validRefs: { main: 'sha' },
      originRemote: 'git@github.com:owner-b/project.git',
    });
    const options = { env: {}, homeDir: root };
    const planA = await planWorktree(topLevelA, 'feature/ship-it', {
      ...options,
      runner: mockA.runner,
    });
    const planB = await planWorktree(topLevelB, 'feature/ship-it', {
      ...options,
      runner: mockB.runner,
    });
    if (!planA.ok || !planB.ok) {
      throw new Error('Expected both repository plans to succeed.');
    }

    expect(planA.path).toBe(expectedWorktreePath(root, 'feature/ship-it', 'owner-a-project'));
    expect(planB.path).toBe(expectedWorktreePath(root, 'feature/ship-it', 'owner-b-project'));
    expect(planA.path).not.toBe(planB.path);

    mockA.setWorktrees([{ path: planA.path, head: 'sha', branch: 'feature/ship-it' }]);
    await expect(
      planWorktree(topLevelA, 'feature-ship-it', {
        ...options,
        runner: mockA.runner,
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'path-collision' });
  });

  it('uses the exact qualified path for f/t from an SSH URL', async () => {
    const root = await tempDir();
    const topLevel = join(root, 'checkout');
    await mkdir(topLevel);
    const mock = mockGit({
      topLevel,
      commonGitDir: join(topLevel, '.git'),
      originRemote: 'ssh://git@github.com/robhowley/pi-userland.git',
      validRefs: { main: 'sha' },
    });

    const plan = await planWorktree(topLevel, 'f/t', {
      runner: mock.runner,
      env: {},
      homeDir: root,
    });

    expect(plan).toMatchObject({
      ok: true,
      path: join(root, '.pi', 'cmux-junction-worktrees', 'robhowley-pi-userland-f-t'),
      repository: { repoLabel: 'robhowley-pi-userland' },
    });
  });

  it('falls back when the first non-origin fetch remote is unparseable', async () => {
    const root = await tempDir();
    const topLevel = join(root, 'checkout');
    const commonGitDir = join(root, 'local-label.git');
    await mkdir(topLevel);
    const mock = mockGit({
      topLevel,
      commonGitDir,
      originRemote: 'file:///srv/git/local.git',
      remoteList:
        'origin\tfile:///srv/git/local.git (fetch)\n' +
        'mirror\tfile:///srv/git/mirror.git (fetch)\n' +
        'upstream\tgit@github.com:Owner/Repo.git (fetch)\n',
      validRefs: { main: 'sha' },
    });

    const plan = await planWorktree(topLevel, 'f/t', {
      runner: mock.runner,
      env: {},
      homeDir: root,
    });

    expect(plan).toMatchObject({
      ok: true,
      path: join(root, '.pi', 'cmux-junction-worktrees', 'local-label-f-t'),
      repository: { repoLabel: 'local-label' },
    });
  });

  it('trims a truncated qualified repo label before adding the branch separator', async () => {
    const root = await tempDir();
    const topLevel = join(root, 'checkout');
    const owner = 'o'.repeat(63);
    await mkdir(topLevel);
    const mock = mockGit({
      topLevel,
      commonGitDir: join(topLevel, '.git'),
      originRemote: `https://github.com/${owner}/repo.git`,
      validRefs: { main: 'sha' },
    });

    const plan = await planWorktree(topLevel, 'f/t', {
      runner: mock.runner,
      env: {},
      homeDir: root,
    });

    if (!plan.ok) throw new Error(plan.message);
    const pathLabel = basename(plan.path);
    expect(pathLabel).toBe(`${owner}-f-t`);
    expect(pathLabel.slice(owner.length, owner.length + 1)).toBe('-');
    expect(pathLabel).not.toContain('--');
  });

  it.each([
    [
      'unparseable remotes',
      'file:///srv/git/local-label.git',
      'mirror\tfile:///srv/git/mirror.git (fetch)',
    ],
    ['missing remotes', null, null],
  ] as const)(
    'falls back to the common-Git-dir label for %s',
    async (_case, originRemote, remoteList) => {
      const root = await tempDir();
      const topLevel = join(root, 'checkout');
      const commonGitDir = join(root, 'local-label.git');
      await mkdir(topLevel);
      const mock = mockGit({
        topLevel,
        commonGitDir,
        originRemote,
        remoteList,
        validRefs: { main: 'sha' },
      });

      const plan = await planWorktree(topLevel, 'f/t', {
        runner: mock.runner,
        env: {},
        homeDir: root,
      });

      expect(plan).toMatchObject({
        ok: true,
        path: join(root, '.pi', 'cmux-junction-worktrees', 'local-label-f-t'),
        repository: { repoLabel: 'local-label' },
      });
    },
  );

  it('fails closed when qualified or local labels collide at an existing target', async () => {
    const root = await tempDir();
    const topLevelA = join(root, 'one', 'project');
    const topLevelB = join(root, 'two', 'project');
    await mkdir(topLevelA, { recursive: true });
    await mkdir(topLevelB, { recursive: true });
    const options = { env: {}, homeDir: root };

    const qualifiedA = mockGit({
      topLevel: topLevelA,
      commonGitDir: join(topLevelA, '.git'),
      originRemote: 'https://github.com/owner/project.git',
      validRefs: { main: 'sha' },
    });
    const qualifiedB = mockGit({
      topLevel: topLevelB,
      commonGitDir: join(topLevelB, '.git'),
      originRemote: 'git@github.com:owner/project.git',
      validRefs: { main: 'sha' },
    });
    const qualifiedPlan = await planWorktree(topLevelA, 'f/t', {
      ...options,
      runner: qualifiedA.runner,
    });
    if (!qualifiedPlan.ok) throw new Error(qualifiedPlan.message);
    await mkdir(qualifiedPlan.path, { recursive: true });
    await expect(
      planWorktree(topLevelB, 'f/t', { ...options, runner: qualifiedB.runner }),
    ).resolves.toMatchObject({ ok: false, reason: 'path-collision' });

    const localA = mockGit({
      topLevel: topLevelA,
      commonGitDir: join(topLevelA, '.git'),
      validRefs: { main: 'sha' },
    });
    const localB = mockGit({
      topLevel: topLevelB,
      commonGitDir: join(topLevelB, '.git'),
      validRefs: { main: 'sha' },
    });
    const localPlan = await planWorktree(topLevelA, 'other/branch', {
      ...options,
      runner: localA.runner,
    });
    if (!localPlan.ok) throw new Error(localPlan.message);
    await mkdir(localPlan.path, { recursive: true });
    await expect(
      planWorktree(topLevelB, 'other/branch', { ...options, runner: localB.runner }),
    ).resolves.toMatchObject({ ok: false, reason: 'path-collision' });
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
      planWorktree(topLevel, 'bad branch', { runner: mock.runner, env: {}, homeDir: root }),
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

    const plan = await planWorktree(topLevel, 'feature/exact', {
      runner: mock.runner,
      env: {},
      homeDir: root,
    });
    expect(plan).toMatchObject({ ok: true, baseRef: 'origin/main', baseSha: 'main-sha' });
    if (!plan.ok) throw new Error(plan.message);

    await expect(
      applyWorktreePlan(plan, { runner: mock.runner, env: {}, homeDir: root, lockRoot }),
    ).resolves.toMatchObject({ ok: true, status: 'created' });
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
    const expectedPath = expectedWorktreePath(root, 'feature/test', 'project');
    const mock = mockGit({
      topLevel,
      commonGitDir: join(topLevel, '.git'),
      validRefs: { main: 'abc123' },
      worktrees: [{ path: expectedPath, head: 'abc123', branch: 'feature/test' }],
    });

    const plan = await planWorktree(topLevel, 'feature/test', {
      runner: mock.runner,
      env: {},
      homeDir: root,
    });
    expect(plan).toMatchObject({ ok: true, action: 'reuse', path: expectedPath });
    if (!plan.ok) throw new Error(plan.message);
    await expect(
      applyWorktreePlan(plan, {
        runner: mock.runner,
        env: {},
        homeDir: root,
        lockRoot: join(root, 'locks'),
      }),
    ).resolves.toMatchObject({ ok: true, status: 'reused' });
    expect(mock.calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add')).toBe(
      false,
    );
  });

  it.each([
    ['path-collision', 'other/branch', 'target'],
    ['branch-collision', 'feature/test', 'somewhere-else'],
  ] as const)('rejects %s without mutation', async (reason, existingBranch, directory) => {
    const root = await tempDir();
    const topLevel = join(root, 'project');
    await mkdir(topLevel);
    const commonGitDir = join(topLevel, '.git');
    const existingPath =
      directory === 'target'
        ? expectedWorktreePath(root, 'feature/test', 'project')
        : join(root, directory);
    const mock = mockGit({
      topLevel,
      commonGitDir,
      validRefs: { main: 'abc123' },
      worktrees: [{ path: existingPath, head: 'abc123', branch: existingBranch }],
    });

    await expect(
      planWorktree(topLevel, 'feature/test', { runner: mock.runner, env: {}, homeDir: root }),
    ).resolves.toMatchObject({
      ok: false,
      reason,
    });
    expect(mock.calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add')).toBe(
      false,
    );
  });

  it('keeps a same-branch worktree at an old hashed path as a branch collision', async () => {
    const root = await tempDir();
    const topLevel = join(root, 'project');
    const commonGitDir = join(topLevel, '.git');
    await mkdir(topLevel);
    const mock = mockGit({
      topLevel,
      commonGitDir,
      validRefs: { main: 'abc123' },
      worktrees: [
        {
          path: join(root, 'old-root', 'project--0123456789ab-feature-test'),
          head: 'abc123',
          branch: 'feature/test',
        },
      ],
    });

    await expect(
      planWorktree(topLevel, 'feature/test', {
        runner: mock.runner,
        env: { PI_CMUX_JUNCTION_WORKTREE_ROOT: join(root, 'new-root') },
        homeDir: root,
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'branch-collision' });
    expect(mock.calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add')).toBe(
      false,
    );
  });

  it('creates the missing flat-path root before Git add', async () => {
    const root = await tempDir();
    const worktreeRoot = join(root, 'central');
    const topLevel = join(root, 'project');
    const commonGitDir = join(topLevel, '.git');
    const lockRoot = join(root, 'locks');
    await mkdir(topLevel);
    const mock = mockGit({ topLevel, commonGitDir, validRefs: { main: 'abc123' } });
    const rootOptions = {
      env: { PI_CMUX_JUNCTION_WORKTREE_ROOT: worktreeRoot },
      homeDir: root,
    };
    const plan = await planWorktree(topLevel, 'feature/test', {
      ...rootOptions,
      runner: mock.runner,
    });
    if (!plan.ok) throw new Error(plan.message);
    expect(existsSync(worktreeRoot)).toBe(false);

    let parentExistedAtAdd = false;
    const runner: ProcessRunner = async (file, args, options) => {
      if (file === 'git' && args[0] === 'worktree' && args[1] === 'add') {
        parentExistedAtAdd = existsSync(dirname(plan.path));
      }
      return await mock.runner(file, args, options);
    };
    await expect(
      applyWorktreePlan(plan, { ...rootOptions, runner, lockRoot }),
    ).resolves.toMatchObject({ ok: true, status: 'created' });
    expect(parentExistedAtAdd).toBe(true);
    expect(existsSync(dirname(plan.path))).toBe(true);
  });

  it('returns a root-creation failure without running Git add', async () => {
    const root = await tempDir();
    const worktreeRoot = join(root, 'blocked-root');
    const topLevel = join(root, 'project');
    const commonGitDir = join(topLevel, '.git');
    const lockRoot = join(root, 'locks');
    await mkdir(topLevel);
    await writeFile(worktreeRoot, 'not a directory');
    const mock = mockGit({ topLevel, commonGitDir, validRefs: { main: 'abc123' } });
    const rootOptions = {
      env: { PI_CMUX_JUNCTION_WORKTREE_ROOT: worktreeRoot },
      homeDir: root,
    };
    const plan = await planWorktree(topLevel, 'feature/test', {
      ...rootOptions,
      runner: mock.runner,
    });
    if (!plan.ok) throw new Error(plan.message);

    await expect(
      applyWorktreePlan(plan, { ...rootOptions, runner: mock.runner, lockRoot }),
    ).resolves.toMatchObject({ ok: false, reason: 'worktree-root-failed' });
    expect(mock.calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add')).toBe(
      false,
    );
  });

  it('rejects an unmanaged target directory', async () => {
    const root = await tempDir();
    const topLevel = join(root, 'project');
    await mkdir(topLevel);
    await mkdir(expectedWorktreePath(root, 'feature/test', 'project'), {
      recursive: true,
    });
    const mock = mockGit({
      topLevel,
      commonGitDir: join(topLevel, '.git'),
      validRefs: { main: 'abc123' },
    });

    await expect(
      planWorktree(topLevel, 'feature/test', { runner: mock.runner, env: {}, homeDir: root }),
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
    const plan = await planWorktree(topLevel, 'feature/test', {
      runner: mock.runner,
      env: {},
      homeDir: root,
    });
    if (!plan.ok) throw new Error(plan.message);

    mock.setWorktrees([{ path: plan.path, head: 'abc123', branch: plan.branch }]);
    await expect(
      applyWorktreePlan(plan, {
        runner: mock.runner,
        env: {},
        homeDir: root,
        lockRoot: join(root, 'locks'),
      }),
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
    const plan = await planWorktree(topLevel, 'feature/test', {
      runner: mock.runner,
      env: {},
      homeDir: root,
    });
    if (!plan.ok) throw new Error(plan.message);

    const hash = createHash('sha256').update(commonGitDir).digest('hex').slice(0, 32);
    await mkdir(join(lockRoot, `${hash}.lock`), { recursive: true });
    await expect(
      applyWorktreePlan(plan, { runner: mock.runner, env: {}, homeDir: root, lockRoot }),
    ).resolves.toMatchObject({ ok: false, reason: 'lock-busy' });
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
