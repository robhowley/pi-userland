import { expect } from 'vitest';
import type {
  MergeReadyExec,
  MergeReadyExecResult,
  MergeReadyUrlTarget,
} from '../../extensions/merge-ready/index.js';

export type ExpectedExecCall = {
  command: string;
  args: string[];
  cwd?: string | undefined;
  timeout?: number | undefined;
  result?: (MergeReadyExecResult & { killed?: boolean }) | undefined;
  error?: unknown | undefined;
  requiredChecks?: unknown[] | undefined;
};

export const GH_PR_VIEW_JSON_FIELDS =
  'number,title,url,state,isDraft,mergeable,mergeStateStatus,headRefName,headRepository,headRepositoryOwner,baseRefName,statusCheckRollup,reviews,reviewDecision,reviewRequests,author';

export const GH_GRAPHQL_REVIEW_THREADS_QUERY = [
  'query MergeReadyReviewThreads($owner: String!, $name: String!, $number: Int!) {',
  'repository(owner: $owner, name: $name) {',
  'pullRequest(number: $number) {',
  'latestOpinionatedReviews(first: 100) {',
  'nodes { author { login } state submittedAt url }',
  '}',
  'reviewThreads(first: 100) {',
  'nodes {',
  'isResolved',
  'path',
  'line',
  'comments(first: 1) { nodes { url path line } }',
  '}',
  'pageInfo { hasNextPage }',
  '}',
  'baseRef {',
  'branchProtectionRule { requiresConversationResolution }',
  'rules(first: 100) {',
  'nodes { type }',
  'pageInfo { hasNextPage }',
  '}',
  '}',
  '}',
  '}',
  '}',
].join(' ');

export const CURRENT_BRANCH_TARGET = {
  mode: 'current_branch',
  owner: 'robhowley',
  repo: 'pi-userland',
  branch: 'feat/merge-ready',
} as const;

export function createFakeExec(expectedCalls: ExpectedExecCall[]): {
  exec: MergeReadyExec;
  assertDone: () => void;
  getCalls: () => ObservedExecCall[];
} {
  let index = 0;
  const calls: ObservedExecCall[] = [];

  const exec: MergeReadyExec = async (command, args, options) => {
    const observedCall = {
      command,
      args: [...args],
      cwd: options?.cwd,
      timeout: options?.timeout,
    };
    const expectedCall = expectedCalls[index];
    const implicitRequiredChecks = createImplicitRequiredChecksResult(
      command,
      args,
      options,
      expectedCalls[index - 1],
      expectedCall,
    );
    if (implicitRequiredChecks) {
      calls.push(observedCall);
      return implicitRequiredChecks;
    }

    expect(expectedCall, `Unexpected exec call ${command} ${args.join(' ')}`).toBeDefined();
    calls.push(observedCall);
    index += 1;

    expect(observedCall).toEqual({
      command: expectedCall?.command,
      args: expectedCall?.args,
      cwd: expectedCall?.cwd,
      timeout: expectedCall?.timeout ?? observedCall.timeout,
    });

    if (expectedCall?.error !== undefined) {
      throw expectedCall.error;
    }

    return expectedCall?.result ?? {};
  };

  return {
    exec,
    assertDone: () => {
      expect(index).toBe(expectedCalls.length);
    },
    getCalls: () => [...calls],
  };
}

export function createGitDiscoveryCalls(
  options: {
    cwd?: string;
    timeout?: number;
    repositoryRoot?: string;
    branch?: string;
  } = {},
): ExpectedExecCall[] {
  const cwd = options.cwd ?? '/repo';
  const repositoryRoot = options.repositoryRoot ?? cwd;
  const branch = options.branch ?? 'feat/merge-ready';

  return [
    {
      command: 'git',
      args: ['rev-parse', '--show-toplevel'],
      cwd,
      timeout: options.timeout,
      result: { stdout: `${repositoryRoot}\n` },
    },
    {
      command: 'git',
      args: ['branch', '--show-current'],
      cwd: repositoryRoot,
      timeout: options.timeout,
      result: { stdout: `${branch}\n` },
    },
    {
      command: 'git',
      args: ['remote'],
      cwd: repositoryRoot,
      timeout: options.timeout,
      result: { stdout: 'origin\n' },
    },
    {
      command: 'git',
      args: ['remote', 'get-url', 'origin'],
      cwd: repositoryRoot,
      timeout: options.timeout,
      result: { stdout: 'git@github.com:robhowley/pi-userland.git\n' },
    },
    {
      command: 'git',
      args: ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
      cwd: repositoryRoot,
      timeout: options.timeout,
      result: { stdout: 'origin/main\n' },
    },
    {
      command: 'git',
      args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      cwd: repositoryRoot,
      timeout: options.timeout,
      result: { stdout: 'origin/main\n' },
    },
    {
      command: 'git',
      args: ['rev-list', '--left-right', '--count', 'origin/main...HEAD'],
      cwd: repositoryRoot,
      timeout: options.timeout,
      result: { stdout: '0 0\n' },
    },
    {
      command: 'git',
      args: ['status', '--porcelain', '--untracked-files=normal'],
      cwd: repositoryRoot,
      timeout: options.timeout,
      result: { stdout: '' },
    },
  ];
}

