import { describe, expect, it } from 'vitest';
import {
  getMergeReadyStatus,
  selectMergeReadyBadgeId,
  type MergeReadyBadgeId,
  type MergeReadyExec,
  type MergeReadyExecResult,
  type MergeReadyOpenItemId,
  type MergeReadySignals,
  type MergeReadyState,
} from '../../extensions/merge-ready/index.js';

type ExpectedExecCall = {
  command: string;
  args: string[];
  cwd?: string | undefined;
  timeout?: number | undefined;
  result?: MergeReadyExecResult;
  error?: unknown;
};

type BlockerFixture = {
  name: string;
  prOverrides: Record<string, unknown>;
  expectedBadge: MergeReadyBadgeId;
  expectedState: MergeReadyState;
  expectedSummary: string;
  expectedOpenItemIds: MergeReadyOpenItemId[];
  expectedSignals: MergeReadySignals;
};

const GENERATED_AT = '2026-05-26T22:00:00.000Z';
const GH_PR_VIEW_JSON_FIELDS =
  'number,title,url,state,isDraft,mergeable,mergeStateStatus,headRefName,baseRefName,statusCheckRollup,reviews,reviewRequests,author';
const GH_GRAPHQL_REVIEW_THREADS_QUERY = [
  'query MergeReadyReviewThreads($owner: String!, $name: String!, $number: Int!) {',
  'repository(owner: $owner, name: $name) {',
  'pullRequest(number: $number) {',
  'reviewThreads(first: 100) {',
  'nodes { isResolved }',
  'pageInfo { hasNextPage }',
  '}',
  '}',
  '}',
  '}',
].join(' ');

function createFakeExec(expectedCalls: ExpectedExecCall[]): {
  exec: MergeReadyExec;
  assertDone: () => void;
} {
  let index = 0;

  const exec: MergeReadyExec = async (command, args, options) => {
    const expectedCall = expectedCalls[index];
    expect(expectedCall, `Unexpected exec call ${command} ${args.join(' ')}`).toBeDefined();

    index += 1;

    expect({
      command,
      args,
      cwd: options?.cwd,
      timeout: options?.timeout,
    }).toEqual({
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
  };
}

function createGitDiscoveryCalls(timeout?: number): ExpectedExecCall[] {
  return [
    {
      command: 'git',
      args: ['rev-parse', '--show-toplevel'],
      cwd: '/repo',
      timeout,
      result: { stdout: '/repo\n' },
    },
    {
      command: 'git',
      args: ['branch', '--show-current'],
      cwd: '/repo',
      timeout,
      result: { stdout: 'feat/merge-ready\n' },
    },
    {
      command: 'git',
      args: ['remote'],
      cwd: '/repo',
      timeout,
      result: { stdout: 'origin\n' },
    },
    {
      command: 'git',
      args: ['remote', 'get-url', 'origin'],
      cwd: '/repo',
      timeout,
      result: { stdout: 'git@github.com:robhowley/pi-userland.git\n' },
    },
    {
      command: 'git',
      args: ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
      cwd: '/repo',
      timeout,
      result: { stdout: 'origin/main\n' },
    },
    {
      command: 'git',
      args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      cwd: '/repo',
      timeout,
      result: { stdout: 'origin/main\n' },
    },
    {
      command: 'git',
      args: ['rev-list', '--left-right', '--count', 'origin/main...HEAD'],
      cwd: '/repo',
      timeout,
      result: { stdout: '0 0\n' },
    },
    {
      command: 'git',
      args: ['status', '--porcelain', '--untracked-files=normal'],
      cwd: '/repo',
      timeout,
      result: { stdout: '' },
    },
  ];
}

function createPullRequestViewSuccessCall(
  payload: Record<string, unknown>,
  timeout?: number,
): ExpectedExecCall {
  return {
    command: 'gh',
    args: ['pr', 'view', '--json', GH_PR_VIEW_JSON_FIELDS],
    cwd: '/repo',
    timeout,
    result: {
      stdout: `${JSON.stringify(payload)}\n`,
    },
  };
}

function createConversationsSuccessCall(
  payload: Record<string, unknown>,
  timeout?: number,
): ExpectedExecCall {
  return {
    command: 'gh',
    args: [
      'api',
      'graphql',
      '-f',
      `query=${GH_GRAPHQL_REVIEW_THREADS_QUERY}`,
      '-F',
      'owner=robhowley',
      '-F',
      'name=pi-userland',
      '-F',
      'number=42',
    ],
    cwd: '/repo',
    timeout,
    result: {
      stdout: `${JSON.stringify(payload)}\n`,
    },
  };
}

function buildPullRequestPayload(overrides: Record<string, unknown> = {}) {
  return {
    number: 42,
    title: 'Compose merge-ready status boundary',
    url: 'https://github.com/robhowley/pi-userland/pull/42',
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    headRefName: 'feat/merge-ready',
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
    reviewRequests: [],
    author: {
      login: 'robhowley',
      name: 'Robert Howley',
      is_bot: false,
    },
    ...overrides,
  };
}

function buildConversationsPayload(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [],
            pageInfo: {
              hasNextPage: false,
            },
          },
        },
      },
    },
    ...overrides,
  };
}

