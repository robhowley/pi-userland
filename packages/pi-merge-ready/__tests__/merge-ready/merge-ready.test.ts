import { describe, expect, it } from 'vitest';
import {
  getMergeReadyStatus,
  selectMergeReadyBadgeId,
  type MergeReadyBadgeId,
  type MergeReadyExecResult,
  type MergeReadyOpenItemId,
  type MergeReadySignals,
  type MergeReadyState,
} from '../../extensions/merge-ready/index.js';
import {
  GH_GRAPHQL_REVIEW_THREADS_QUERY,
  GH_PR_VIEW_JSON_FIELDS,
  buildConversationsPayload as buildOptionalConversationsPayload,
  buildPullRequestPayload,
  createConversationsSuccessCall,
  createFakeExec,
  createGitDiscoveryCalls,
  createPullRequestViewSuccessCall,
} from './test-fixtures.js';

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

function buildConversationsPayload(pullRequestOverrides: Record<string, unknown> = {}) {
  return buildOptionalConversationsPayload({
    baseRef: {
      branchProtectionRule: {
        requiresConversationResolution: true,
      },
      rules: {
        nodes: [],
        pageInfo: { hasNextPage: false },
      },
    },
    ...pullRequestOverrides,
  });
}

function openItemIds(
  status: Awaited<ReturnType<typeof getMergeReadyStatus>>,
): MergeReadyOpenItemId[] {
  return status.openItems.map((openItem) => openItem.id);
}

