import { runNormalizedExecCommand } from './internal.js';

export type MergeReadyExecOptions = {
  cwd?: string;
  timeout?: number;
};

export type MergeReadyExecResult = {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  code?: number;
};

export type MergeReadyExec = (
  command: string,
  args: string[],
  options?: MergeReadyExecOptions,
) => Promise<MergeReadyExecResult>;

export type MergeReadyGitCommandIssue = {
  command: string;
  args: string[];
  cwd?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  reason: 'non_zero_exit' | 'invalid_output' | 'threw';
  message: string;
};

export type MergeReadyCwdFact =
  | { kind: 'known'; path: string }
  | { kind: 'unknown'; reason: 'command_failed' };

export type MergeReadyGitRepositoryFact =
  | { kind: 'git'; root: string }
  | { kind: 'not_git_repo' }
  | { kind: 'unknown'; reason: 'command_failed' };

export type MergeReadyGitBranchFact =
  | { kind: 'known'; name: string }
  | { kind: 'detached' }
  | { kind: 'unknown'; reason: 'not_git_repo' | 'command_failed' };

export type MergeReadyGitRemoteFact =
  | { kind: 'github'; name: string; url: string; owner: string; repo: string }
  | { kind: 'non_github'; name: string; url: string }
  | { kind: 'missing' }
  | { kind: 'unknown'; reason: 'not_git_repo' | 'command_failed' };

export type MergeReadyGitBaseBranchFact =
  | { kind: 'known'; name: string; remoteName: string }
  | {
      kind: 'unknown';
      reason: 'not_git_repo' | 'missing_remote' | 'missing_remote_head' | 'command_failed';
    };

export type MergeReadyGitUpstreamFact =
  | { kind: 'known'; ref: string; remoteName?: string; branchName: string }
  | { kind: 'missing' }
  | { kind: 'unknown'; reason: 'not_git_repo' | 'command_failed' };

export type MergeReadyGitAheadBehindFact =
  | { kind: 'known'; ahead: number; behind: number }
  | { kind: 'unknown'; reason: 'not_git_repo' | 'missing_upstream' | 'command_failed' };

export type MergeReadyGitDirtyFact =
  | { kind: 'known'; dirty: boolean }
  | { kind: 'unknown'; reason: 'not_git_repo' | 'command_failed' };

export type MergeReadyGitLocalFacts = {
  cwd: MergeReadyCwdFact;
  repository: MergeReadyGitRepositoryFact;
  branch: MergeReadyGitBranchFact;
  remote: MergeReadyGitRemoteFact;
  baseBranch: MergeReadyGitBaseBranchFact;
  upstream: MergeReadyGitUpstreamFact;
  aheadBehind: MergeReadyGitAheadBehindFact;
  dirty: MergeReadyGitDirtyFact;
  issues: MergeReadyGitCommandIssue[];
};

export type GetMergeReadyGitFactsOptions = {
  exec: MergeReadyExec;
  cwd?: string;
  timeout?: number;
};

type ParsedGitHubRemote = {
  owner: string;
  repo: string;
};