function openItemIds(
  status: Awaited<ReturnType<typeof getMergeReadyStatus>>,
): MergeReadyOpenItemId[] {
  return status.openItems.map((openItem) => openItem.id);
}

const blockerFixtures: BlockerFixture[] = [
  {
    name: 'draft',
    prOverrides: {
      isDraft: true,
      mergeStateStatus: 'DRAFT',
    },
    expectedBadge: 'draft',
    expectedState: 'blocked',
    expectedSummary: 'Pull request is still a draft',
    expectedOpenItemIds: ['draft'],
    expectedSignals: {
      discovery: 'complete',
      pullRequest: 'present',
      draft: 'yes',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: 'no',
    },
  },
  {
    name: 'failing checks',
    prOverrides: {
      statusCheckRollup: [
        {
          __typename: 'CheckRun',
          workflowName: 'ci',
          name: 'unit',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
        },
      ],
    },
    expectedBadge: 'ci_failing',
    expectedState: 'blocked',
    expectedSummary: 'Required checks are failing',
    expectedOpenItemIds: ['ci_failing'],
    expectedSignals: {
      discovery: 'complete',
      pullRequest: 'present',
      draft: 'no',
      checks: 'failing',
      review: 'approved',
      unresolvedConversations: 'no',
    },
  },
  {
    name: 'running checks',
    prOverrides: {
      statusCheckRollup: [
        {
          __typename: 'CheckRun',
          workflowName: 'ci',
          name: 'unit',
          status: 'IN_PROGRESS',
        },
      ],
    },
    expectedBadge: 'ci_running',
    expectedState: 'pending',
    expectedSummary: 'Checks are still running',
    expectedOpenItemIds: ['ci_running'],
    expectedSignals: {
      discovery: 'complete',
      pullRequest: 'present',
      draft: 'no',
      checks: 'running',
      review: 'approved',
      unresolvedConversations: 'no',
    },
  },
  {
    name: 'changes requested',
    prOverrides: {
      reviews: [
        {
          author: { login: 'reviewer1' },
          state: 'CHANGES_REQUESTED',
          submittedAt: '2026-05-26T20:00:00Z',
        },
      ],
    },
    expectedBadge: 'changes_requested',
    expectedState: 'blocked',
    expectedSummary: 'Changes requested by reviewers',
    expectedOpenItemIds: ['changes_requested'],
    expectedSignals: {
      discovery: 'complete',
      pullRequest: 'present',
      draft: 'no',
      checks: 'passing',
      review: 'changes_requested',
      unresolvedConversations: 'no',
    },
  },
  {
    name: 'review pending',
    prOverrides: {
      reviews: [],
    },
    expectedBadge: 'review_pending',
    expectedState: 'pending',
    expectedSummary: 'Waiting for review',
    expectedOpenItemIds: ['review_pending'],
    expectedSignals: {
      discovery: 'complete',
      pullRequest: 'present',
      draft: 'no',
      checks: 'passing',
      review: 'pending',
      unresolvedConversations: 'no',
    },
  },
];

