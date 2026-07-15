import { execFile as nodeExecFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { formatPosixCommand } from '../identity/terminal-focus.js';

export interface ExecFileResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type WorktreeExecFile = (
  file: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number },
) => Promise<ExecFileResult>;

export interface GitCommandOptions {
  execFile?: WorktreeExecFile;
  timeoutMs?: number;
}

export interface GitWorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export const defaultWorktreeExecFile: WorktreeExecFile = async (file, args, options) =>
  await new Promise((resolvePromise) => {
    const child = nodeExecFile(
      file,
      [...args],
      {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        encoding: 'utf8',
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const exitCode = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolvePromise({ stdout, stderr, exitCode });
      },
    );
    child.stdin?.end();
  });

export async function execGit(
  cwd: string,
  args: readonly string[],
  options: GitCommandOptions = {},
): Promise<ExecFileResult> {
  return await (options.execFile ?? defaultWorktreeExecFile)('git', args, {
    cwd,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
}

export async function gitText(
  cwd: string,
  args: readonly string[],
  options: GitCommandOptions = {},
): Promise<string | null> {
  const result = await execGit(cwd, args, options);
  if (result.exitCode !== 0) {
    return null;
  }

  const trimmed = result.stdout.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export async function resolveGitTopLevel(
  cwd: string,
  options: GitCommandOptions = {},
): Promise<string | null> {
  return await gitText(cwd, ['rev-parse', '--show-toplevel'], options);
}

export async function resolveGitCommonDir(
  cwd: string,
  options: GitCommandOptions = {},
): Promise<string | null> {
  const commonDir = await gitText(
    cwd,
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    options,
  );
  return commonDir === null ? null : resolve(commonDir);
}

export async function validateBranchName(
  cwd: string,
  branchName: string,
  options: GitCommandOptions = {},
): Promise<boolean> {
  const result = await execGit(cwd, ['check-ref-format', '--branch', branchName], options);
  return result.exitCode === 0;
}

export async function resolveCommitRef(
  cwd: string,
  ref: string,
  options: GitCommandOptions = {},
): Promise<string | null> {
  return await gitText(cwd, ['rev-parse', '--verify', `${ref}^{commit}`], options);
}

export async function verifyCommitRef(
  cwd: string,
  ref: string,
  options: GitCommandOptions = {},
): Promise<boolean> {
  return (await resolveCommitRef(cwd, ref, options)) !== null;
}

export async function resolveDefaultBaseRef(
  cwd: string,
  options: GitCommandOptions = {},
): Promise<{ baseRef: string; warning?: string }> {
  const remoteDefault = await gitText(
    cwd,
    ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    options,
  );
  if (remoteDefault !== null && (await verifyCommitRef(cwd, remoteDefault, options))) {
    return { baseRef: remoteDefault };
  }

  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    if (await verifyCommitRef(cwd, candidate, options)) {
      return { baseRef: candidate };
    }
  }

  return {
    baseRef: 'HEAD',
    warning: 'Could not resolve a remote/default base branch; using local HEAD.',
  };
}

export async function listGitWorktrees(
  cwd: string,
  options: GitCommandOptions = {},
): Promise<GitWorktreeEntry[] | null> {
  const result = await execGit(cwd, ['worktree', 'list', '--porcelain', '-z'], options);
  if (result.exitCode !== 0) {
    return null;
  }

  return parseGitWorktreeList(result.stdout);
}

export function parseGitWorktreeList(source: string): GitWorktreeEntry[] {
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

    const separatorIndex = token.indexOf(' ');
    const key = separatorIndex === -1 ? token : token.slice(0, separatorIndex);
    const value = separatorIndex === -1 ? '' : token.slice(separatorIndex + 1);

    if (key === 'worktree') {
      if (current !== null) {
        entries.push(current);
      }
      current = { path: value, head: null, branch: null };
      continue;
    }

    if (current === null) {
      continue;
    }

    if (key === 'HEAD') {
      current.head = value;
    } else if (key === 'branch') {
      current.branch = value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : value;
    }
  }

  if (current !== null) {
    entries.push(current);
  }

  return entries;
}

export function defaultWorktreePath(
  primaryWorktreePath: string,
  repoName: string | null,
  slug: string,
): string {
  const parent = dirname(primaryWorktreePath);
  const safeRepoName = sanitizePathSegment(
    repoName ?? primaryWorktreePath.split('/').filter(Boolean).at(-1) ?? 'repo',
  );
  return join(parent, `${safeRepoName}-wt-${slug}`);
}

export function normalizeRequestedPath(path: string, primaryWorktreePath: string): string {
  const trimmed = path.trim();
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(dirname(primaryWorktreePath), trimmed);
}

export function isPathCollision(path: string, worktrees: readonly GitWorktreeEntry[]): boolean {
  return existsSync(path) && !worktrees.some((entry) => resolve(entry.path) === resolve(path));
}

export function stripRefsHeads(branch: string): string {
  return branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch;
}

export function formatGitWorktreeManualCommand(
  path: string,
  branch: string,
  baseRef: string,
): string {
  return formatPosixCommand(['git', 'worktree', 'add', '-b', branch, path, baseRef]);
}

function sanitizePathSegment(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 64);
  return sanitized.length === 0 ? 'repo' : sanitized;
}
