import { execFile as nodeExecFile } from 'node:child_process';
import { relative } from 'node:path';
import type { GhExec, GitExec, GitResolvedInfo, PrLookupResult } from './types.js';

export interface ResolveGitInfoOptions {
  execGit?: GitExec;
  timeoutMs?: number;
}

export interface ResolvePrUrlOptions {
  execGit?: GitExec;
  execGhCli?: GhExec | null;
  timeoutMs?: number;
}

interface GitCheckoutInfo extends Pick<
  GitResolvedInfo,
  'root' | 'isLinkedWorktree' | 'worktreeLabel'
> {
  repoName: string | null;
}

const DEFAULT_EXEC_TIMEOUT_MS = 5_000;

interface ParsedFetchRemote {
  name: string;
  url: string;
}

interface ParsedRemoteRepo {
  repoName: string;
  qualifiedRepoName: string;
}

async function execCliWithTimeout(
  file: string,
  cwd: string,
  args: string[],
): Promise<{ stdout: string; exitCode: number }> {
  return await new Promise((resolve) => {
    const child = nodeExecFile(
      file,
      args,
      { cwd, encoding: 'utf8', windowsHide: true },
      (error, stdout) => {
        resolve({ stdout, exitCode: error === null ? 0 : 1 });
      },
    );

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, DEFAULT_EXEC_TIMEOUT_MS);
    child.on('close', () => {
      clearTimeout(timer);
    });
  });
}

const defaultExecGit: GitExec = async (cwd, ...args) => await execCliWithTimeout('git', cwd, args);

const defaultExecGhCli: GhExec = async (cwd, args) => await execCliWithTimeout('gh', cwd, args);

export async function resolveGitInfo(
  cwd: string,
  options: ResolveGitInfoOptions = {},
): Promise<GitResolvedInfo> {
  const execGit = options.execGit ?? defaultExecGit;

  const worktree = await gitRevParseShowToplevel(cwd, execGit);
  if (worktree === null) {
    return {
      worktree: null,
      branch: null,
      remote: null,
      root: null,
      repoName: null,
      qualifiedRepoName: null,
      isLinkedWorktree: null,
      worktreeLabel: null,
    };
  }

  const [branch, remote, remotes, checkoutInfo] = await Promise.all([
    gitRevParseAbbrevRefHead(worktree, execGit),
    gitRemoteGetUrl(worktree, execGit),
    gitRemoteVerbose(worktree, execGit),
    resolveGitCheckoutInfo(worktree, execGit),
  ]);

  const remoteRepo = resolveRemoteRepoIdentity(remote, remotes);
  const repoName = remoteRepo?.repoName ?? checkoutInfo.repoName ?? getPathBasename(worktree);

  return {
    worktree,
    branch,
    remote,
    root: checkoutInfo.root,
    repoName,
    qualifiedRepoName: remoteRepo?.qualifiedRepoName ?? null,
    isLinkedWorktree: checkoutInfo.isLinkedWorktree,
    worktreeLabel: checkoutInfo.worktreeLabel,
  };
}