describe('getMergeReadyStatus', () => {
  it('returns a ready status from normalized git, GitHub, and conversation facts', async () => {
    const { exec, assertDone } = createFakeExec([
      ...createGitDiscoveryCalls(5_000),
      createPullRequestViewSuccessCall(buildPullRequestPayload(), 5_000),
      createConversationsSuccessCall(
        buildConversationsPayload({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [{ isResolved: true }, { isResolved: true }],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          },
        }),
        5_000,
      ),
    ]);

    const status = await getMergeReadyStatus({
      exec,
      cwd: '/repo',
      timeout: 5_000,
      now: () => new Date(GENERATED_AT),
    });

    assertDone();

    expect(status).toEqual({
      state: 'ready',
      pr: {
        lifecycle: 'open',
        number: 42,
        title: 'Compose merge-ready status boundary',
        url: 'https://github.com/robhowley/pi-userland/pull/42',
      },
      summary: 'Ready to merge',
      openItems: [],
      signals: {
        discovery: 'complete',
        pullRequest: 'present',
        draft: 'no',
        checks: 'passing',
        review: 'approved',
        unresolvedConversations: 'no',
      },
      generatedAt: GENERATED_AT,
    });
    expect(status.pr).not.toHaveProperty('headRefName');
    expect(status.pr).not.toHaveProperty('baseRefName');
    expect(selectMergeReadyBadgeId(status)).toBe('ready');
  });

  it.each(blockerFixtures)(
    'maps $name into normalized signals and status blockers',
    async (fixture) => {
      const { exec, assertDone } = createFakeExec([
        ...createGitDiscoveryCalls(),
        createPullRequestViewSuccessCall(buildPullRequestPayload(fixture.prOverrides)),
        createConversationsSuccessCall(buildConversationsPayload()),
      ]);

      const status = await getMergeReadyStatus({
        exec,
        cwd: '/repo',
        generatedAt: GENERATED_AT,
      });

      assertDone();

      expect(status.state).toBe(fixture.expectedState);
      expect(status.summary).toBe(fixture.expectedSummary);
      expect(status.signals).toEqual(fixture.expectedSignals);
      expect(openItemIds(status)).toEqual(fixture.expectedOpenItemIds);
      expect(selectMergeReadyBadgeId(status)).toBe(fixture.expectedBadge);
    },
  );

  it('treats known unresolved conversations as a blocker', async () => {
    const { exec, assertDone } = createFakeExec([
      ...createGitDiscoveryCalls(),
      createPullRequestViewSuccessCall(buildPullRequestPayload()),
      createConversationsSuccessCall(
        buildConversationsPayload({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [{ isResolved: true }, { isResolved: false }, { isResolved: false }],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          },
        }),
      ),
    ]);

    const status = await getMergeReadyStatus({
      exec,
      cwd: '/repo',
      generatedAt: GENERATED_AT,
    });

    assertDone();

    expect(status.state).toBe('blocked');
    expect(status.summary).toBe('Unresolved review conversations remain');
    expect(status.signals).toEqual({
      discovery: 'complete',
      pullRequest: 'present',
      draft: 'no',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: 'yes',
    });
    expect(openItemIds(status)).toEqual(['unresolved_conversations']);
    expect(selectMergeReadyBadgeId(status)).toBe('unresolved_conversations');
  });

  it('returns the no-pull-request status when gh pr view reports no PR', async () => {
    const { exec, assertDone } = createFakeExec([
      ...createGitDiscoveryCalls(),
      {
        command: 'gh',
        args: ['pr', 'view', '--json', GH_PR_VIEW_JSON_FIELDS],
        cwd: '/repo',
        result: {
          exitCode: 1,
          stderr: 'no pull requests found for branch "feat/merge-ready"\n',
        },
      },
    ]);

    const status = await getMergeReadyStatus({
      exec,
      cwd: '/repo',
      generatedAt: GENERATED_AT,
    });

    assertDone();

    expect(status).toEqual({
      state: 'unknown',
      pr: null,
      summary: 'No pull request found',
      openItems: [
        {
          id: 'no_pull_request',
          owner: 'user',
          actionability: 'actionable',
          summary: 'No pull request found',
        },
      ],
      signals: {
        discovery: 'complete',
        pullRequest: 'missing',
        draft: 'unknown',
        checks: 'unknown',
        review: 'unknown',
        unresolvedConversations: 'unknown',
      },
      generatedAt: GENERATED_AT,
    });
    expect(selectMergeReadyBadgeId(status)).toBe('unknown');
  });

  it('returns an ambiguous unknown status when git discovery says cwd is not a git repository', async () => {
    const { exec, assertDone } = createFakeExec([
      {
        command: 'git',
        args: ['rev-parse', '--show-toplevel'],
        cwd: '/tmp/not-a-repo',
        result: {
          exitCode: 128,
          stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
        },
      },
    ]);

    const status = await getMergeReadyStatus({
      exec,
      cwd: '/tmp/not-a-repo',
      generatedAt: GENERATED_AT,
    });

    assertDone();

    expect(status.state).toBe('unknown');
    expect(status.pr).toBeNull();
    expect(status.summary).toBe('Merge readiness is ambiguous');
    expect(openItemIds(status)).toEqual(['status_ambiguous']);
    expect(status.signals).toEqual({
      discovery: 'ambiguous',
      pullRequest: 'unknown',
      draft: 'unknown',
      checks: 'unknown',
      review: 'unknown',
      unresolvedConversations: 'unknown',
    });
    expect(selectMergeReadyBadgeId(status)).toBe('unknown');
  });

  it('returns an ambiguous unknown status when the local remote is not GitHub', async () => {
    const { exec, assertDone } = createFakeExec([
      {
        command: 'git',
        args: ['rev-parse', '--show-toplevel'],
        cwd: '/repo',
        result: { stdout: '/repo\n' },
      },
      {
        command: 'git',
        args: ['branch', '--show-current'],
        cwd: '/repo',
        result: { stdout: 'feat/merge-ready\n' },
      },
      {
        command: 'git',
        args: ['remote'],
        cwd: '/repo',
        result: { stdout: 'origin\n' },
      },
      {
        command: 'git',
        args: ['remote', 'get-url', 'origin'],
        cwd: '/repo',
        result: { stdout: 'git@gitlab.com:team/repo.git\n' },
      },
      {
        command: 'git',
        args: ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
        cwd: '/repo',
        result: { stdout: 'origin/main\n' },
      },
      {
        command: 'git',
        args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
        cwd: '/repo',
        result: { stdout: 'origin/main\n' },
      },
      {
        command: 'git',
        args: ['rev-list', '--left-right', '--count', 'origin/main...HEAD'],
        cwd: '/repo',
        result: { stdout: '0 0\n' },
      },
      {
        command: 'git',
        args: ['status', '--porcelain', '--untracked-files=normal'],
        cwd: '/repo',
        result: { stdout: '' },
      },
    ]);

    const status = await getMergeReadyStatus({
      exec,
      cwd: '/repo',
      generatedAt: GENERATED_AT,
    });

    assertDone();

    expect(status.state).toBe('unknown');
    expect(status.summary).toBe('Merge readiness is ambiguous');
    expect(openItemIds(status)).toEqual(['status_ambiguous']);
    expect(status.signals).toEqual({
      discovery: 'ambiguous',
      pullRequest: 'unknown',
      draft: 'unknown',
      checks: 'unknown',
      review: 'unknown',
      unresolvedConversations: 'unknown',
    });
  });

  it('returns an ambiguous unknown status when local git discovery fails with a command error', async () => {
    const { exec, assertDone } = createFakeExec([
      {
        command: 'git',
        args: ['rev-parse', '--show-toplevel'],
        cwd: '/repo',
        error: new Error('spawn git EACCES'),
      },
    ]);

    const status = await getMergeReadyStatus({
      exec,
      cwd: '/repo',
      generatedAt: GENERATED_AT,
    });

    assertDone();

    expect(status.state).toBe('unknown');
    expect(status.summary).toBe('Merge readiness is ambiguous');
    expect(openItemIds(status)).toEqual(['status_ambiguous']);
    expect(status.signals).toEqual({
      discovery: 'ambiguous',
      pullRequest: 'unknown',
      draft: 'unknown',
      checks: 'unknown',
      review: 'unknown',
      unresolvedConversations: 'unknown',
    });
  });

  it('returns an ambiguous unknown status when GitHub PR discovery fails with auth issues', async () => {
    const { exec, assertDone } = createFakeExec([
      ...createGitDiscoveryCalls(),
      {
        command: 'gh',
        args: ['pr', 'view', '--json', GH_PR_VIEW_JSON_FIELDS],
        cwd: '/repo',
        result: {
          exitCode: 4,
          stderr: 'To get started with GitHub CLI, please run:  gh auth login\n',
        },
      },
    ]);

    const status = await getMergeReadyStatus({
      exec,
      cwd: '/repo',
      generatedAt: GENERATED_AT,
    });

    assertDone();

    expect(status.state).toBe('unknown');
    expect(status.summary).toBe('Merge readiness is ambiguous');
    expect(openItemIds(status)).toEqual(['status_ambiguous']);
    expect(status.signals).toEqual({
      discovery: 'ambiguous',
      pullRequest: 'unknown',
      draft: 'unknown',
      checks: 'unknown',
      review: 'unknown',
      unresolvedConversations: 'unknown',
    });
  });

  it('keeps conversations partial-zero ambiguous instead of treating them as resolved', async () => {
    const { exec, assertDone } = createFakeExec([
      ...createGitDiscoveryCalls(),
      createPullRequestViewSuccessCall(buildPullRequestPayload()),
      createConversationsSuccessCall(
        buildConversationsPayload({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [{ isResolved: true }, { isResolved: true }],
                  pageInfo: { hasNextPage: true },
                },
              },
            },
          },
        }),
      ),
    ]);

    const status = await getMergeReadyStatus({
      exec,
      cwd: '/repo',
      generatedAt: GENERATED_AT,
    });

    assertDone();

    expect(status.state).toBe('unknown');
    expect(status.summary).toBe('Merge readiness is ambiguous');
    expect(openItemIds(status)).toEqual(['status_ambiguous']);
    expect(status.signals).toEqual({
      discovery: 'ambiguous',
      pullRequest: 'present',
      draft: 'unknown',
      checks: 'unknown',
      review: 'unknown',
      unresolvedConversations: 'unknown',
    });
  });

  it('keeps conversations failures ambiguous instead of collapsing them to no unresolved conversations', async () => {
    const { exec, assertDone } = createFakeExec([
      ...createGitDiscoveryCalls(),
      createPullRequestViewSuccessCall(buildPullRequestPayload()),
      {
        command: 'gh',
        args: [
          'api',
          'graphql',
          '-f',
          `query=${GH_GRAPHQL_REVIEW_THREADS_QUERY}`,
          '-F',
          'owner=robhowley',
          '-F',
          'name=pi-userland',
          '-F',
          'number=42',
        ],
        cwd: '/repo',
        result: {
          exitCode: 1,
          stderr: 'GraphQL: Something went wrong\n',
        },
      },
    ]);

    const status = await getMergeReadyStatus({
      exec,
      cwd: '/repo',
      generatedAt: GENERATED_AT,
    });

    assertDone();

    expect(status.state).toBe('unknown');
    expect(status.summary).toBe('Merge readiness is ambiguous');
    expect(openItemIds(status)).toEqual(['status_ambiguous']);
    expect(status.signals).toEqual({
      discovery: 'ambiguous',
      pullRequest: 'present',
      draft: 'unknown',
      checks: 'unknown',
      review: 'unknown',
      unresolvedConversations: 'unknown',
    });
  });

  it.each([
    {
      name: 'merged',
      state: 'MERGED',
      expectedBadge: 'merged',
      expectedSummary: 'Pull request merged',
    },
    {
      name: 'closed',
      state: 'CLOSED',
      expectedBadge: 'closed',
      expectedSummary: 'Pull request closed',
    },
  ])(
    'returns the existing terminal lifecycle status when the PR is $name without fetching conversations',
    async ({ state, expectedBadge, expectedSummary }) => {
      const { exec, assertDone } = createFakeExec([
        ...createGitDiscoveryCalls(),
        createPullRequestViewSuccessCall(buildPullRequestPayload({ state })),
      ]);

      const status = await getMergeReadyStatus({
        exec,
        cwd: '/repo',
        generatedAt: GENERATED_AT,
      });

      assertDone();

      expect(status.state).toBe('ready');
      expect(status.summary).toBe(expectedSummary);
      expect(status.openItems).toEqual([]);
      expect(status.signals).toEqual({
        discovery: 'complete',
        pullRequest: 'present',
        draft: 'no',
        checks: 'passing',
        review: 'approved',
        unresolvedConversations: 'no',
      });
      expect(selectMergeReadyBadgeId(status)).toBe(expectedBadge);
    },
  );
});
