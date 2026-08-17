import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { defaultProcessRunner, type ProcessResult, type ProcessRunner } from './process.js';

const WORKTREE_ROOT_ENV = 'PI_CMUX_JUNCTION_WORKTREE_ROOT';
const DEFAULT_WORKTREE_ROOT = '.pi/cmux-junction-worktrees';

export interface WorktreeOptions {
  runner?: ProcessRunner;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  lockRoot?: string;
  timeoutMs?: number;
}

export interface ResolvedRepository {
  topLevel: string;
  commonGitDir: string;
  repoLabel: string;
}

export interface GitWorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
}

export interface WorktreePlan {
  ok: true;
  action: 'create' | 'reuse';
  branch: string;
  path: string;
  baseRef: string;
  baseSha: string;
  repository: ResolvedRepository;
  warning?: string;
}

export type WorktreeFailureReason =
  | 'not-a-repository'
  | 'invalid-branch'
  | 'invalid-label'
  | 'invalid-base-ref'
  | 'path-collision'
  | 'branch-collision'
  | 'git-failed'
  | 'invalid-worktree-root'
  | 'worktree-root-failed'
  | 'lock-busy';

export interface WorktreeFailure {
  ok: false;
  reason: WorktreeFailureReason;
  message: string;
}

export type WorktreePlanResult = WorktreePlan | WorktreeFailure;

export type WorktreeRootResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'invalid-worktree-root'; message: string };

export function resolveWorktreeRoot(
  options: Pick<WorktreeOptions, 'env' | 'homeDir'> = {},
): WorktreeRootResult {
  const home = resolve(options.homeDir ?? homedir());
  const configured = (options.env ?? process.env)[WORKTREE_ROOT_ENV]?.trim() ?? '';
  if (configured.length === 0) {
    return { ok: true, path: resolve(home, DEFAULT_WORKTREE_ROOT) };
  }
  if (configured === '~') {
    return { ok: true, path: home };
  }
  if (configured.startsWith('~/')) {
    return { ok: true, path: resolve(home, configured.slice(2)) };
  }
  if (configured.startsWith('~') || !isAbsolute(configured)) {
    return {
      ok: false,
      reason: 'invalid-worktree-root',
      message: `Invalid worktree root: ${configured}. Use an absolute path, ~, or ~/... .`,
    };
  }
  return { ok: true, path: resolve(configured) };
}

export interface WorktreeSuccess {
  ok: true;
  status: 'created' | 'reused';
  branch: string;
  path: string;
  baseRef: string;
  warning?: string;
}

export type WorktreeApplyResult = WorktreeSuccess | WorktreeFailure;

export async function planWorktree(
  cwd: string,
  requestedBranch: string,
  options: WorktreeOptions = {},
): Promise<WorktreePlanResult> {
  const root = resolveWorktreeRoot(options);
  if (!root.ok) {
    return root;
  }

  const repository = await resolveRepository(cwd, options);
  if (repository === null) {
    return {
      ok: false,
      reason: 'not-a-repository',
      message: `Could not resolve a Git repository from: ${cwd}`,
    };
  }

  const branch = requestedBranch.trim();
  const validation = await git(
    repository.topLevel,
    ['check-ref-format', '--branch', branch],
    options,
  );
  if (validation.exitCode !== 0) {
    return {
      ok: false,
      reason: 'invalid-branch',
      message: `Invalid Git branch name: ${branch}`,
    };
  }

  const branchSlug = slugPathLabel(branch, 48);
  if (branchSlug === null) {
    return {
      ok: false,
      reason: 'invalid-label',
      message: 'Could not derive a worktree path segment from the branch name.',
    };
  }

  const base = await resolveDefaultBase(repository.topLevel, options);
  const baseSha = await gitText(
    repository.topLevel,
    ['rev-parse', '--verify', `${base.baseRef}^{commit}`],
    options,
  );
  if (baseSha === null) {
    return {
      ok: false,
      reason: 'invalid-base-ref',
      message: `Base ref does not resolve to a commit: ${base.baseRef}`,
    };
  }

  const path = join(
    root.path,
    `${repository.repoLabel}--${repositoryId(repository.commonGitDir)}-${branchSlug}`,
  );
  const worktrees = await listWorktrees(repository.topLevel, options);
  if (worktrees === null) {
    return {
      ok: false,
      reason: 'git-failed',
      message: 'Could not list existing Git worktrees.',
    };
  }

  const state = inspectWorktrees(worktrees, path, branch);
  if (state === 'exact-reuse') {
    return buildPlan('reuse', repository, branch, path, base, baseSha);
  }
  if (state === 'path-collision') {
    return collision('path-collision', 'An existing worktree already uses the requested path.');
  }
  if (state === 'branch-collision') {
    return collision('branch-collision', 'An existing worktree already uses the requested branch.');
  }
  if (isUnmanagedPath(path, worktrees)) {
    return collision(
      'path-collision',
      `Target path already exists and is not a Git worktree: ${path}`,
    );
  }

  return buildPlan('create', repository, branch, path, base, baseSha);
}

