import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyGitWorktreePlan,
  createGitWorktree,
  planGitWorktree,
} from '../../extensions/session-deck/worktree/create.js';
import {
  defaultWorktreePath,
  type GitWorktreeEntry,
  type WorktreeExecFile,
} from '../../extensions/session-deck/worktree/git.js';
import { acquireWorktreeLock } from '../../extensions/session-deck/worktree/locks.js';
import type {
  CreateWorktreeActionRequest,
  CreateWorktreeResolvedRepo,
} from '../../extensions/session-deck/worktree/types.js';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'session-deck-worktree-create-'));
  tempDirectories.push(directory);
  return directory;
}

function buildRequest(
  overrides: Partial<CreateWorktreeActionRequest> = {},
): CreateWorktreeActionRequest {
  return {
    repoIntent: {
      repoName: 'project',
      qualifiedRepoName: 'owner/project',
      candidateRuntimeIds: ['rt-1'],
    },
    branchName: 'feature/test',
    baseRef: 'origin/main',
    ...overrides,
  };
}

async function buildRepo(): Promise<{
  repo: CreateWorktreeResolvedRepo;
  expectedPath: string;
  root: string;
}> {
  const root = await tempDir();
  const primaryWorktreePath = join(root, 'project');
  await mkdir(primaryWorktreePath, { recursive: true });

  return {
    root,
    repo: {
      repoName: 'project',
      qualifiedRepoName: 'owner/project',
      primaryWorktreePath,
      commonGitDir: join(primaryWorktreePath, '.git'),
      candidateRuntimeIds: ['rt-1'],
    },
    expectedPath: defaultWorktreePath(primaryWorktreePath, 'project', 'feature-test'),
  };
}

function buildMockGit(
  options: {
    branchValid?: boolean;
    baseSha?: string | null;
    worktrees?: GitWorktreeEntry[];
    listFails?: boolean;
    addExitCode?: number;
    addStderr?: string;
  } = {},
): {
  calls: Array<{ file: string; args: readonly string[] }>;
  execFile: WorktreeExecFile;
  setBaseSha: (value: string | null) => void;
  setWorktrees: (value: GitWorktreeEntry[]) => void;
} {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  let baseSha = options.baseSha === undefined ? 'abc123' : options.baseSha;
  let worktrees = options.worktrees ?? [];

  const execFile: WorktreeExecFile = async (file, args) => {
    calls.push({ file, args });
    if (file !== 'git') {
      return { stdout: '', stderr: `unexpected ${file}`, exitCode: 1 };
    }
    if (args[0] === 'check-ref-format') {
      return {
        stdout: '',
        stderr: '',
        exitCode: options.branchValid === false ? 1 : 0,
      };
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      return baseSha === null
        ? { stdout: '', stderr: 'bad ref', exitCode: 1 }
        : { stdout: `${baseSha}\n`, stderr: '', exitCode: 0 };
    }
    if (args[0] === 'worktree' && args[1] === 'list') {
      return options.listFails
        ? { stdout: '', stderr: 'list failed', exitCode: 1 }
        : { stdout: toPorcelain(worktrees), stderr: '', exitCode: 0 };
    }
    if (args[0] === 'worktree' && args[1] === 'add') {
      return {
        stdout: '',
        stderr: options.addStderr ?? '',
        exitCode: options.addExitCode ?? 0,
      };
    }
    return { stdout: '', stderr: `unexpected git ${args.join(' ')}`, exitCode: 1 };
  };

  return {
    calls,
    execFile,
    setBaseSha: (value) => {
      baseSha = value;
    },
    setWorktrees: (value) => {
      worktrees = value;
    },
  };
}