export async function resolvePrUrl(
  worktree: string,
  branch: string | null,
  options: ResolvePrUrlOptions = {},
): Promise<PrLookupResult> {
  if (branch === null) {
    return { prUrl: null, strategy: 'none', diagnostic: 'detached_head' };
  }

  // Try gh CLI first. Passing execGhCli: null explicitly disables this path.
  const execGhCli = options.execGhCli === null ? null : (options.execGhCli ?? defaultExecGhCli);
  if (execGhCli !== null) {
    try {
      const { stdout, exitCode } = await execGhCli(worktree, [
        'pr',
        'view',
        branch,
        '--json',
        'url',
        '--jq',
        '.url',
      ]);
      if (exitCode === 0 && stdout.trim().length > 0) {
        const url = stdout.trim();
        if (url.startsWith('https://github.com/')) {
          return { prUrl: url, strategy: 'gh_cli' };
        }
      }
    } catch {
      // Fall through to git remote construction
    }
  }

  // Fallback: try to construct PR URL from git remote origin + branch
  // Using gh CLI to query the remote by 'headRefName' is the only reliable way to
  // get an exact PR URL from a branch name. Without gh CLI, we report pr_ambiguous.
  const execGit = options.execGit ?? defaultExecGit;
  try {
    const { stdout, exitCode } = await execGit(worktree, 'remote', 'get-url', 'origin');
    if (exitCode !== 0 || stdout.trim().length === 0) {
      return { prUrl: null, strategy: 'git_remote_failed', diagnostic: 'pr_lookup_failed' };
    }

    const originUrl = stdout.trim();
    const ghMatch = originUrl.match(/github\.com([:/])([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (!ghMatch) {
      return { prUrl: null, strategy: 'non_github_remote', diagnostic: 'pr_lookup_failed' };
    }

    // We cannot construct an exact PR URL from branch alone.
    // Return null with pr_ambiguous to signal this limitation.
    return { prUrl: null, strategy: 'gh_cli_unavailable', diagnostic: 'pr_ambiguous' };
  } catch {
    return { prUrl: null, strategy: 'failed', diagnostic: 'pr_lookup_failed' };
  }
}

// ─── Internal helpers ───────────────────────────────────────────────

async function gitRevParseShowToplevel(cwd: string, execGit: GitExec): Promise<string | null> {
  try {
    const { stdout, exitCode } = await execGit(cwd, 'rev-parse', '--show-toplevel');
    if (exitCode !== 0) {
      return null;
    }
    const line = stdout.trim();
    return line.length > 0 ? line : null;
  } catch {
    return null;
  }
}

async function gitRevParseAbbrevRefHead(
  worktree: string,
  execGit: GitExec,
): Promise<string | null> {
  try {
    const { stdout, exitCode } = await execGit(worktree, 'rev-parse', '--abbrev-ref', 'HEAD');
    if (exitCode !== 0) {
      return null;
    }
    const line = stdout.trim();
    if (line.length === 0 || line === 'HEAD') {
      return null; // detached HEAD
    }
    return line;
  } catch {
    return null;
  }
}

async function gitRemoteGetUrl(
  worktree: string,
  execGit: GitExec,
  remoteName = 'origin',
): Promise<string | null> {
  try {
    const { stdout, exitCode } = await execGit(worktree, 'remote', 'get-url', remoteName);
    if (exitCode !== 0) {
      return null;
    }
    const line = stdout.trim();
    return line.length > 0 ? line : null;
  } catch {
    return null;
  }
}

async function gitRemoteVerbose(worktree: string, execGit: GitExec): Promise<string | null> {
  try {
    const { stdout, exitCode } = await execGit(worktree, 'remote', '-v');
    if (exitCode !== 0) {
      return null;
    }
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function resolveRemoteRepoIdentity(
  originRemote: string | null,
  remoteList: string | null,
): ParsedRemoteRepo | null {
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

function parseRemoteRepo(remoteUrl: string | null): ParsedRemoteRepo | null {
  if (remoteUrl === null) {
    return null;
  }

  const qualifiedRepoName = extractQualifiedRepoName(remoteUrl.trim());
  if (qualifiedRepoName === null) {
    return null;
  }

  const separatorIndex = qualifiedRepoName.lastIndexOf('/');
  const repoName = separatorIndex === -1 ? null : qualifiedRepoName.slice(separatorIndex + 1);
  if (repoName === null || repoName.length === 0) {
    return null;
  }

  return { repoName, qualifiedRepoName };
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
  if (scpLikePath !== null) {
    return extractQualifiedRepoNameFromPath(scpLikePath);
  }

  return null;
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

function deriveRepoNameFromCommonGitDir(commonGitDir: string | null): string | null {
  if (commonGitDir === null) {
    return null;
  }

  const segments = splitPathSegments(commonGitDir);
  if (segments.length === 0) {
    return null;
  }

  const lastSegment = segments[segments.length - 1] ?? null;
  if (lastSegment === null) {
    return null;
  }

  if (lastSegment === '.git') {
    return segments[segments.length - 2] ?? null;
  }

  const repoName = stripGitSuffix(lastSegment);
  return repoName.length > 0 ? repoName : null;
}

function getPathBasename(pathValue: string | null): string | null {
  if (pathValue === null) {
    return null;
  }

  const segments = splitPathSegments(pathValue);
  return segments[segments.length - 1] ?? null;
}

function stripGitSuffix(value: string): string {
  return value.endsWith('.git') ? value.slice(0, -4) : value;
}

function splitPathSegments(pathValue: string): string[] {
  return pathValue
    .replace(/[\\/]+$/, '')
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0 && segment !== '.');
}

async function resolveGitCheckoutInfo(
  worktree: string,
  execGit: GitExec,
): Promise<GitCheckoutInfo> {
  const absoluteGitDir = await gitRevParseAbsoluteGitDir(worktree, execGit);
  if (absoluteGitDir === null) {
    return { root: null, repoName: null, isLinkedWorktree: null, worktreeLabel: null };
  }

  const commonGitDir = await gitRevParseAbsoluteCommonGitDir(worktree, execGit);
  if (commonGitDir !== null) {
    const linkedWorktree = deriveLinkedWorktreeInfo(absoluteGitDir, commonGitDir);
    return {
      root: absoluteGitDir,
      repoName: deriveRepoNameFromCommonGitDir(commonGitDir),
      isLinkedWorktree: linkedWorktree.isLinkedWorktree,
      worktreeLabel: linkedWorktree.worktreeLabel,
    };
  }

  const linkedWorktreeFallback = deriveLinkedWorktreeFallbackFromAbsoluteGitDir(absoluteGitDir);
  if (linkedWorktreeFallback !== null) {
    return {
      root: absoluteGitDir,
      repoName: linkedWorktreeFallback.repoName,
      isLinkedWorktree: linkedWorktreeFallback.isLinkedWorktree,
      worktreeLabel: linkedWorktreeFallback.worktreeLabel,
    };
  }

  return {
    root: absoluteGitDir,
    repoName: null,
    isLinkedWorktree: null,
    worktreeLabel: null,
  };
}

async function gitRevParseAbsoluteGitDir(
  worktree: string,
  execGit: GitExec,
): Promise<string | null> {
  try {
    const { stdout, exitCode } = await execGit(worktree, 'rev-parse', '--absolute-git-dir');
    if (exitCode !== 0) {
      return null;
    }
    const line = stdout.trim();
    return line.length > 0 ? line : null;
  } catch {
    return null;
  }
}

async function gitRevParseAbsoluteCommonGitDir(
  worktree: string,
  execGit: GitExec,
): Promise<string | null> {
  try {
    const { stdout, exitCode } = await execGit(
      worktree,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    );
    if (exitCode !== 0) {
      return null;
    }
    const line = stdout.trim();
    return line.length > 0 ? line : null;
  } catch {
    return null;
  }
}

function deriveLinkedWorktreeInfo(
  absoluteGitDir: string,
  commonGitDir: string,
): Pick<GitResolvedInfo, 'isLinkedWorktree' | 'worktreeLabel'> {
  const segments = relative(commonGitDir, absoluteGitDir)
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0);

  if (segments[0] !== 'worktrees') {
    return { isLinkedWorktree: false, worktreeLabel: null };
  }

  return {
    isLinkedWorktree: true,
    worktreeLabel: segments[1] ?? null,
  };
}

function deriveLinkedWorktreeFallbackFromAbsoluteGitDir(
  absoluteGitDir: string,
):
  | (Pick<GitResolvedInfo, 'isLinkedWorktree' | 'worktreeLabel'> & { repoName: string | null })
  | null {
  const match = absoluteGitDir.match(/^(.*[\\/]\.git)[\\/]worktrees[\\/]([^\\/]+)$/);
  const commonGitDir = match?.[1] ?? null;
  const worktreeLabel = match?.[2] ?? null;
  if (commonGitDir === null || commonGitDir.length === 0 || worktreeLabel === null) {
    return null;
  }

  return {
    repoName: deriveRepoNameFromCommonGitDir(commonGitDir),
    isLinkedWorktree: true,
    worktreeLabel,
  };
}