export async function applyWorktreePlan(
  plan: WorktreePlan,
  options: WorktreeOptions = {},
): Promise<WorktreeApplyResult> {
  const lock = await acquireWorktreeLock(plan.repository.commonGitDir, options);
  if (!lock.ok) {
    return lock;
  }

  try {
    const worktrees = await listWorktrees(plan.repository.topLevel, options);
    if (worktrees === null) {
      return {
        ok: false,
        reason: 'git-failed',
        message: 'Could not list existing Git worktrees.',
      };
    }

    const state = inspectWorktrees(worktrees, plan.path, plan.branch);
    if (state === 'exact-reuse') {
      return toSuccess(plan, 'reused');
    }
    if (state === 'path-collision') {
      return collision('path-collision', 'An existing worktree already uses the requested path.');
    }
    if (state === 'branch-collision') {
      return collision(
        'branch-collision',
        'An existing worktree already uses the requested branch.',
      );
    }
    if (isUnmanagedPath(plan.path, worktrees)) {
      return collision(
        'path-collision',
        `Target path already exists and is not a Git worktree: ${plan.path}`,
      );
    }
    if (plan.action === 'reuse') {
      return {
        ok: false,
        reason: 'git-failed',
        message: 'Expected an existing reusable worktree, but it no longer exists.',
      };
    }

    const rootFailure = await ensureWorktreeParent(plan.path);
    if (rootFailure !== null) {
      return rootFailure;
    }

    const result = await git(
      plan.repository.topLevel,
      ['worktree', 'add', '-b', plan.branch, plan.path, plan.baseSha],
      options,
    );
    if (result.exitCode !== 0) {
      return {
        ok: false,
        reason: 'git-failed',
        message: `Git worktree add failed: ${commandError(result)}`,
      };
    }

    return toSuccess(plan, 'created');
  } finally {
    await lock.release();
  }
}

export async function resolveRepository(
  cwd: string,
  options: WorktreeOptions = {},
): Promise<ResolvedRepository | null> {
  const [topLevel, commonGitDir] = await Promise.all([
    gitText(cwd, ['rev-parse', '--show-toplevel'], options),
    gitText(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], options),
  ]);
  if (topLevel === null || commonGitDir === null) {
    return null;
  }

  const absoluteCommonGitDir = resolve(commonGitDir);
  return {
    topLevel: resolve(topLevel),
    commonGitDir: absoluteCommonGitDir,
    repoLabel: repositoryLabel(absoluteCommonGitDir),
  };
}

export function slugPathLabel(value: string, limit: number): string | null {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, limit);
  return slug.length === 0 ? null : slug;
}

export function parseWorktreeList(source: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  let current: GitWorktreeEntry | null = null;

  for (const token of source.split('\0')) {
    if (token.length === 0) {
      if (current !== null) {
        entries.push(current);
        current = null;
      }
      continue;
    }

    const separator = token.indexOf(' ');
    const key = separator === -1 ? token : token.slice(0, separator);
    const value = separator === -1 ? '' : token.slice(separator + 1);
    if (key === 'worktree') {
      if (current !== null) {
        entries.push(current);
      }
      current = { path: value, head: null, branch: null };
    } else if (current !== null && key === 'HEAD') {
      current.head = value;
    } else if (current !== null && key === 'branch') {
      current.branch = stripRefsHeads(value);
    }
  }

  if (current !== null) {
    entries.push(current);
  }
  return entries;
}

interface ResolvedBase {
  baseRef: string;
  warning?: string;
}

async function resolveDefaultBase(cwd: string, options: WorktreeOptions): Promise<ResolvedBase> {
  const remoteDefault = await gitText(
    cwd,
    ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    options,
  );
  if (remoteDefault !== null && (await resolvesCommit(cwd, remoteDefault, options))) {
    return { baseRef: remoteDefault };
  }

  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    if (await resolvesCommit(cwd, candidate, options)) {
      return { baseRef: candidate };
    }
  }

  return {
    baseRef: 'HEAD',
    warning: 'Could not resolve a remote/default base branch; using local HEAD.',
  };
}