export function createCurrentBranchProbeCall(
  options: {
    cwd?: string;
    timeout?: number;
    branch?: string;
  } = {},
): ExpectedExecCall {
  const branch = options.branch ?? 'feat/merge-ready';

  return {
    command: 'git',
    args: ['branch', '--show-current'],
    cwd: options.cwd ?? '/repo',
    timeout: options.timeout,
    result: {
      stdout: `${branch}\n`,
    },
  };
}

type ObservedExecCall = {
  command: string;
  args: string[];
  cwd?: string | undefined;
  timeout?: number | undefined;
};

export function createImplicitRequiredChecksResult(
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number } | undefined,
  previousCall: ExpectedExecCall | undefined,
  expectedCall: ExpectedExecCall | undefined,
): { stdout: string; stderr: string; code: number; killed: boolean } | null {
  const isRequiredChecksCall =
    command === 'gh' && args[0] === 'pr' && args[1] === 'checks' && args.includes('--required');
  const expectedIsRequiredChecksCall =
    expectedCall?.command === 'gh' &&
    expectedCall.args[0] === 'pr' &&
    expectedCall.args[1] === 'checks';
  const previousWasOpenPullRequestView =
    previousCall?.command === 'gh' &&
    previousCall.args[0] === 'pr' &&
    previousCall.args[1] === 'view' &&
    isOpenPullRequestViewResult(previousCall.result);
  if (!isRequiredChecksCall || expectedIsRequiredChecksCall || !previousWasOpenPullRequestView) {
    return null;
  }

  expect(options?.cwd).toBe(previousCall.cwd);
  if (previousCall.timeout !== undefined) expect(options?.timeout).toBe(previousCall.timeout);
  const checks = previousCall.requiredChecks ?? checksFromPullRequestResult(previousCall.result);
  return {
    stdout: `${JSON.stringify(checks)}\n`,
    stderr: '',
    code: requiredChecksExitCode(checks),
    killed: false,
  };
}

function isOpenPullRequestViewResult(result: ExpectedExecCall['result']): boolean {
  if (!result?.stdout) return false;

  try {
    const payload = JSON.parse(result.stdout) as { state?: unknown };
    return payload.state === 'OPEN';
  } catch {
    return false;
  }
}

function checksFromPullRequestResult(result: ExpectedExecCall['result']): unknown[] {
  if (!result?.stdout) return [];

  try {
    const payload = JSON.parse(result.stdout) as { statusCheckRollup?: unknown };
    if (!Array.isArray(payload.statusCheckRollup)) return [];

    return payload.statusCheckRollup.flatMap((row) => {
      if (!row || typeof row !== 'object') return [];
      const check = row as Record<string, unknown>;
      const name =
        typeof check['workflowName'] === 'string' && typeof check['name'] === 'string'
          ? `${check['workflowName']} / ${check['name']}`
          : typeof check['name'] === 'string'
            ? check['name']
            : typeof check['context'] === 'string'
              ? check['context']
              : 'unknown';
      const state = String(check['conclusion'] ?? check['status'] ?? check['state'] ?? 'UNKNOWN');
      const upperState = state.toUpperCase();
      const bucket = ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(upperState)
        ? 'pass'
        : ['IN_PROGRESS', 'QUEUED', 'PENDING', 'REQUESTED', 'WAITING'].includes(upperState)
          ? 'pending'
          : [
                'FAILURE',
                'ERROR',
                'ACTION_REQUIRED',
                'CANCELLED',
                'STALE',
                'STARTUP_FAILURE',
                'TIMED_OUT',
              ].includes(upperState)
            ? 'fail'
            : 'unknown';
      return [
        {
          name,
          state,
          bucket,
          link: check['detailsUrl'] ?? check['targetUrl'] ?? check['url'] ?? '',
        },
      ];
    });
  } catch {
    return [];
  }
}

function requiredChecksExitCode(checks: unknown[]): number {
  const buckets = checks.flatMap((check) =>
    check &&
    typeof check === 'object' &&
    typeof (check as Record<string, unknown>)['bucket'] === 'string'
      ? [String((check as Record<string, unknown>)['bucket']).toLowerCase()]
      : [],
  );
  if (buckets.some((bucket) => bucket === 'fail' || bucket === 'cancel')) return 1;
  if (buckets.includes('pending')) return 8;
  return 0;
}

type PullRequestViewCallOptions = {
  cwd?: string;
  timeout?: number;
  target?: MergeReadyUrlTarget;
  requiredChecks?: unknown[] | undefined;
};