const blockerFixtures: BlockerFixture[] = [
  {
    name: 'merge conflicts',
    prOverrides: {
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
    },
    expectedBadge: 'merge_conflicts',
    expectedState: 'blocked',
    expectedSummary: 'Merge conflicts detected',
    expectedOpenItemIds: ['merge_conflicts'],
    expectedSignals: {
      draft: false,
      mergeability: 'conflicting',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: false,
      unresolvedConversationRequirement: 'required',
    },
  },
  {
    name: 'branch out of date',
    prOverrides: {
      mergeStateStatus: 'BEHIND',
    },
    expectedBadge: 'branch_out_of_date',
    expectedState: 'blocked',
    expectedSummary: 'Branch is out of date with base',
    expectedOpenItemIds: ['branch_out_of_date'],
    expectedSignals: {
      draft: false,
      mergeability: 'behind',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: false,
      unresolvedConversationRequirement: 'required',
    },
  },
  {
    name: 'generic merge blocked from BLOCKED',
    prOverrides: {
      mergeStateStatus: 'BLOCKED',
    },
    expectedBadge: 'merge_blocked',
    expectedState: 'blocked',
    expectedSummary: 'GitHub reports merge is blocked',
    expectedOpenItemIds: ['merge_blocked'],
    expectedSignals: {
      draft: false,
      mergeability: 'blocked',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: false,
      unresolvedConversationRequirement: 'required',
    },
  },
  {
    name: 'generic merge blocked from UNSTABLE',
    prOverrides: {
      mergeStateStatus: 'UNSTABLE',
    },
    expectedBadge: 'merge_blocked',
    expectedState: 'blocked',
    expectedSummary: 'GitHub reports merge is blocked',
    expectedOpenItemIds: ['merge_blocked'],
    expectedSignals: {
      draft: false,
      mergeability: 'blocked',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: false,
      unresolvedConversationRequirement: 'required',
    },
  },
  {
    name: 'generic merge blocked from HAS_HOOKS',
    prOverrides: {
      mergeStateStatus: 'HAS_HOOKS',
    },
    expectedBadge: 'merge_blocked',
    expectedState: 'blocked',
    expectedSummary: 'GitHub reports merge is blocked',
    expectedOpenItemIds: ['merge_blocked'],
    expectedSignals: {
      draft: false,
      mergeability: 'blocked',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: false,
      unresolvedConversationRequirement: 'required',
    },
  },
  {
    name: 'ambiguous mergeability from mergeable UNKNOWN',
    prOverrides: {
      mergeable: 'UNKNOWN',
      mergeStateStatus: 'CLEAN',
    },
    expectedBadge: 'unknown',
    expectedState: 'unknown',
    expectedSummary: 'Merge readiness is ambiguous',
    expectedOpenItemIds: ['status_ambiguous'],
    expectedSignals: {
      draft: false,
      mergeability: 'unknown',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: false,
      unresolvedConversationRequirement: 'required',
    },
  },
  {
    name: 'ambiguous mergeability from merge state UNKNOWN',
    prOverrides: {
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'UNKNOWN',
    },
    expectedBadge: 'unknown',
    expectedState: 'unknown',
    expectedSummary: 'Merge readiness is ambiguous',
    expectedOpenItemIds: ['status_ambiguous'],
    expectedSignals: {
      draft: false,
      mergeability: 'unknown',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: false,
      unresolvedConversationRequirement: 'required',
    },
  },
  {
    name: 'ambiguous mergeability from missing fields',
    prOverrides: {
      mergeable: null,
    },
    expectedBadge: 'unknown',
    expectedState: 'unknown',
    expectedSummary: 'Merge readiness is ambiguous',
    expectedOpenItemIds: ['status_ambiguous'],
    expectedSignals: {
      draft: false,
      mergeability: 'unknown',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: false,
      unresolvedConversationRequirement: 'required',
    },
  },
  {
    name: 'future mergeability values stay blocked',
    prOverrides: {
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'REBASEABLE',
    },
    expectedBadge: 'merge_blocked',
    expectedState: 'blocked',
    expectedSummary: 'GitHub reports merge is blocked',
    expectedOpenItemIds: ['merge_blocked'],
    expectedSignals: {
      draft: false,
      mergeability: 'blocked',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: false,
      unresolvedConversationRequirement: 'required',
    },
  },
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
      draft: true,
      mergeability: 'blocked',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: false,
      unresolvedConversationRequirement: 'required',
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
      draft: false,
      mergeability: 'mergeable',
      checks: 'failing',
      review: 'approved',
      unresolvedConversations: false,
      unresolvedConversationRequirement: 'required',
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
      draft: false,
      mergeability: 'mergeable',
      checks: 'running',
      review: 'approved',
      unresolvedConversations: false,
      unresolvedConversationRequirement: 'required',
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
      reviewDecision: 'CHANGES_REQUESTED',
    },
    expectedBadge: 'changes_requested',
    expectedState: 'blocked',
    expectedSummary: 'Changes requested by reviewers',
    expectedOpenItemIds: ['changes_requested'],
    expectedSignals: {
      draft: false,
      mergeability: 'mergeable',
      checks: 'passing',
      review: 'changes_requested',
      unresolvedConversations: false,
      unresolvedConversationRequirement: 'required',
    },
  },
  {
    name: 'review pending',
    prOverrides: {
      reviews: [],
      reviewDecision: 'REVIEW_REQUIRED',
    },
    expectedBadge: 'review_pending',
    expectedState: 'pending',
    expectedSummary: 'Waiting for review',
    expectedOpenItemIds: ['review_pending'],
    expectedSignals: {
      draft: false,
      mergeability: 'mergeable',
      checks: 'passing',
      review: 'pending',
      unresolvedConversations: false,
      unresolvedConversationRequirement: 'required',
    },
  },
];

