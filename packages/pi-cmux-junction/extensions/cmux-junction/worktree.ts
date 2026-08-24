import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  defaultProcessRunner,
  processError,
  processSucceeded,
  type ProcessResult,
  type ProcessRunner,
} from './process.js';

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
  prunable: string | null;
}

interface WorktreePlanBase {
  ok: true;
  branch: string;
  path: string;
  repository: ResolvedRepository;
}

export interface DefaultWorktreePlan extends WorktreePlanBase {
  kind: 'create-default';
  baseRef: string;
  baseSha: string;
  warning?: string;
}

export interface ExplicitWorktreePlan extends WorktreePlanBase {
  kind: 'create-explicit';
  baseRef: string;
  baseSha: string;
}

export interface CheckoutWorktreePlan extends WorktreePlanBase {
  kind: 'checkout';
  branchRef: string;
}

export type WorktreePlan = DefaultWorktreePlan | ExplicitWorktreePlan | CheckoutWorktreePlan;

export type WorktreeFailureReason =
  | 'not-a-repository'
  | 'invalid-branch'
  | 'invalid-label'
  | 'invalid-base-ref'
  | 'missing-local-branch'
  | 'path-collision'
  | 'branch-collision'
  | 'git-failed'
  | 'invalid-worktree-root'
  | 'worktree-root-failed'
  | 'lock-busy'
  | 'prunable-worktree'
  | 'git-add-unknown';

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

interface DefaultWorktreeSuccess {
  ok: true;
  kind: 'create-default';
  status: 'created' | 'reused';
  branch: string;
  path: string;
  baseRef: string;
  warning?: string;
}

interface ExplicitWorktreeSuccess {
  ok: true;
  kind: 'create-explicit';
  status: 'created';
  branch: string;
  path: string;
  baseRef: string;
  baseSha: string;
  warning?: string;
}

interface CheckoutWorktreeSuccess {
  ok: true;
  kind: 'checkout';
  status: 'created' | 'reused';
  branch: string;
  path: string;
  branchRef: string;
}

export type WorktreeSuccess =
  | DefaultWorktreeSuccess
  | ExplicitWorktreeSuccess
  | CheckoutWorktreeSuccess;

export type WorktreeApplyResult = WorktreeSuccess | WorktreeFailure;

