import { execFile as nodeExecFile } from 'node:child_process';
import type { GitExec, GitResolvedInfo, PrLookupResult } from './types.js';

export interface ResolveGitInfoOptions {
  execGit?: GitExec;
  timeoutMs?: number;
}

export interface ResolvePrUrlOptions {
  execGit?: GitExec;
  execGhCli?: (args: string[]) => Promise<{ stdout: string; exitCode: number }>;
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

const defaultExecGhCli = async (args: string[]): Promise<{ stdout: string; exitCode: number }> => {
  const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>(
    (resolve) => {
      const child = nodeExecFile(
        'gh',
        args,
        { encoding: 'utf8', windowsHide: true },
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
    return { worktree: null, branch: null, remote: null, root: null };
  }

  const [branch, remote, root] = await Promise.all([
    gitRevParseAbbrevRefHead(worktree, execGit),
    gitRemoteGetUrl(worktree, execGit),
    gitRevParseGitDir(worktree, execGit),
  ]);

  return { worktree, branch, remote, root };
}

export async function resolvePrUrl(
  worktree: string,
  branch: string | null,
  options: ResolvePrUrlOptions = {},
): Promise<PrLookupResult> {
  if (branch === null) {
    return { prUrl: null, strategy: 'none', diagnostic: 'detached_head' };
  }

  // Try gh CLI first
  if (options.execGhCli !== undefined) {
    const execGhCli = options.execGhCli ?? defaultExecGhCli;
    try {
      const { stdout, exitCode } = await execGhCli([
        'pr',
        'view',
        '--json',
        'url',
        '--jq',
        '.url',
        '--repo',
        worktree,
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

async function gitRevParseGitDir(worktree: string, execGit: GitExec): Promise<string | null> {
  try {
    const { stdout, exitCode } = await execGit(worktree, 'rev-parse', '--git-dir');
    if (exitCode !== 0) {
      return null;
    }
    const line = stdout.trim();
    return line.length > 0 ? line : null;
  } catch {
    return null;
  }
}
