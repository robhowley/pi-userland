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
  error?: unknown;
};

export const GH_PR_VIEW_JSON_FIELDS =
  'number,title,url,state,isDraft,mergeable,mergeStateStatus,headRefName,headRepository,headRepositoryOwner,baseRefName,statusCheckRollup,reviews,reviewDecision,reviewRequests,author';

export const GH_GRAPHQL_REVIEW_THREADS_QUERY = [
  'query MergeReadyReviewThreads($owner: String!, $name: String!, $number: Int!) {',
  'repository(owner: $owner, name: $name) {',
  'pullRequest(number: $number) {',
  'latestOpinionatedReviews(first: 100) {',
  'nodes { author { login } state submittedAt url }',
  'pageInfo { hasNextPage }',
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
    expect(expectedCall, `Unexpected exec call ${command} ${args.join(' ')}`).toBeDefined();

    calls.push(observedCall);
    index += 1;

    expect(observedCall).toEqual({
      command: expectedCall?.command,
      args: expectedCall?.args,
      cwd: expectedCall?.cwd,
      timeout: expectedCall?.timeout,
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
  } = {},
): ExpectedExecCall[] {
  const cwd = options.cwd ?? '/repo';
  const repositoryRoot = options.repositoryRoot ?? cwd;

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
      result: { stdout: 'feat/merge-ready\n' },
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

type ObservedExecCall = {
  command: string;
  args: string[];
  cwd?: string | undefined;
  timeout?: number | undefined;
};

type PullRequestViewCallOptions = {
  cwd?: string;
  timeout?: number;
  target?: MergeReadyUrlTarget;
};

export function createPullRequestViewArgs(target?: MergeReadyUrlTarget): string[] {
  const args = ['pr', 'view'];

  if (target) {
    args.push(String(target.prNumber), '--repo', `${target.owner}/${target.repo}`);
  }

  args.push('--json', GH_PR_VIEW_JSON_FIELDS);
  return args;
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

export function buildConversationsPayload(pullRequestOverrides: Record<string, unknown> = {}) {
  return {
    data: {
      repository: {
        pullRequest: {
          latestOpinionatedReviews: {
            nodes: [],
            pageInfo: {
              hasNextPage: false,
            },
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