describe('getMergeReadyStatus', () => {
  it('returns a ready status from normalized git, GitHub, and conversation facts', async () => {
    const { exec, assertDone } = createFakeExec([
      ...createGitDiscoveryCalls({ timeout: 5_000 }),
      createPullRequestViewSuccessCall(buildPullRequestPayload(), { timeout: 5_000 }),
      createConversationsSuccessCall(
        buildConversationsPayload({
          reviewThreads: {
            nodes: [{ isResolved: true }, { isResolved: true }],
            pageInfo: { hasNextPage: false },
          },
        }),
        { timeout: 5_000 },
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
        number: 42,
        title: 'Compose merge-ready status boundary',
        url: 'https://github.com/robhowley/pi-userland/pull/42',
      },
      summary: 'Ready to merge',
      openItems: [],
      signals: {
        draft: false,
        mergeability: 'mergeable',
        checks: 'passing',
        review: 'approved',
        unresolvedConversations: false,
        unresolvedConversationRequirement: 'required',
      },
      generatedAt: GENERATED_AT,
    });
    expect(status.pr).not.toHaveProperty('headRefName');
    expect(status.pr).not.toHaveProperty('baseRefName');
    expect(selectMergeReadyBadgeId(status)).toBe('ready');
  });

  it.each([
    {
      name: 'fails with a command/API error',
      result: {
        exitCode: 1,
        stderr: 'GraphQL: Something went wrong\n',
      } satisfies MergeReadyExecResult,
    },
    {
      name: 'returns invalid JSON',
      result: {
        stdout: '{ definitely not json',
      } satisfies MergeReadyExecResult,
    },
    {
      name: 'returns an invalid shape',
      result: {
        stdout: JSON.stringify({ state: 'OPEN' }),
      } satisfies MergeReadyExecResult,
    },
  ])('surfaces status_ambiguous when GitHub PR discovery $name', async ({ result }) => {
    const { exec, assertDone } = createFakeExec([
      ...createGitDiscoveryCalls(),
      {
        command: 'gh',
        args: ['pr', 'view', '--json', GH_PR_VIEW_JSON_FIELDS],
        cwd: '/repo',
        result,
      },
    ]);

    const status = await getMergeReadyStatus({
      exec,
      cwd: '/repo',
      now: () => new Date(GENERATED_AT),
    });

    assertDone();

    expect(status.state).toBe('unknown');
    expect(status.pr).toBeNull();
    expect(status.summary).toBe('Merge readiness is ambiguous');
    expect(openItemIds(status)).toEqual(['status_ambiguous']);
    expect(status.signals).toEqual({
      draft: false,
      mergeability: 'unknown',
      checks: 'unknown',
      review: 'unknown',
      unresolvedConversations: false,
      unresolvedConversationRequirement: 'unknown',
    });
    expect(selectMergeReadyBadgeId(status)).toBe('unknown');
  });

  it('surfaces status_ambiguous when conversation discovery fails outright', async () => {
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
      now: () => new Date(GENERATED_AT),
    });

    assertDone();

    expect(status.state).toBe('unknown');
    expect(status.pr?.number).toBe(42);
    expect(status.summary).toBe('Merge readiness is ambiguous');
    expect(openItemIds(status)).toEqual(['status_ambiguous']);
    expect(status.signals).toEqual({
      draft: false,
      mergeability: 'mergeable',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: false,
      unresolvedConversationRequirement: 'unknown',
    });
    expect(selectMergeReadyBadgeId(status)).toBe('unknown');
  });

  it('surfaces status_ambiguous when conversation thread discovery is paginated', async () => {
    const { exec, assertDone } = createFakeExec([
      ...createGitDiscoveryCalls(),
      createPullRequestViewSuccessCall(buildPullRequestPayload()),
      createConversationsSuccessCall(
        buildConversationsPayload({
          reviewThreads: {
            nodes: [{ isResolved: true }, { isResolved: true }],
            pageInfo: { hasNextPage: true },
          },
        }),
      ),
    ]);

    const status = await getMergeReadyStatus({
      exec,
      cwd: '/repo',
      now: () => new Date(GENERATED_AT),
    });

    assertDone();

    expect(status.state).toBe('unknown');
    expect(status.pr?.number).toBe(42);
    expect(status.summary).toBe('Merge readiness is ambiguous');
    expect(openItemIds(status)).toEqual(['status_ambiguous']);
    expect(status.signals).toEqual({
      draft: false,
      mergeability: 'mergeable',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: false,
      unresolvedConversationRequirement: 'required',
    });
    expect(selectMergeReadyBadgeId(status)).toBe('unknown');
  });

  it('surfaces status_ambiguous when conversation policy discovery is paginated', async () => {
    const { exec, assertDone } = createFakeExec([
      ...createGitDiscoveryCalls(),
      createPullRequestViewSuccessCall(buildPullRequestPayload()),
      createConversationsSuccessCall(
        buildConversationsPayload({
          reviewThreads: {
            nodes: [{ isResolved: true }],
            pageInfo: { hasNextPage: false },
          },
          baseRef: {
            branchProtectionRule: null,
            rules: {
              nodes: [{ type: 'PULL_REQUEST' }],
              pageInfo: { hasNextPage: true },
            },
          },
        }),
      ),
    ]);

    const status = await getMergeReadyStatus({
      exec,
      cwd: '/repo',
      now: () => new Date(GENERATED_AT),
    });

    assertDone();

    expect(status.state).toBe('unknown');
    expect(status.pr?.number).toBe(42);
    expect(status.summary).toBe('Merge readiness is ambiguous');
    expect(openItemIds(status)).toEqual(['status_ambiguous']);
    expect(status.signals).toEqual({
      draft: false,
      mergeability: 'mergeable',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: false,
      unresolvedConversationRequirement: 'unknown',
    });
    expect(selectMergeReadyBadgeId(status)).toBe('unknown');
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
        now: () => new Date(GENERATED_AT),
      });

      assertDone();

      expect(status.state).toBe(fixture.expectedState);
      expect(status.summary).toBe(fixture.expectedSummary);
      expect(openItemIds(status)).toEqual(fixture.expectedOpenItemIds);
      expect(status.signals).toEqual(fixture.expectedSignals);
      expect(selectMergeReadyBadgeId(status)).toBe(fixture.expectedBadge);
    },
  );

  it('does not emit review_pending when review is not required', async () => {
    const { exec, assertDone } = createFakeExec([
      ...createGitDiscoveryCalls(),
      createPullRequestViewSuccessCall(
        buildPullRequestPayload({
          reviews: [],
          reviewDecision: '',
        }),
      ),
      createConversationsSuccessCall(buildConversationsPayload()),
    ]);

    const status = await getMergeReadyStatus({
      exec,
      cwd: '/repo',
      now: () => new Date(GENERATED_AT),
    });

    assertDone();

    expect(status.state).toBe('ready');
    expect(status.summary).toBe('Ready to merge');
    expect(openItemIds(status)).toEqual([]);
    expect(status.signals.review).toBe('approved');
    expect(selectMergeReadyBadgeId(status)).toBe('ready');
  });

  it('keeps unresolved conversations separate when review is not required', async () => {
    const { exec, assertDone } = createFakeExec([
      ...createGitDiscoveryCalls(),
      createPullRequestViewSuccessCall(
        buildPullRequestPayload({
          reviews: [],
          reviewDecision: '',
        }),
      ),
      createConversationsSuccessCall(
        buildConversationsPayload({
          reviewThreads: {
            nodes: [{ isResolved: false }],
            pageInfo: { hasNextPage: false },
          },
        }),
      ),
    ]);

    const status = await getMergeReadyStatus({
      exec,
      cwd: '/repo',
      now: () => new Date(GENERATED_AT),
    });

    assertDone();

    expect(status.state).toBe('blocked');
    expect(status.summary).toBe('1 unresolved review conversation remains');
    expect(openItemIds(status)).toEqual(['unresolved_conversations']);
    expect(status.signals.review).toBe('approved');
    expect(status.signals.unresolvedConversations).toBe(true);
    expect(status.signals.unresolvedConversationCount).toBe(1);
    expect(status.signals.unresolvedConversationRequirement).toBe('required');
    expect(selectMergeReadyBadgeId(status)).toBe('unresolved_conversations');
  });

  it('treats known unresolved conversations as a blocker', async () => {
    const { exec, assertDone } = createFakeExec([
      ...createGitDiscoveryCalls(),
      createPullRequestViewSuccessCall(buildPullRequestPayload()),
      createConversationsSuccessCall(
        buildConversationsPayload({
          reviewThreads: {
            nodes: [{ isResolved: false }, { isResolved: false }],
            pageInfo: { hasNextPage: false },
          },
        }),
      ),
    ]);

    const status = await getMergeReadyStatus({
      exec,
      cwd: '/repo',
      now: () => new Date(GENERATED_AT),
    });

    assertDone();

    expect(status.state).toBe('blocked');
    expect(status.summary).toBe('2 unresolved review conversations remain');
    expect(openItemIds(status)).toEqual(['unresolved_conversations']);
    expect(status.signals.unresolvedConversations).toBe(true);
    expect(status.signals.unresolvedConversationCount).toBe(2);
    expect(status.signals.unresolvedConversationRequirement).toBe('required');
    expect(selectMergeReadyBadgeId(status)).toBe('unresolved_conversations');
  });

  it('keeps optional unresolved conversations out of blocker openItems', async () => {
    const { exec, assertDone } = createFakeExec([
      ...createGitDiscoveryCalls(),
      createPullRequestViewSuccessCall(buildPullRequestPayload()),
      createConversationsSuccessCall(
        buildConversationsPayload({
          reviewThreads: {
            nodes: [{ isResolved: false }, { isResolved: true }],
            pageInfo: { hasNextPage: false },
          },
          baseRef: {
            branchProtectionRule: {
              requiresConversationResolution: false,
            },
            rules: {
              nodes: [{ type: 'PULL_REQUEST' }],
              pageInfo: { hasNextPage: false },
            },
          },
        }),
      ),
    ]);

    const status = await getMergeReadyStatus({
      exec,
      cwd: '/repo',
      now: () => new Date(GENERATED_AT),
    });

    assertDone();

    expect(status.state).toBe('ready');
    expect(status.summary).toBe('Ready to merge');
    expect(openItemIds(status)).toEqual([]);
    expect(status.signals.unresolvedConversations).toBe(true);
    expect(status.signals.unresolvedConversationCount).toBe(1);
    expect(status.signals.unresolvedConversationRequirement).toBe('optional');
    expect(selectMergeReadyBadgeId(status)).toBe('ready');
  });

  it('returns ambiguous status when unresolved conversations are present but requirement is unknown', async () => {
    const { exec, assertDone } = createFakeExec([
      ...createGitDiscoveryCalls(),
      createPullRequestViewSuccessCall(buildPullRequestPayload()),
      createConversationsSuccessCall(
        buildConversationsPayload({
          reviewThreads: {
            nodes: [{ isResolved: false }],
            pageInfo: { hasNextPage: false },
          },
          baseRef: {
            branchProtectionRule: null,
            rules: {
              nodes: [{ type: 'PULL_REQUEST' }],
              pageInfo: { hasNextPage: true },
            },
          },
        }),
      ),
    ]);

    const status = await getMergeReadyStatus({
      exec,
      cwd: '/repo',
      now: () => new Date(GENERATED_AT),
    });

    assertDone();

    expect(status.state).toBe('unknown');
    expect(status.summary).toBe('Merge readiness is ambiguous');
    expect(openItemIds(status)).toEqual(['status_ambiguous']);
    expect(status.signals.unresolvedConversations).toBe(true);
    expect(status.signals.unresolvedConversationCount).toBe(1);
    expect(status.signals.unresolvedConversationRequirement).toBe('unknown');
    expect(selectMergeReadyBadgeId(status)).toBe('unknown');
  });

  it('suppresses generic merge_blocked when required unresolved conversations explain it', async () => {
    const { exec, assertDone } = createFakeExec([
      ...createGitDiscoveryCalls(),
      createPullRequestViewSuccessCall(
        buildPullRequestPayload({
          mergeStateStatus: 'BLOCKED',
        }),
      ),
      createConversationsSuccessCall(
        buildConversationsPayload({
          reviewThreads: {
            nodes: [{ isResolved: false }, { isResolved: false }],
            pageInfo: { hasNextPage: false },
          },
        }),
      ),
    ]);

    const status = await getMergeReadyStatus({
      exec,
      cwd: '/repo',
      now: () => new Date(GENERATED_AT),
    });

    assertDone();

    expect(status.state).toBe('blocked');
    expect(status.summary).toBe('2 unresolved review conversations remain');
    expect(openItemIds(status)).toEqual(['unresolved_conversations']);
    expect(status.signals.mergeability).toBe('blocked');
    expect(status.signals.unresolvedConversationRequirement).toBe('required');
    expect(selectMergeReadyBadgeId(status)).toBe('unresolved_conversations');
  });

  it('returns unknown status when not in a git repository', async () => {
    const { exec, assertDone } = createFakeExec([
      {
        command: 'git',
        args: ['rev-parse', '--show-toplevel'],
        cwd: '/repo',
        result: { code: 128, stderr: 'not a git repository\n' },
      },
    ]);

    const status = await getMergeReadyStatus({
      exec,
      cwd: '/repo',
      now: () => new Date(GENERATED_AT),
    });

    assertDone();

    expect(status.state).toBe('unknown');
    expect(status.pr).toBeNull();
    expect(status.summary).toBe('No pull request found');
    expect(openItemIds(status)).toEqual(['no_pull_request']);
  });

  it('returns unknown status when the remote is not GitHub', async () => {
    const { exec, assertDone } = createFakeExec([
      ...createGitDiscoveryCalls().map((call, index) =>
        index === 3
          ? {
              ...call,
              result: { stdout: 'git@gitlab.com:robhowley/pi-userland.git\n' },
            }
          : call,
      ),
    ]);

    const status = await getMergeReadyStatus({
      exec,
      cwd: '/repo',
      now: () => new Date(GENERATED_AT),
    });

    assertDone();

    expect(status.state).toBe('unknown');
    expect(status.pr).toBeNull();
  });

  it('returns no-PR status when gh pr view reports no PR', async () => {
    const { exec, assertDone } = createFakeExec([
      ...createGitDiscoveryCalls(),
      {
        command: 'gh',
        args: ['pr', 'view', '--json', GH_PR_VIEW_JSON_FIELDS],
        cwd: '/repo',
        result: {
          code: 1,
          stderr: 'no pull requests found for branch "feat/merge-ready"\n',
        },
      },
    ]);

    const status = await getMergeReadyStatus({
      exec,
      cwd: '/repo',
      now: () => new Date(GENERATED_AT),
    });

    assertDone();

    expect(status.state).toBe('unknown');
    expect(status.pr).toBeNull();
    expect(status.summary).toBe('No pull request found');
    expect(openItemIds(status)).toEqual(['no_pull_request']);
  });

  it('propagates thrown exec errors safely rather than crashing', async () => {
    const { exec, assertDone } = createFakeExec([
      ...createGitDiscoveryCalls(),
      {
        command: 'gh',
        args: ['pr', 'view', '--json', GH_PR_VIEW_JSON_FIELDS],
        cwd: '/repo',
        error: new Error('spawn gh ENOENT'),
      },
    ]);

    const status = await getMergeReadyStatus({
      exec,
      cwd: '/repo',
      now: () => new Date(GENERATED_AT),
    });

    assertDone();

    expect(status.state).toBe('unknown');
    expect(status.pr).toBeNull();
  });

  it('uses an optional cwd override when provided', async () => {
    const cwd = '/alternate-repo';
    const { exec, assertDone } = createFakeExec([
      ...createGitDiscoveryCalls({ cwd, repositoryRoot: cwd }),
      createPullRequestViewSuccessCall(buildPullRequestPayload(), { cwd }),
      createConversationsSuccessCall(buildConversationsPayload(), { cwd }),
    ]);

    const status = await getMergeReadyStatus({
      exec,
      cwd,
      now: () => new Date(GENERATED_AT),
    });

    assertDone();

    expect(status.pr?.number).toBe(42);
    expect(status.state).toBe('ready');
  });

  it('uses an optional timeout override when provided', async () => {
    const { exec, assertDone } = createFakeExec([
      ...createGitDiscoveryCalls({ timeout: 10_000 }),
      createPullRequestViewSuccessCall(buildPullRequestPayload(), { timeout: 10_000 }),
      createConversationsSuccessCall(buildConversationsPayload(), { timeout: 10_000 }),
    ]);

    const status = await getMergeReadyStatus({
      exec,
      cwd: '/repo',
      timeout: 10_000,
      now: () => new Date(GENERATED_AT),
    });

    assertDone();

    expect(status.state).toBe('ready');
  });

  it('respects an optional generatedAt override', async () => {
    const customGeneratedAt = '2026-01-01T00:00:00.000Z';
    const { exec, assertDone } = createFakeExec([
      ...createGitDiscoveryCalls(),
      createPullRequestViewSuccessCall(buildPullRequestPayload()),
      createConversationsSuccessCall(buildConversationsPayload()),
    ]);

    const status = await getMergeReadyStatus({
      exec,
      cwd: '/repo',
      generatedAt: customGeneratedAt,
    });

    assertDone();

    expect(status.generatedAt).toBe(customGeneratedAt);
  });

  it('respects an optional now clock override for generatedAt', async () => {
    const customNow = new Date('2026-12-25T12:00:00.000Z');
    const { exec, assertDone } = createFakeExec([
      ...createGitDiscoveryCalls(),
      createPullRequestViewSuccessCall(buildPullRequestPayload()),
      createConversationsSuccessCall(buildConversationsPayload()),
    ]);

    const status = await getMergeReadyStatus({
      exec,
      cwd: '/repo',
      now: () => customNow,
    });

    assertDone();

    expect(status.generatedAt).toBe(customNow.toISOString());
  });
});