async function resolvesCommit(
  cwd: string,
  ref: string,
  options: WorktreeOptions,
): Promise<boolean> {
  return (await gitText(cwd, ['rev-parse', '--verify', `${ref}^{commit}`], options)) !== null;
}

async function listWorktrees(
  cwd: string,
  options: WorktreeOptions,
): Promise<GitWorktreeEntry[] | null> {
  const result = await git(cwd, ['worktree', 'list', '--porcelain', '-z'], options);
  return result.exitCode === 0 ? parseWorktreeList(result.stdout) : null;
}

async function gitText(
  cwd: string,
  args: readonly string[],
  options: WorktreeOptions,
): Promise<string | null> {
  const result = await git(cwd, args, options);
  if (result.exitCode !== 0) {
    return null;
  }
  const text = result.stdout.trim();
  return text.length === 0 ? null : text;
}

async function git(
  cwd: string,
  args: readonly string[],
  options: WorktreeOptions,
): Promise<ProcessResult> {
  return await (options.runner ?? defaultProcessRunner)('git', args, {
    cwd,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

function repositoryLabel(commonGitDir: string): string {
  const raw =
    basename(commonGitDir) === '.git' ? basename(dirname(commonGitDir)) : basename(commonGitDir);
  return slugPathLabel(raw.replace(/\.git$/u, ''), 64) ?? 'repo';
}

function repositoryId(commonGitDir: string): string {
  return createHash('sha256').update(commonGitDir).digest('hex').slice(0, 12);
}

function inspectWorktrees(
  worktrees: readonly GitWorktreeEntry[],
  path: string,
  branch: string,
): 'exact-reuse' | 'path-collision' | 'branch-collision' | 'available' {
  const existingByPath = worktrees.find((entry) => resolve(entry.path) === path);
  const existingByBranch = worktrees.find((entry) => stripRefsHeads(entry.branch ?? '') === branch);
  if (
    (existingByPath !== undefined && stripRefsHeads(existingByPath.branch ?? '') === branch) ||
    (existingByBranch !== undefined && resolve(existingByBranch.path) === path)
  ) {
    return 'exact-reuse';
  }
  if (existingByPath !== undefined) {
    return 'path-collision';
  }
  return existingByBranch === undefined ? 'available' : 'branch-collision';
}

function isUnmanagedPath(path: string, worktrees: readonly GitWorktreeEntry[]): boolean {
  return existsSync(path) && !worktrees.some((entry) => resolve(entry.path) === path);
}

async function ensureWorktreeParent(path: string): Promise<WorktreeFailure | null> {
  try {
    await mkdir(dirname(path), { recursive: true });
    return null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: 'worktree-root-failed',
      message: `Could not create worktree root: ${detail}`,
    };
  }
}

function stripRefsHeads(branch: string): string {
  return branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch;
}

function buildPlan(
  action: WorktreePlan['action'],
  repository: ResolvedRepository,
  branch: string,
  path: string,
  base: ResolvedBase,
  baseSha: string,
): WorktreePlan {
  return {
    ok: true,
    action,
    repository,
    branch,
    path,
    baseRef: base.baseRef,
    baseSha,
    ...(base.warning === undefined ? {} : { warning: base.warning }),
  };
}

function toSuccess(plan: WorktreePlan, status: WorktreeSuccess['status']): WorktreeSuccess {
  return {
    ok: true,
    status,
    branch: plan.branch,
    path: plan.path,
    baseRef: plan.baseRef,
    ...(plan.warning === undefined ? {} : { warning: plan.warning }),
  };
}

function collision(
  reason: 'path-collision' | 'branch-collision',
  message: string,
): WorktreeFailure {
  return { ok: false, reason, message };
}

async function acquireWorktreeLock(
  commonGitDir: string,
  options: WorktreeOptions,
): Promise<
  { ok: true; release: () => Promise<void> } | { ok: false; reason: 'lock-busy'; message: string }
> {
  const lockRoot =
    options.lockRoot ??
    join(resolve(options.homeDir ?? homedir()), '.pi', 'session-deck', 'worktree-locks');
  await mkdir(lockRoot, { recursive: true });
  const hash = createHash('sha256').update(commonGitDir).digest('hex').slice(0, 32);
  const path = join(lockRoot, `${hash}.lock`);
  try {
    await mkdir(path, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return {
        ok: false,
        reason: 'lock-busy',
        message: 'A matching worktree action is already running.',
      };
    }
    throw error;
  }
  return {
    ok: true,
    release: async () => {
      await rm(path, { force: true, recursive: true });
    },
  };
}

function commandError(result: ProcessResult): string {
  return (result.stderr || result.stdout).trim() || `exit ${result.exitCode}`;
}