const NOT_GIT_REPOSITORY_RE = /not a git repository/i;
const NO_UPSTREAM_RE = /no upstream configured|no upstream branch|does not point to a branch/i;
const MISSING_REMOTE_HEAD_RE = /not a symbolic ref|ref .*\/HEAD is not a symbolic ref/i;
const GITHUB_REMOTE_PATTERNS = [
  /^(?:(?:ssh:\/\/)?git@github\.com[:/]|ssh:\/\/github\.com\/|git:\/\/github\.com\/|https?:\/\/github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
];

export async function discoverMergeReadyGitFacts(
  options: GetMergeReadyGitFactsOptions,
): Promise<MergeReadyGitLocalFacts> {
  const issues: MergeReadyGitCommandIssue[] = [];
  const cwd = await resolveCwd(options, issues);
  const commandCwd = cwd.kind === 'known' ? cwd.path : options.cwd;
  const repositoryResult = await runCommand(
    options.exec,
    'git',
    ['rev-parse', '--show-toplevel'],
    commandCwd,
    options.timeout,
    issues,
  );

  if (!repositoryResult.ok) {
    if (looksLikeNotGitRepository(repositoryResult.stderr)) {
      return {
        cwd,
        repository: { kind: 'not_git_repo' },
        ...createUnavailableGitFacts('not_git_repo'),
        issues,
      };
    }

    return {
      cwd,
      repository: { kind: 'unknown', reason: 'command_failed' },
      ...createUnavailableGitFacts('command_failed'),
      issues,
    };
  }

  const repositoryRoot = repositoryResult.stdout.trim();
  if (!repositoryRoot) {
    issues.push(
      createIssue({
        command: 'git',
        args: ['rev-parse', '--show-toplevel'],
        cwd: commandCwd,
        exitCode: repositoryResult.exitCode,
        stdout: repositoryResult.stdout,
        stderr: repositoryResult.stderr,
        reason: 'invalid_output',
        message: 'git rev-parse --show-toplevel returned empty stdout',
      }),
    );

    return {
      cwd,
      repository: { kind: 'unknown', reason: 'command_failed' },
      ...createUnavailableGitFacts('command_failed'),
      issues,
    };
  }

  const gitCwd = repositoryRoot;
  const branch = await resolveCurrentBranch(options.exec, gitCwd, options.timeout, issues);
  const { remote, remoteName } = await resolveRemote(options.exec, gitCwd, options.timeout, issues);
  const baseBranch = await resolveBaseBranch(
    options.exec,
    gitCwd,
    remoteName,
    options.timeout,
    issues,
  );
  const upstream = await resolveUpstream(options.exec, gitCwd, options.timeout, issues);
  const aheadBehind = await resolveAheadBehind(
    options.exec,
    gitCwd,
    upstream,
    options.timeout,
    issues,
  );
  const dirty = await resolveDirtyWorkingTree(options.exec, gitCwd, options.timeout, issues);

  return {
    cwd,
    repository: { kind: 'git', root: repositoryRoot },
    branch,
    remote,
    baseBranch,
    upstream,
    aheadBehind,
    dirty,
    issues,
  };
}

export function parseGitHubRemoteUrl(url: string): ParsedGitHubRemote | null {
  const normalizedUrl = url.trim();

  for (const pattern of GITHUB_REMOTE_PATTERNS) {
    const match = normalizedUrl.match(pattern);
    if (!match) {
      continue;
    }

    const owner = match[1]?.trim();
    const repo = match[2]?.trim();
    if (owner && repo) {
      return { owner, repo };
    }
  }

  return null;
}

async function resolveCwd(
  options: GetMergeReadyGitFactsOptions,
  issues: MergeReadyGitCommandIssue[],
): Promise<MergeReadyCwdFact> {
  if (options.cwd) {
    return { kind: 'known', path: options.cwd };
  }

  const result = await runCommand(options.exec, 'pwd', [], undefined, options.timeout, issues);
  if (!result.ok) {
    return { kind: 'unknown', reason: 'command_failed' };
  }

  const path = result.stdout.trim();
  if (!path) {
    issues.push(
      createIssue({
        command: 'pwd',
        args: [],
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        reason: 'invalid_output',
        message: 'pwd returned empty stdout',
      }),
    );
    return { kind: 'unknown', reason: 'command_failed' };
  }

  return { kind: 'known', path };
}

async function resolveCurrentBranch(
  exec: MergeReadyExec,
  cwd: string,
  timeout: number | undefined,
  issues: MergeReadyGitCommandIssue[],
): Promise<MergeReadyGitBranchFact> {
  const result = await runCommand(exec, 'git', ['branch', '--show-current'], cwd, timeout, issues);
  if (!result.ok) {
    return { kind: 'unknown', reason: 'command_failed' };
  }

  const name = result.stdout.trim();
  return name ? { kind: 'known', name } : { kind: 'detached' };
}

async function resolveRemote(
  exec: MergeReadyExec,
  cwd: string,
  timeout: number | undefined,
  issues: MergeReadyGitCommandIssue[],
): Promise<{ remote: MergeReadyGitRemoteFact; remoteName?: string }> {
  const remotesResult = await runCommand(exec, 'git', ['remote'], cwd, timeout, issues);
  if (!remotesResult.ok) {
    return { remote: { kind: 'unknown', reason: 'command_failed' } };
  }

  const remoteNames = splitOutputLines(remotesResult.stdout);
  if (remoteNames.length === 0) {
    return { remote: { kind: 'missing' } };
  }

  const remoteName = selectRemoteName(remoteNames);
  const urlResult = await runCommand(
    exec,
    'git',
    ['remote', 'get-url', remoteName],
    cwd,
    timeout,
    issues,
  );
  if (!urlResult.ok) {
    return { remote: { kind: 'unknown', reason: 'command_failed' } };
  }

  const url = urlResult.stdout.trim();
  if (!url) {
    issues.push(
      createIssue({
        command: 'git',
        args: ['remote', 'get-url', remoteName],
        cwd,
        exitCode: urlResult.exitCode,
        stdout: urlResult.stdout,
        stderr: urlResult.stderr,
        reason: 'invalid_output',
        message: `git remote get-url ${remoteName} returned empty stdout`,
      }),
    );
    return { remote: { kind: 'unknown', reason: 'command_failed' } };
  }

  const githubRemote = parseGitHubRemoteUrl(url);
  if (githubRemote) {
    return {
      remote: {
        kind: 'github',
        name: remoteName,
        url,
        owner: githubRemote.owner,
        repo: githubRemote.repo,
      },
      remoteName,
    };
  }

  return {
    remote: { kind: 'non_github', name: remoteName, url },
    remoteName,
  };
}

async function resolveBaseBranch(
  exec: MergeReadyExec,
  cwd: string,
  remoteName: string | undefined,
  timeout: number | undefined,
  issues: MergeReadyGitCommandIssue[],
): Promise<MergeReadyGitBaseBranchFact> {
  if (!remoteName) {
    return { kind: 'unknown', reason: 'missing_remote' };
  }

  const args = ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remoteName}/HEAD`];
  const result = await runCommand(exec, 'git', args, cwd, timeout, issues);
  if (!result.ok) {
    if (looksLikeMissingRemoteHead(result.stderr)) {
      return { kind: 'unknown', reason: 'missing_remote_head' };
    }

    return { kind: 'unknown', reason: 'command_failed' };
  }

  const ref = result.stdout.trim();
  const parsedRef = parseRemoteBranchRef(ref);
  if (!parsedRef || parsedRef.branchName.length === 0) {
    issues.push(
      createIssue({
        command: 'git',
        args,
        cwd,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        reason: 'invalid_output',
        message: `git ${args.join(' ')} returned an unparseable ref`,
      }),
    );
    return { kind: 'unknown', reason: 'missing_remote_head' };
  }

  return { kind: 'known', name: parsedRef.branchName, remoteName };
}

async function resolveUpstream(
  exec: MergeReadyExec,
  cwd: string,
  timeout: number | undefined,
  issues: MergeReadyGitCommandIssue[],
): Promise<MergeReadyGitUpstreamFact> {
  const args = ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'];
  const result = await runCommand(exec, 'git', args, cwd, timeout, issues);
  if (!result.ok) {
    if (looksLikeMissingUpstream(result.stderr)) {
      return { kind: 'missing' };
    }

    return { kind: 'unknown', reason: 'command_failed' };
  }

  const ref = result.stdout.trim();
  if (!ref) {
    issues.push(
      createIssue({
        command: 'git',
        args,
        cwd,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        reason: 'invalid_output',
        message: 'git rev-parse @{upstream} returned empty stdout',
      }),
    );
    return { kind: 'unknown', reason: 'command_failed' };
  }

  const parsedRef = parseRemoteBranchRef(ref);
  if (!parsedRef || parsedRef.branchName.length === 0) {
    issues.push(
      createIssue({
        command: 'git',
        args,
        cwd,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        reason: 'invalid_output',
        message: 'git rev-parse @{upstream} returned an unparseable ref',
      }),
    );
    return { kind: 'unknown', reason: 'command_failed' };
  }

  return parsedRef.remoteName
    ? { kind: 'known', ref, remoteName: parsedRef.remoteName, branchName: parsedRef.branchName }
    : { kind: 'known', ref, branchName: parsedRef.branchName };
}

async function resolveAheadBehind(
  exec: MergeReadyExec,
  cwd: string,
  upstream: MergeReadyGitUpstreamFact,
  timeout: number | undefined,
  issues: MergeReadyGitCommandIssue[],
): Promise<MergeReadyGitAheadBehindFact> {
  if (upstream.kind !== 'known') {
    return upstream.kind === 'missing'
      ? { kind: 'unknown', reason: 'missing_upstream' }
      : { kind: 'unknown', reason: 'command_failed' };
  }

  const args = ['rev-list', '--left-right', '--count', `${upstream.ref}...HEAD`];
  const result = await runCommand(exec, 'git', args, cwd, timeout, issues);
  if (!result.ok) {
    return { kind: 'unknown', reason: 'command_failed' };
  }

  const parsedCounts = parseAheadBehindCounts(result.stdout);
  if (!parsedCounts) {
    issues.push(
      createIssue({
        command: 'git',
        args,
        cwd,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        reason: 'invalid_output',
        message: 'git rev-list --left-right --count returned unparseable counts',
      }),
    );
    return { kind: 'unknown', reason: 'command_failed' };
  }

  return parsedCounts;
}

async function resolveDirtyWorkingTree(
  exec: MergeReadyExec,
  cwd: string,
  timeout: number | undefined,
  issues: MergeReadyGitCommandIssue[],
): Promise<MergeReadyGitDirtyFact> {
  const args = ['status', '--porcelain', '--untracked-files=normal'];
  const result = await runCommand(exec, 'git', args, cwd, timeout, issues);
  if (!result.ok) {
    return { kind: 'unknown', reason: 'command_failed' };
  }

  return { kind: 'known', dirty: result.stdout.trim().length > 0 };
}

async function runCommand(
  exec: MergeReadyExec,
  command: string,
  args: string[],
  cwd: string | undefined,
  timeout: number | undefined,
  issues: MergeReadyGitCommandIssue[],
) {
  const result = await runNormalizedExecCommand(exec, command, args, cwd, timeout);
  if (result.ok) {
    return result;
  }

  issues.push(
    createIssue({
      command,
      args,
      cwd,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      reason: result.reason,
      message:
        result.reason === 'threw'
          ? `${command} ${args.join(' ')} threw: ${result.thrownMessage ?? result.stderr}`
          : `${command} ${args.join(' ')} exited with code ${result.exitCode}`,
    }),
  );

  return result;
}

function createUnavailableGitFacts(reason: 'not_git_repo' | 'command_failed') {
  return {
    branch: { kind: 'unknown', reason } as const,
    remote: { kind: 'unknown', reason } as const,
    baseBranch: { kind: 'unknown', reason } as const,
    upstream: { kind: 'unknown', reason } as const,
    aheadBehind: { kind: 'unknown', reason } as const,
    dirty: { kind: 'unknown', reason } as const,
  };
}

function createIssue(options: {
  command: string;
  args: string[];
  cwd?: string | undefined;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  reason: MergeReadyGitCommandIssue['reason'];
  message: string;
}): MergeReadyGitCommandIssue {
  const issue: MergeReadyGitCommandIssue = {
    command: options.command,
    args: options.args,
    exitCode: options.exitCode,
    stdout: options.stdout,
    stderr: options.stderr,
    reason: options.reason,
    message: options.message,
  };

  if (options.cwd !== undefined) {
    issue.cwd = options.cwd;
  }

  return issue;
}

function selectRemoteName(remoteNames: string[]): string {
  return remoteNames.includes('origin') ? 'origin' : (remoteNames[0] ?? 'origin');
}

function splitOutputLines(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseRemoteBranchRef(ref: string): { remoteName?: string; branchName: string } | null {
  const normalizedRef = ref.trim();
  if (!normalizedRef) {
    return null;
  }

  const slashIndex = normalizedRef.indexOf('/');
  if (slashIndex === -1) {
    return { branchName: normalizedRef };
  }

  const remoteName = normalizedRef.slice(0, slashIndex).trim();
  const branchName = normalizedRef.slice(slashIndex + 1).trim();
  if (!remoteName || !branchName) {
    return null;
  }

  return { remoteName, branchName };
}

function parseAheadBehindCounts(output: string): MergeReadyGitAheadBehindFact | null {
  const matches = output.trim().match(/^(\d+)\s+(\d+)$/u);
  if (!matches) {
    return null;
  }

  const [, behindRaw, aheadRaw] = matches;
  if (!behindRaw || !aheadRaw) {
    return null;
  }

  const behind = Number.parseInt(behindRaw, 10);
  const ahead = Number.parseInt(aheadRaw, 10);
  if (Number.isNaN(behind) || Number.isNaN(ahead)) {
    return null;
  }

  return { kind: 'known', ahead, behind };
}

function looksLikeNotGitRepository(stderr: string): boolean {
  return NOT_GIT_REPOSITORY_RE.test(stderr);
}

function looksLikeMissingUpstream(stderr: string): boolean {
  return NO_UPSTREAM_RE.test(stderr);
}

function looksLikeMissingRemoteHead(stderr: string): boolean {
  return MISSING_REMOTE_HEAD_RE.test(stderr);
}
