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

const defaultExecGit: GitExec = async (cwd, ...args) => {
  const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>(
    (resolve) => {
      const child = nodeExecFile(
        'git',
        args,
        { cwd, encoding: 'utf8', windowsHide: true },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ stdout, stderr, exitCode: 0 });
            return;
          }

          resolve({ stdout, stderr, exitCode: 1 });
        },
      );

      const timeout = 5_000;
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
      }, timeout);
      child.on('close', () => {
        clearTimeout(timer);
      });
    },
  );

  return { stdout: result.stdout, exitCode: result.exitCode };
};

const defaultExecGhCli: GhExec = async (
  cwd,
  args,
): Promise<{ stdout: string; exitCode: number }> => {
  const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>(
    (resolve) => {
      const child = nodeExecFile(
        'gh',
        args,
        { cwd, encoding: 'utf8', windowsHide: true },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ stdout, stderr, exitCode: 0 });
            return;
          }

          resolve({ stdout, stderr, exitCode: 1 });
        },
      );

      const timeout = 5_000;
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
      }, timeout);
      child.on('close', () => {
        clearTimeout(timer);
      });
    },
  );

  return { stdout: result.stdout, exitCode: result.exitCode };
};

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
      isLinkedWorktree: null,
      worktreeLabel: null,
    };
  }

  const [branch, remote, checkoutInfo] = await Promise.all([
    gitRevParseAbbrevRefHead(worktree, execGit),
    gitRemoteGetUrl(worktree, execGit),
    resolveGitCheckoutInfo(worktree, execGit),
  ]);

  return {
    worktree,
    branch,
    remote,
    root: checkoutInfo.root,
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

async function gitRemoteGetUrl(worktree: string, execGit: GitExec): Promise<string | null> {
  try {
    const { stdout, exitCode } = await execGit(worktree, 'remote', 'get-url', 'origin');
    if (exitCode !== 0) {
      return null;
    }
    const line = stdout.trim();
    return line.length > 0 ? line : null;
  } catch {
    return null;
  }
}

async function resolveGitCheckoutInfo(
  worktree: string,
  execGit: GitExec,
): Promise<Pick<GitResolvedInfo, 'root' | 'isLinkedWorktree' | 'worktreeLabel'>> {
  const absoluteGitDir = await gitRevParseAbsoluteGitDir(worktree, execGit);
  if (absoluteGitDir === null) {
    return { root: null, isLinkedWorktree: null, worktreeLabel: null };
  }

  const commonGitDir = await gitRevParseAbsoluteCommonGitDir(worktree, execGit);
  if (commonGitDir === null) {
    return {
      root: absoluteGitDir,
      isLinkedWorktree: null,
      worktreeLabel: null,
    };
  }

  const linkedWorktree = deriveLinkedWorktreeInfo(absoluteGitDir, commonGitDir);
  return {
    root: absoluteGitDir,
    isLinkedWorktree: linkedWorktree.isLinkedWorktree,
    worktreeLabel: linkedWorktree.worktreeLabel,
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
