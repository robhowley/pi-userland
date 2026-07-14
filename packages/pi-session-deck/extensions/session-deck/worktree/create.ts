import { resolve } from 'node:path';
import { acquireWorktreeLock, type WorktreeLockOptions } from './locks.js';
import {
  defaultWorktreePath,
  execGit,
  formatGitWorktreeManualCommand,
  isPathCollision,
  listGitWorktrees,
  normalizeRequestedPath,
  resolveDefaultBaseRef,
  stripRefsHeads,
  validateBranchName,
  verifyCommitRef,
  type GitCommandOptions,
} from './git.js';
import type {
  CreateWorktreeActionRequest,
  CreateWorktreePhaseResult,
  CreateWorktreeResolvedRepo,
} from './types.js';

export interface CreateGitWorktreeOptions extends GitCommandOptions, WorktreeLockOptions {}

export async function createGitWorktree(
  request: CreateWorktreeActionRequest,
  repo: CreateWorktreeResolvedRepo,
  options: CreateGitWorktreeOptions = {},
): Promise<CreateWorktreePhaseResult> {
  const branch = request.branchName.trim();
  if (!(await validateBranchName(repo.primaryWorktreePath, branch, options))) {
    return {
      ok: false,
      reason: 'invalid-branch',
      message: `Invalid Git branch name: ${branch}`,
      recoverable: true,
    };
  }

  const slug = slugifyWorktreeLabel(branch);
  if (slug === null) {
    return {
      ok: false,
      reason: 'invalid-label',
      message: 'Could not derive a worktree path segment from the branch name.',
      recoverable: true,
    };
  }

  const baseResolution = request.baseRef?.trim()
    ? { baseRef: request.baseRef.trim() }
    : await resolveDefaultBaseRef(repo.primaryWorktreePath, options);
  if (!(await verifyCommitRef(repo.primaryWorktreePath, baseResolution.baseRef, options))) {
    return {
      ok: false,
      reason: 'invalid-base-ref',
      message: `Base ref does not resolve to a commit: ${baseResolution.baseRef}`,
      recoverable: true,
    };
  }

  const path = resolve(
    request.path?.trim()
      ? normalizeRequestedPath(request.path, repo.primaryWorktreePath)
      : defaultWorktreePath(repo.primaryWorktreePath, repo.repoName, slug),
  );
  const manualCommand = formatGitWorktreeManualCommand(path, branch, baseResolution.baseRef);
  const lock = await acquireWorktreeLock([repo.commonGitDir, branch, path], options);
  if (!lock.ok) {
    return {
      ok: false,
      reason: 'lock-busy',
      message: lock.message,
      recoverable: true,
    };
  }

  try {
    const worktrees = await listGitWorktrees(repo.primaryWorktreePath, options);
    if (worktrees === null) {
      return {
        ok: false,
        reason: 'git-failed',
        message: 'Could not list existing Git worktrees.',
        recoverable: true,
      };
    }

    const existingByPath = worktrees.find((entry) => resolve(entry.path) === path);
    const existingByBranch = worktrees.find(
      (entry) => stripRefsHeads(entry.branch ?? '') === branch,
    );
    if (existingByPath !== undefined || existingByBranch !== undefined) {
      const existing = existingByPath ?? existingByBranch!;
      if (resolve(existing.path) !== path || stripRefsHeads(existing.branch ?? '') !== branch) {
        return {
          ok: false,
          reason: existingByPath !== undefined ? 'path-collision' : 'branch-collision',
          message: 'An existing worktree already uses the requested path or branch.',
          recoverable: true,
        };
      }

      return {
        ok: true,
        status: 'reused',
        path,
        branch,
        baseRef: baseResolution.baseRef,
        repoName: repo.repoName,
        qualifiedRepoName: repo.qualifiedRepoName,
        ...(baseResolution.warning === undefined ? {} : { warning: baseResolution.warning }),
        manualCommand,
      };
    }

    if (isPathCollision(path, worktrees)) {
      return {
        ok: false,
        reason: 'path-collision',
        message: `Target path already exists and is not a Git worktree: ${path}`,
        recoverable: true,
      };
    }

    const result = await execGit(
      repo.primaryWorktreePath,
      ['worktree', 'add', '-b', branch, path, baseResolution.baseRef],
      options,
    );
    if (result.exitCode !== 0) {
      return {
        ok: false,
        reason: 'git-failed',
        message: `Git worktree add failed: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`,
        recoverable: true,
      };
    }

    return {
      ok: true,
      status: 'created',
      path,
      branch,
      baseRef: baseResolution.baseRef,
      repoName: repo.repoName,
      qualifiedRepoName: repo.qualifiedRepoName,
      ...(baseResolution.warning === undefined ? {} : { warning: baseResolution.warning }),
      manualCommand,
    };
  } finally {
    await lock.release();
  }
}

export function slugifyWorktreeLabel(label: string): string | null {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48);

  return slug.length === 0 ? null : slug;
}