export function createPullRequestViewArgs(target?: MergeReadyUrlTarget): string[] {
  const args = ['pr', 'view'];

  if (target) {
    args.push(String(target.prNumber), '--repo', `${target.owner}/${target.repo}`);
  }

  args.push('--json', GH_PR_VIEW_JSON_FIELDS);
  return args;
}

export function createRequiredChecksArgs(target?: MergeReadyUrlTarget): string[] {
  const args = ['pr', 'checks'];
  if (target) args.push(String(target.prNumber), '--repo', `${target.owner}/${target.repo}`);
  args.push('--required', '--json', 'name,state,bucket,link');
  return args;
}

export function createRequiredChecksCall(
  result: ExpectedExecCall['result'],
  options: PullRequestViewCallOptions = {},
): ExpectedExecCall {
  return {
    command: 'gh',
    args: createRequiredChecksArgs(options.target),
    cwd: options.cwd ?? '/repo',
    timeout: options.timeout,
    result,
  };
}

export function createPullRequestViewSuccessCall(
  payload: Record<string, unknown>,
  options: PullRequestViewCallOptions = {},
): ExpectedExecCall {
  return {
    command: 'gh',
    args: createPullRequestViewArgs(options.target),
    cwd: options.cwd ?? '/repo',
    timeout: options.timeout,
    result: {
      stdout: `${JSON.stringify(payload)}\n`,
    },
    ...(options.requiredChecks === undefined ? {} : { requiredChecks: options.requiredChecks }),
  };
}

export function createPullRequestViewFailureCall(
  result: ExpectedExecCall['result'],
  options: PullRequestViewCallOptions = {},
): ExpectedExecCall {
  return {
    command: 'gh',
    args: createPullRequestViewArgs(options.target),
    cwd: options.cwd ?? '/repo',
    timeout: options.timeout,
    result,
  };
}

export function createConversationsSuccessCall(
  payload: Record<string, unknown>,
  options: {
    cwd?: string;
    timeout?: number;
    repositoryOwner?: string;
    repositoryName?: string;
    pullRequestNumber?: number;
  } = {},
): ExpectedExecCall {
  return {
    command: 'gh',
    args: [
      'api',
      'graphql',
      '-f',
      `query=${GH_GRAPHQL_REVIEW_THREADS_QUERY}`,
      '-F',
      `owner=${options.repositoryOwner ?? 'robhowley'}`,
      '-F',
      `name=${options.repositoryName ?? 'pi-userland'}`,
      '-F',
      `number=${String(options.pullRequestNumber ?? 42)}`,
    ],
    cwd: options.cwd ?? '/repo',
    timeout: options.timeout,
    result: {
      stdout: `${JSON.stringify(payload)}\n`,
    },
  };
}

export function buildPullRequestPayload(overrides: Record<string, unknown> = {}) {
  return {
    number: 42,
    title: 'Compose merge-ready status boundary',
    url: 'https://github.com/robhowley/pi-userland/pull/42',
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    headRefName: 'feat/merge-ready',
    headRepository: {
      name: 'pi-userland',
    },
    headRepositoryOwner: {
      login: 'robhowley',
    },
    baseRefName: 'main',
    statusCheckRollup: [
      {
        __typename: 'CheckRun',
        workflowName: 'ci',
        name: 'unit',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
      },
    ],
    reviews: [
      {
        author: { login: 'reviewer1' },
        state: 'APPROVED',
        submittedAt: '2026-05-26T20:00:00Z',
      },
    ],
    reviewDecision: 'APPROVED',
    reviewRequests: [],
    author: {
      login: 'robhowley',
      name: 'Robert Howley',
      is_bot: false,
    },
    ...overrides,
  };
}

export const REQUESTED_REVIEWER_SCENARIO = {
  pullRequestOverrides: {
    reviews: [],
    reviewDecision: 'REVIEW_REQUIRED',
    reviewRequests: [
      { __typename: 'User', login: 'alice' },
      { __typename: 'Team', slug: 'core-reviewers' },
    ],
  } satisfies Record<string, unknown>,
  openItemDetails: [{ label: '@alice' }, { label: 'team/core-reviewers' }],
};

export function buildConversationsPayload(pullRequestOverrides: Record<string, unknown> = {}) {
  return {
    data: {
      repository: {
        pullRequest: {
          latestOpinionatedReviews: {
            nodes: [],
          },
          reviewThreads: {
            nodes: [],
            pageInfo: {
              hasNextPage: false,
            },
          },
          baseRef: {
            branchProtectionRule: {
              requiresConversationResolution: false,
            },
            rules: {
              nodes: [{ type: 'PULL_REQUEST' }],
              pageInfo: {
                hasNextPage: false,
              },
            },
          },
          ...pullRequestOverrides,
        },
      },
    },
  };
}