async function planWorktreeTarget(
  cwd: string,
  requestedBranch: string,
  options: WorktreeOptions,
  rejectQualifiedRef = false,
): Promise<WorktreePlanBase | WorktreeFailure> {
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
  if (rejectQualifiedRef && branch.startsWith('refs/')) {
    return {
      ok: false,
      reason: 'invalid-branch',
      message: `Invalid Git branch name: ${branch}`,
    };
  }

  const validation = await git(
    repository.topLevel,
    ['check-ref-format', '--branch', branch],
    options,
  );
  if (!processSucceeded(validation)) {
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

  return {
    ok: true,
    repository,
    branch,
    path: join(root.path, `${repository.repoLabel}-${branchSlug}`),
  };
}

export async function planWorktree(
  cwd: string,
  requestedBranch: string,
  options: WorktreeOptions = {},
  from?: string,
): Promise<DefaultWorktreePlan | ExplicitWorktreePlan | WorktreeFailure> {
  const target = await planWorktreeTarget(cwd, requestedBranch, options);
  if (!target.ok) {
    return target;
  }
  const { repository, branch, path } = target;
  if (from !== undefined) {
    const base = await resolveExplicitBase(repository.topLevel, from, options);
    if (!base.ok) {
      return base;
    }
    return {
      ok: true,
      kind: 'create-explicit',
      repository,
      branch,
      path,
      baseRef: from,
      baseSha: base.sha,
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

  return buildDefaultPlan(repository, branch, path, base, baseSha);
}

export async function planCheckoutWorktree(
  cwd: string,
  requestedBranch: string,
  options: WorktreeOptions = {},
): Promise<CheckoutWorktreePlan | WorktreeFailure> {
  const target = await planWorktreeTarget(cwd, requestedBranch, options, true);
  if (!target.ok) {
    return target;
  }

  const branchRef = `refs/heads/${target.branch}`;
  const branchState = await checkoutBranchState(target.repository.topLevel, branchRef, options);
  if (branchState === 'missing') {
    return missingLocalBranch(target.branch);
  }
  if (branchState === 'unknown') {
    return {
      ok: false,
      reason: 'git-failed',
      message: `Could not verify local branch ${branchRef}.`,
    };
  }

  return {
    ok: true,
    kind: 'checkout',
    repository: target.repository,
    branch: target.branch,
    branchRef,
    path: target.path,
  };
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

    if (isCheckoutPlan(plan)) {
      const state = inspectWorktrees(worktrees, plan.path, plan.branch);
      if (state === 'prunable') {
        return prunableFailure(plan, worktrees);
      }

      const branchState = await checkoutBranchState(
        plan.repository.topLevel,
        plan.branchRef,
        options,
      );
      if (branchState === 'missing') {
        return missingLocalBranch(plan.branch);
      }
      if (branchState === 'unknown') {
        return {
          ok: false,
          reason: 'git-failed',
          message: `Could not verify local branch ${plan.branchRef}.`,
        };
      }

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
    } else if (isExplicitPlan(plan)) {
      const collisionFailure = await inspectExplicitAvailability(plan, worktrees, options);
      if (collisionFailure !== null) {
        return collisionFailure;
      }
    } else {
      const state = inspectWorktrees(worktrees, plan.path, plan.branch);
      if (state === 'prunable') {
        return prunableFailure(plan, worktrees);
      }
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
    }

    const rootFailure = await ensureWorktreeParent(plan.path);
    if (rootFailure !== null) {
      return rootFailure;
    }

    const result = await git(
      plan.repository.topLevel,
      isCheckoutPlan(plan)
        ? ['worktree', 'add', plan.path, plan.branchRef]
        : ['worktree', 'add', '-b', plan.branch, plan.path, plan.baseSha],
      options,
    );
    if (!processSucceeded(result)) {
      if (isCheckoutPlan(plan)) {
        return await reconcileFailedCheckoutAdd(plan, result, options);
      }
      return isExplicitPlan(plan)
        ? await reconcileFailedExplicitAdd(plan, result, options)
        : await reconcileFailedAdd(plan, result, options);
    }

    if (isExplicitPlan(plan)) {
      const postAddWorktrees = await listWorktrees(plan.repository.topLevel, options);
      if (postAddWorktrees === null || !(await matchesRetainedWorktree(plan, postAddWorktrees))) {
        return unknownWorktreeState(
          plan,
          'Git worktree add succeeded, but Junction could not prove the exact retained worktree state.',
        );
      }
    }

    return toSuccess(plan, 'created');
  } finally {
    await lock.release();
  }
}

/**
 * Proves an explicit worktree is still safe to retain after a definite launch failure.
 * This only relists Git metadata under the common-Git-dir lock; it never repairs or mutates it.
 */
export async function proveRetainedWorktree(
  plan: ExplicitWorktreePlan,
  options: WorktreeOptions = {},
): Promise<boolean> {
  let lock: Awaited<ReturnType<typeof acquireWorktreeLock>>;
  try {
    lock = await acquireWorktreeLock(plan.repository.commonGitDir, options);
  } catch {
    return false;
  }
  if (!lock.ok) {
    return false;
  }

  try {
    const worktrees = await listWorktrees(plan.repository.topLevel, options);
    return worktrees !== null && (await matchesRetainedWorktree(plan, worktrees));
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
  const resolvedTopLevel = resolve(topLevel);
  const [originRemote, remoteList] = await Promise.all([
    safeGitText(resolvedTopLevel, ['remote', 'get-url', 'origin'], options),
    safeGitText(resolvedTopLevel, ['remote', '-v'], options),
  ]);
  const qualifiedRepoName = resolveRemoteRepoIdentity(originRemote, remoteList);

  return {
    topLevel: resolvedTopLevel,
    commonGitDir: absoluteCommonGitDir,
    repoLabel: repositoryPathLabel(absoluteCommonGitDir, qualifiedRepoName),
  };
}

export function slugPathLabel(value: string, limit: number): string | null {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .slice(0, limit)
    .replace(/^-+|-+$/gu, '');
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
      current = { path: value, head: null, branch: null, prunable: null };
    } else if (current !== null && key === 'HEAD') {
      current.head = value;
    } else if (current !== null && key === 'branch') {
      current.branch = stripRefsHeads(value);
    } else if (current !== null && key === 'prunable') {
      current.prunable = value;
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

interface ExplicitBaseResolution {
  ok: true;
  sha: string;
}

async function resolveExplicitBase(
  cwd: string,
  input: string,
  options: WorktreeOptions,
): Promise<ExplicitBaseResolution | WorktreeFailure> {
  const result = await git(
    cwd,
    ['rev-parse', '--verify', '--end-of-options', `${input}^{commit}`],
    options,
  );
  if (result.outcome !== 'exit') {
    return {
      ok: false,
      reason: 'git-failed',
      message: `Could not resolve base ref ${input}: ${processError(result)}`,
    };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      reason: 'invalid-base-ref',
      message: `Base ref does not resolve to a commit: ${input}`,
    };
  }

  const sha = result.stdout.trim();
  if (sha.length === 0) {
    return {
      ok: false,
      reason: 'invalid-base-ref',
      message: `Base ref does not resolve to a commit: ${input}`,
    };
  }
  return { ok: true, sha };
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
  return processSucceeded(result) ? parseWorktreeList(result.stdout) : null;
}

async function gitText(
  cwd: string,
  args: readonly string[],
  options: WorktreeOptions,
): Promise<string | null> {
  const result = await git(cwd, args, options);
  if (!processSucceeded(result)) {
    return null;
  }
  const text = result.stdout.trim();
  return text.length === 0 ? null : text;
}

async function safeGitText(
  cwd: string,
  args: readonly string[],
  options: WorktreeOptions,
): Promise<string | null> {
  try {
    return await gitText(cwd, args, options);
  } catch {
    return null;
  }
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

interface ParsedFetchRemote {
  name: string;
  url: string;
}

function repositoryPathLabel(commonGitDir: string, qualifiedRepoName: string | null): string {
  const fallback = repositoryLabel(commonGitDir);
  return slugPathLabel(qualifiedRepoName ?? fallback, 64) ?? fallback;
}

function repositoryLabel(commonGitDir: string): string {
  const raw =
    basename(commonGitDir) === '.git' ? basename(dirname(commonGitDir)) : basename(commonGitDir);
  return slugPathLabel(raw.replace(/\.git$/u, ''), 64) ?? 'repo';
}

function resolveRemoteRepoIdentity(
  originRemote: string | null,
  remoteList: string | null,
): string | null {
  const originRepo = parseRemoteRepo(originRemote);
  if (originRepo !== null) {
    return originRepo;
  }

  const fallbackRemote = getFirstNonOriginFetchRemote(remoteList);
  if (fallbackRemote === null) {
    return null;
  }

  return parseRemoteRepo(fallbackRemote.url);
}

function getFirstNonOriginFetchRemote(remoteList: string | null): ParsedFetchRemote | null {
  if (remoteList === null) {
    return null;
  }

  for (const line of remoteList.split(/\r?\n/)) {
    const match = line.trim().match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (match === null) {
      continue;
    }

    const name = match[1] ?? null;
    const url = match[2] ?? null;
    const direction = match[3] ?? null;
    if (direction === 'fetch' && name !== null && name !== 'origin' && url !== null) {
      return { name, url };
    }
  }

  return null;
}

function parseRemoteRepo(remoteUrl: string | null): string | null {
  if (remoteUrl === null) {
    return null;
  }

  const qualifiedRepoName = extractQualifiedRepoName(remoteUrl.trim());
  if (qualifiedRepoName === null) {
    return null;
  }

  const separatorIndex = qualifiedRepoName.lastIndexOf('/');
  const repoName = separatorIndex === -1 ? null : qualifiedRepoName.slice(separatorIndex + 1);
  return repoName === null || repoName.length === 0 ? null : qualifiedRepoName;
}

function extractQualifiedRepoName(remoteUrl: string): string | null {
  if (remoteUrl.length === 0) {
    return null;
  }

  if (remoteUrl.includes('://')) {
    try {
      const parsedUrl = new URL(remoteUrl);
      if (parsedUrl.protocol === 'file:') {
        return null;
      }

      return extractQualifiedRepoNameFromPath(parsedUrl.pathname);
    } catch {
      return null;
    }
  }

  const scpLikeMatch = remoteUrl.match(/^(?:[^@\s]+@)?[^:/\s]+:(.+)$/);
  const scpLikePath = scpLikeMatch?.[1] ?? null;
  return scpLikePath === null ? null : extractQualifiedRepoNameFromPath(scpLikePath);
}

function extractQualifiedRepoNameFromPath(pathValue: string): string | null {
  const segments = splitPathSegments(pathValue);
  if (segments.length < 2) {
    return null;
  }

  const owner = segments[segments.length - 2] ?? null;
  const repoName = stripGitSuffix(segments[segments.length - 1] ?? '');
  if (owner === null || owner.length === 0 || repoName.length === 0) {
    return null;
  }

  return `${owner}/${repoName}`;
}

function stripGitSuffix(value: string): string {
  return value.endsWith('.git') ? value.slice(0, -4) : value;
}

function splitPathSegments(pathValue: string): string[] {
  return pathValue
    .replace(/[\\/]+$/u, '')
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0 && segment !== '.');
}

type WorktreeState =
  | 'prunable'
  | 'exact-reuse'
  | 'path-collision'
  | 'branch-collision'
  | 'available';

function inspectWorktrees(
  worktrees: readonly GitWorktreeEntry[],
  path: string,
  branch: string,
): WorktreeState {
  const existingByPath = worktrees.find((entry) => resolve(entry.path) === path);
  const existingByBranch = worktrees.find((entry) => stripRefsHeads(entry.branch ?? '') === branch);
  const prunable = worktrees.find(
    (entry) =>
      entry.prunable !== null &&
      entry.prunable !== undefined &&
      (resolve(entry.path) === path || stripRefsHeads(entry.branch ?? '') === branch),
  );
  if (prunable !== undefined) {
    return 'prunable';
  }
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

async function inspectExplicitAvailability(
  plan: ExplicitWorktreePlan,
  worktrees: readonly GitWorktreeEntry[],
  options: WorktreeOptions,
): Promise<WorktreeFailure | null> {
  const state = inspectWorktrees(worktrees, plan.path, plan.branch);
  if (state === 'prunable') {
    return prunableFailure(plan, worktrees);
  }
  if (state === 'exact-reuse') {
    return collision(
      'branch-collision',
      'An existing worktree already uses the requested branch; explicit creation never reuses worktrees.',
    );
  }
  if (state === 'path-collision') {
    return collision('path-collision', 'An existing worktree already uses the requested path.');
  }
  if (state === 'branch-collision') {
    return collision('branch-collision', 'An existing worktree already uses the requested branch.');
  }
  if (isUnmanagedPath(plan.path, worktrees)) {
    return collision(
      'path-collision',
      `Target path already exists and is not a Git worktree: ${plan.path}`,
    );
  }

  const branchState = await localBranchState(plan.repository.topLevel, plan.branch, options);
  if (branchState === 'present') {
    return collision(
      'branch-collision',
      'The requested local branch already exists; explicit creation never reuses branches.',
    );
  }
  if (branchState === 'unknown') {
    return {
      ok: false,
      reason: 'git-failed',
      message: `Could not verify whether local branch refs/heads/${plan.branch} exists.`,
    };
  }
  return null;
}

type LocalBranchState = 'present' | 'absent' | 'unknown';
type CheckoutBranchState = 'present' | 'missing' | 'unknown';

async function checkoutBranchState(
  cwd: string,
  branchRef: string,
  options: WorktreeOptions,
): Promise<CheckoutBranchState> {
  const result = await git(
    cwd,
    ['rev-parse', '--verify', '--quiet', '--end-of-options', `${branchRef}^{commit}`],
    options,
  );
  if (result.outcome !== 'exit') {
    return 'unknown';
  }
  if (result.exitCode === 0) {
    return 'present';
  }
  return result.exitCode === 1 ? 'missing' : 'unknown';
}

async function localBranchState(
  cwd: string,
  branch: string,
  options: WorktreeOptions,
): Promise<LocalBranchState> {
  const result = await git(
    cwd,
    ['show-ref', '--verify', '--quiet', '--', `refs/heads/${branch}`],
    options,
  );
  if (result.outcome !== 'exit') {
    return 'unknown';
  }
  if (result.exitCode === 0) {
    return 'present';
  }
  return result.exitCode === 1 ? 'absent' : 'unknown';
}

function isUnmanagedPath(path: string, worktrees: readonly GitWorktreeEntry[]): boolean {
  return existsSync(path) && !worktrees.some((entry) => resolve(entry.path) === path);
}

async function matchesRetainedWorktree(
  plan: ExplicitWorktreePlan,
  worktrees: readonly GitWorktreeEntry[],
): Promise<boolean> {
  let physicalPath: string;
  try {
    physicalPath = await realpath(plan.path);
  } catch {
    return false;
  }

  const matching = worktrees.filter(
    (entry) =>
      resolve(entry.path) === physicalPath &&
      entry.branch !== null &&
      stripRefsHeads(entry.branch) === plan.branch,
  );
  return (
    matching.length === 1 && matching[0]?.prunable === null && matching[0]?.head === plan.baseSha
  );
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

function buildDefaultPlan(
  repository: ResolvedRepository,
  branch: string,
  path: string,
  base: ResolvedBase,
  baseSha: string,
): DefaultWorktreePlan {
  return {
    ok: true,
    kind: 'create-default',
    repository,
    branch,
    path,
    baseRef: base.baseRef,
    baseSha,
    ...(base.warning === undefined ? {} : { warning: base.warning }),
  };
}

function isCheckoutPlan(plan: WorktreePlan): plan is CheckoutWorktreePlan {
  return plan.kind === 'checkout';
}

function isExplicitPlan(plan: WorktreePlan): plan is ExplicitWorktreePlan {
  return plan.kind === 'create-explicit';
}

function toSuccess(plan: WorktreePlan, status: WorktreeSuccess['status']): WorktreeSuccess {
  if (isCheckoutPlan(plan)) {
    return {
      ok: true,
      kind: 'checkout',
      status,
      branch: plan.branch,
      path: plan.path,
      branchRef: plan.branchRef,
    };
  }
  if (isExplicitPlan(plan)) {
    return {
      ok: true,
      kind: 'create-explicit',
      status: 'created',
      branch: plan.branch,
      path: plan.path,
      baseRef: plan.baseRef,
      baseSha: plan.baseSha,
    };
  }

  return {
    ok: true,
    kind: 'create-default',
    status,
    branch: plan.branch,
    path: plan.path,
    baseRef: plan.baseRef,
    ...(plan.warning === undefined ? {} : { warning: plan.warning }),
  };
}

function missingLocalBranch(branch: string): WorktreeFailure {
  return {
    ok: false,
    reason: 'missing-local-branch',
    message: `Local branch does not exist or does not resolve to a commit: refs/heads/${branch}`,
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

function prunableFailure(
  plan: WorktreePlan,
  worktrees: readonly GitWorktreeEntry[],
): WorktreeFailure {
  const entry = worktrees.find(
    (candidate) =>
      candidate.prunable !== null &&
      candidate.prunable !== undefined &&
      (resolve(candidate.path) === plan.path ||
        stripRefsHeads(candidate.branch ?? '') === plan.branch),
  );
  return {
    ok: false,
    reason: 'prunable-worktree',
    message: `A matching Git worktree is marked prunable (${entry?.prunable ?? 'stale metadata'}). Inspect it, then run git worktree repair or git worktree prune manually before retrying. Junction will not clean it automatically. Path: ${plan.path}`,
  };
}

async function reconcileFailedCheckoutAdd(
  plan: CheckoutWorktreePlan,
  result: ProcessResult,
  options: WorktreeOptions,
): Promise<WorktreeApplyResult> {
  const worktrees = await listWorktrees(plan.repository.topLevel, options);
  if (worktrees === null) {
    return unknownWorktreeState(
      plan,
      `Checkout Git worktree add failed (${processError(result)}), and Junction could not relist worktrees.`,
    );
  }

  const state = inspectWorktrees(worktrees, plan.path, plan.branch);
  if (state === 'prunable') {
    return prunableFailure(plan, worktrees);
  }
  if (state === 'exact-reuse') {
    return toSuccess(plan, 'reused');
  }
  if (state === 'path-collision') {
    return collision('path-collision', 'An existing worktree already uses the requested path.');
  }
  if (state === 'branch-collision') {
    return collision('branch-collision', 'An existing worktree already uses the requested branch.');
  }
  if (isUnmanagedPath(plan.path, worktrees)) {
    return collision(
      'path-collision',
      `Target path already exists and is not a Git worktree: ${plan.path}`,
    );
  }

  const branchState = await checkoutBranchState(plan.repository.topLevel, plan.branchRef, options);
  if (branchState === 'missing') {
    return missingLocalBranch(plan.branch);
  }
  if (branchState === 'unknown') {
    return unknownWorktreeState(
      plan,
      `Checkout Git worktree add failed (${processError(result)}), and Junction could not verify the local branch.`,
    );
  }
  if (result.outcome === 'exit' || result.outcome === 'spawn-failed') {
    return {
      ok: false,
      reason: 'git-failed',
      message: `Git worktree add failed: ${processError(result)}`,
    };
  }

  return unknownWorktreeState(
    plan,
    `Checkout Git worktree add did not complete cleanly (${processError(result)}), and its effects could not be reconciled.`,
  );
}

async function reconcileFailedExplicitAdd(
  plan: ExplicitWorktreePlan,
  result: ProcessResult,
  options: WorktreeOptions,
): Promise<WorktreeApplyResult> {
  const worktrees = await listWorktrees(plan.repository.topLevel, options);
  if (worktrees === null) {
    return unknownWorktreeState(
      plan,
      `Explicit Git worktree add failed (${processError(result)}), and Junction could not relist worktrees.`,
    );
  }

  const branchState = await localBranchState(plan.repository.topLevel, plan.branch, options);
  if (
    branchState === 'unknown' ||
    branchState === 'present' ||
    inspectWorktrees(worktrees, plan.path, plan.branch) !== 'available' ||
    existsSync(plan.path)
  ) {
    return unknownWorktreeState(
      plan,
      `Explicit Git worktree add did not leave a provably empty target state (${processError(result)}).`,
    );
  }

  if (result.outcome === 'exit' || result.outcome === 'spawn-failed') {
    return {
      ok: false,
      reason: 'git-failed',
      message: `Git worktree add failed: ${processError(result)}`,
    };
  }

  return unknownWorktreeState(
    plan,
    `Explicit Git worktree add did not complete cleanly (${processError(result)}), and its effects could not be reconciled.`,
  );
}

async function reconcileFailedAdd(
  plan: WorktreePlan,
  result: ProcessResult,
  options: WorktreeOptions,
): Promise<WorktreeApplyResult> {
  const worktrees = await listWorktrees(plan.repository.topLevel, options);
  if (worktrees === null) {
    return unknownWorktreeState(
      plan,
      `Git worktree add failed (${processError(result)}), and Junction could not relist worktrees.`,
    );
  }

  const state = inspectWorktrees(worktrees, plan.path, plan.branch);
  if (state === 'prunable') {
    return prunableFailure(plan, worktrees);
  }
  if (state === 'exact-reuse') {
    // The failed command may have completed before reporting failure. Treat the retained exact
    // worktree as reused because Junction cannot prove this invocation created it.
    return toSuccess(plan, 'reused');
  }
  if (state === 'path-collision') {
    return collision('path-collision', 'An existing worktree already uses the requested path.');
  }
  if (state === 'branch-collision') {
    return collision('branch-collision', 'An existing worktree already uses the requested branch.');
  }
  if (isUnmanagedPath(plan.path, worktrees)) {
    return collision(
      'path-collision',
      `Target path already exists and is not a Git worktree: ${plan.path}`,
    );
  }
  if (result.outcome === 'exit' || result.outcome === 'spawn-failed') {
    return {
      ok: false,
      reason: 'git-failed',
      message: `Git worktree add failed: ${processError(result)}`,
    };
  }

  return unknownWorktreeState(
    plan,
    `Git worktree add did not complete cleanly (${processError(result)}), and its effects could not be reconciled.`,
  );
}

function unknownWorktreeState(plan: WorktreePlan, detail: string): WorktreeFailure {
  return {
    ok: false,
    reason: 'git-add-unknown',
    message: `${detail} Inspect git worktree list and the target path before retrying; Junction did not delete or prune anything. Path: ${plan.path}`,
  };
}