describe('session-deck worktree create planning and apply', () => {
  it('returns invalid-branch before any worktree mutation', async () => {
    const { repo } = await buildRepo();
    const mock = buildMockGit({ branchValid: false });

    await expect(
      planGitWorktree(buildRequest(), repo, { execFile: mock.execFile }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-branch',
    });
    expect(mock.calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add')).toBe(
      false,
    );
  });

  it('returns invalid-base-ref before listing worktrees or mutating git', async () => {
    const { repo } = await buildRepo();
    const mock = buildMockGit({ baseSha: null });

    await expect(
      planGitWorktree(buildRequest(), repo, { execFile: mock.execFile }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-base-ref',
    });
    expect(mock.calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'list')).toBe(
      false,
    );
    expect(mock.calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add')).toBe(
      false,
    );
  });

  it('reuses an exact existing branch and path without adding a worktree', async () => {
    const { repo, expectedPath } = await buildRepo();
    const mock = buildMockGit({
      worktrees: [{ path: expectedPath, head: 'abc123', branch: 'feature/test' }],
    });

    await expect(
      createGitWorktree(buildRequest(), repo, { execFile: mock.execFile }),
    ).resolves.toMatchObject({
      ok: true,
      status: 'reused',
      path: expectedPath,
      branch: 'feature/test',
    });
    expect(mock.calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add')).toBe(
      false,
    );
  });

  it('treats an existing unmanaged target path as a planning collision', async () => {
    const { repo, expectedPath } = await buildRepo();
    const mock = buildMockGit();
    await mkdir(expectedPath, { recursive: true });

    await expect(
      planGitWorktree(buildRequest(), repo, { execFile: mock.execFile }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'path-collision',
    });
  });

  it('treats an existing branch at another path as a planning collision', async () => {
    const { repo } = await buildRepo();
    const mock = buildMockGit({
      worktrees: [{ path: '/tmp/other-worktree', head: 'abc123', branch: 'feature/test' }],
    });

    await expect(
      planGitWorktree(buildRequest(), repo, { execFile: mock.execFile }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'branch-collision',
    });
  });

  it('returns lock-busy when apply cannot acquire the create lock', async () => {
    const { repo } = await buildRepo();
    const lockRoot = await tempDir();
    const mock = buildMockGit();
    const plan = await planGitWorktree(buildRequest(), repo, { execFile: mock.execFile });
    if (!plan.ok) {
      throw new Error('expected planning to succeed');
    }

    const heldLock = await acquireWorktreeLock([repo.commonGitDir], { lockRoot });
    if (!heldLock.ok) {
      throw new Error(heldLock.message);
    }

    try {
      await expect(
        applyGitWorktreePlan(plan, repo, { execFile: mock.execFile, lockRoot }),
      ).resolves.toMatchObject({
        ok: false,
        reason: 'lock-busy',
      });
    } finally {
      await heldLock.release();
    }
  });

  it('returns git-failed when planning cannot read worktree state', async () => {
    const { repo } = await buildRepo();
    const mock = buildMockGit({ listFails: true });

    await expect(
      planGitWorktree(buildRequest(), repo, { execFile: mock.execFile }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'git-failed',
    });
  });

  it('releases the apply lock when git worktree add fails', async () => {
    const { repo } = await buildRepo();
    const lockRoot = await tempDir();
    const mock = buildMockGit({ addExitCode: 1, addStderr: 'boom' });
    const plan = await planGitWorktree(buildRequest(), repo, { execFile: mock.execFile });
    if (!plan.ok) {
      throw new Error('expected planning to succeed');
    }

    await expect(
      applyGitWorktreePlan(plan, repo, { execFile: mock.execFile, lockRoot }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'git-failed',
      message: 'Git worktree add failed: boom',
    });

    const nextLock = await acquireWorktreeLock([repo.commonGitDir], { lockRoot });
    expect(nextLock.ok).toBe(true);
    if (nextLock.ok) {
      await nextLock.release();
    }
  });

  it('reuses an exact branch/path race under the apply lock', async () => {
    const { repo, expectedPath } = await buildRepo();
    const mock = buildMockGit();
    const plan = await planGitWorktree(buildRequest(), repo, { execFile: mock.execFile });
    if (!plan.ok) {
      throw new Error('expected planning to succeed');
    }

    mock.setWorktrees([{ path: expectedPath, head: 'abc123', branch: 'feature/test' }]);

    await expect(
      applyGitWorktreePlan(plan, repo, { execFile: mock.execFile }),
    ).resolves.toMatchObject({
      ok: true,
      status: 'reused',
      path: expectedPath,
    });
    expect(mock.calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add')).toBe(
      false,
    );
  });

  it('turns a mismatched branch/path race into a collision under the apply lock', async () => {
    const { repo, expectedPath } = await buildRepo();
    const mock = buildMockGit();
    const plan = await planGitWorktree(buildRequest(), repo, { execFile: mock.execFile });
    if (!plan.ok) {
      throw new Error('expected planning to succeed');
    }

    mock.setWorktrees([{ path: expectedPath, head: 'abc123', branch: 'other/branch' }]);

    await expect(
      applyGitWorktreePlan(plan, repo, { execFile: mock.execFile }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'path-collision',
    });
    expect(mock.calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add')).toBe(
      false,
    );
  });

  it('pins the planned base sha for apply instead of re-resolving a moving ref', async () => {
    const { repo, expectedPath } = await buildRepo();
    const mock = buildMockGit({ baseSha: 'abc123' });
    const plan = await planGitWorktree(buildRequest(), repo, { execFile: mock.execFile });
    if (!plan.ok) {
      throw new Error('expected planning to succeed');
    }

    mock.calls.length = 0;
    mock.setBaseSha('def456');

    await expect(
      applyGitWorktreePlan(plan, repo, { execFile: mock.execFile }),
    ).resolves.toMatchObject({
      ok: true,
      status: 'created',
      path: expectedPath,
    });

    expect(mock.calls.some((call) => call.args[0] === 'rev-parse')).toBe(false);
    expect(mock.calls).toContainEqual({
      file: 'git',
      args: ['worktree', 'add', '-b', 'feature/test', expectedPath, 'abc123'],
    });
  });
});

function toPorcelain(entries: readonly GitWorktreeEntry[]): string {
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
