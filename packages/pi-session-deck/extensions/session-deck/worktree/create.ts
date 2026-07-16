import { resolve } from 'node:path';
import { acquireWorktreeLock, type WorktreeLockOptions } from './locks.js';
import {
  defaultWorktreePath,
  execGit,
  formatGitWorktreeManualCommand,
  isPathCollision,
  listGitWorktrees,
  normalizeRequestedPath,
  resolveCommitRef,
  resolveDefaultBaseRef,
  stripRefsHeads,
  validateBranchName,
  type GitCommandOptions,
  type GitWorktreeEntry,
} from './git.js';
import type {
  CreateWorktreeActionRequest,
  CreateWorktreeFailure,
  CreateWorktreePhaseResult,
  CreateWorktreeResolvedRepo,
  CreateWorktreeSuccess,
} from './types.js';

export interface CreateGitWorktreeOptions extends GitCommandOptions, WorktreeLockOptions {}

export interface PlannedGitWorktree {
  ok: true;
  action: 'create' | 'reuse';
  path: string;
  branch: string;
  baseRef: string;
  baseSha: string;
  repoName: string | null;
  qualifiedRepoName: string | null;
  warning?: string;
  manualCommand: string;
}

export type PlanGitWorktreeResult = PlannedGitWorktree | CreateWorktreeFailure;

export async function planGitWorktree(
  request: CreateWorktreeActionRequest,
  repo: CreateWorktreeResolvedRepo,
  options: GitCommandOptions = {},
): Promise<PlanGitWorktreeResult> {
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
  const baseSha = await resolveCommitRef(repo.primaryWorktreePath, baseResolution.baseRef, options);
  if (baseSha === null) {
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
  const manualCommand = formatGitWorktreeManualCommand(path, branch, baseSha);

  const worktrees = await listGitWorktrees(repo.primaryWorktreePath, options);
  if (worktrees === null) {
    return {
      ok: false,
      reason: 'git-failed',
      message: 'Could not list existing Git worktrees.',
      recoverable: true,
    };
  }

  const state = inspectExistingWorktrees(worktrees, path, branch);
  if (state === 'exact-reuse') {
    return buildPlan(
      'reuse',
      repo,
      branch,
      path,
      baseResolution.baseRef,
      baseSha,
      manualCommand,
      baseResolution.warning,
    );
  }
  if (state === 'path-collision') {
    return {
      ok: false,
      reason: 'path-collision',
      message: 'An existing worktree already uses the requested path or branch.',
      recoverable: true,
    };
  }
  if (state === 'branch-collision') {
    return {
      ok: false,
      reason: 'branch-collision',
      message: 'An existing worktree already uses the requested path or branch.',
      recoverable: true,
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

  return buildPlan(
    'create',
    repo,
    branch,
    path,
    baseResolution.baseRef,
    baseSha,
    manualCommand,
    baseResolution.warning,
  );
}

export async function applyGitWorktreePlan(
  plan: PlannedGitWorktree,
  repo: CreateWorktreeResolvedRepo,
  options: CreateGitWorktreeOptions = {},
): Promise<CreateWorktreePhaseResult> {
  const lock = await acquireWorktreeLock([repo.commonGitDir], options);
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

    const state = inspectExistingWorktrees(worktrees, plan.path, plan.branch);
    if (state === 'exact-reuse') {
      return toSuccess(plan, 'reused');
    }
    if (state === 'path-collision') {
      return {
        ok: false,
        reason: 'path-collision',
        message: 'An existing worktree already uses the requested path or branch.',
        recoverable: true,
      };
    }
    if (state === 'branch-collision') {
      return {
        ok: false,
        reason: 'branch-collision',
        message: 'An existing worktree already uses the requested path or branch.',
        recoverable: true,
      };
    }

    if (isPathCollision(plan.path, worktrees)) {
      return {
        ok: false,
        reason: 'path-collision',
        message: `Target path already exists and is not a Git worktree: ${plan.path}`,
        recoverable: true,
      };
    }

    if (plan.action === 'reuse') {
      return {
        ok: false,
        reason: 'git-failed',
        message: 'Expected an existing reusable worktree, but it no longer exists.',
        recoverable: true,
      };
    }

    const result = await execGit(
      repo.primaryWorktreePath,
      ['worktree', 'add', '-b', plan.branch, plan.path, plan.baseSha],
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

    return toSuccess(plan, 'created');
  } finally {
    await lock.release();
  }
}

export async function createGitWorktree(
  request: CreateWorktreeActionRequest,
  repo: CreateWorktreeResolvedRepo,
  options: CreateGitWorktreeOptions = {},
): Promise<CreateWorktreePhaseResult> {
  const plan = await planGitWorktree(request, repo, options);
  if (!plan.ok) {
    return plan;
  }

  return await applyGitWorktreePlan(plan, repo, options);
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

function buildPlan(
  action: PlannedGitWorktree['action'],
  repo: CreateWorktreeResolvedRepo,
  branch: string,
  path: string,
  baseRef: string,
  baseSha: string,
  manualCommand: string,
  warning?: string,
): PlannedGitWorktree {
  return {
    ok: true,
    action,
    path,
    branch,
    baseRef,
    baseSha,
    repoName: repo.repoName,
    qualifiedRepoName: repo.qualifiedRepoName,
    ...(warning === undefined ? {} : { warning }),
    manualCommand,
  };
}

function toSuccess(
  plan: PlannedGitWorktree,
  status: CreateWorktreeSuccess['status'],
): CreateWorktreeSuccess {
  return {
    ok: true,
    status,
    path: plan.path,
    branch: plan.branch,
    baseRef: plan.baseRef,
    repoName: plan.repoName,
    qualifiedRepoName: plan.qualifiedRepoName,
    ...(plan.warning === undefined ? {} : { warning: plan.warning }),
    manualCommand: plan.manualCommand,
  };
}

function inspectExistingWorktrees(
  worktrees: readonly GitWorktreeEntry[],
  path: string,
  branch: string,
): 'exact-reuse' | 'path-collision' | 'branch-collision' | 'available' {
  const existingByPath = worktrees.find((entry) => resolve(entry.path) === path);
  const existingByBranch = worktrees.find((entry) => stripRefsHeads(entry.branch ?? '') === branch);

  const pathMatchesBranch =
    existingByPath !== undefined && stripRefsHeads(existingByPath.branch ?? '') === branch;
  const branchMatchesPath =
    existingByBranch !== undefined && resolve(existingByBranch.path) === path;
  if (pathMatchesBranch || branchMatchesPath) {
    return 'exact-reuse';
  }

  if (existingByPath !== undefined) {
    return 'path-collision';
  }

  if (existingByBranch !== undefined) {
    return 'branch-collision';
  }

  return 'available';
}
