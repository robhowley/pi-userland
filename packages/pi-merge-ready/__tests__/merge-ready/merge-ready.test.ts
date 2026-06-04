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
  CURRENT_BRANCH_TARGET,
  GH_GRAPHQL_REVIEW_THREADS_QUERY,
  GH_PR_VIEW_JSON_FIELDS,
  buildConversationsPayload as buildOptionalConversationsPayload,
  buildPullRequestPayload,
  createConversationsSuccessCall,
  createFakeExec,
  createGitDiscoveryCalls,
  createPullRequestViewFailureCall,
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
const TARGETED_URL = 'https://github.com/shopify/pi/pull/64';
const TARGETED_URL_TARGET = {
  mode: 'url',
  url: TARGETED_URL,
  owner: 'shopify',
  repo: 'pi',
  prNumber: 64,
} as const;

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

function buildTargetedUrlAmbiguousStatus(summary: string) {
  return {
    state: 'unknown',
    target: TARGETED_URL_TARGET,
    pr: null,
    summary,
    openItems: [
      {
        id: 'status_ambiguous',
        summary,
      },
    ],
    signals: {
      draft: false,
      mergeability: 'unknown',
      checks: 'unknown',
      review: 'unknown',
      unresolvedConversations: false,
      unresolvedConversationRequirement: 'unknown',
    },
    generatedAt: GENERATED_AT,
  };
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
      checkDetails: {
        failing: [{ label: 'ci / unit', status: 'failing' }],
        running: [],
        unknown: [],
      },
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
      checkDetails: {
        failing: [],
        running: [{ label: 'ci / unit', status: 'running' }],
        unknown: [],
      },
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
      target: CURRENT_BRANCH_TARGET,
      pr: {
        lifecycle: 'open',
        number: 42,
        title: 'Compose merge-ready status boundary',
        url: 'https://github.com/robhowley/pi-userland/pull/42',
        headRefName: 'feat/merge-ready',
        baseRefName: 'main',
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
    expect(selectMergeReadyBadgeId(status)).toBe('ready');
  });

  it('supports URL mode without git discovery and carries fork head-repository identity through status', async () => {
    const url = 'https://github.com/shopify/pi/pull/64';
    const { exec, assertDone } = createFakeExec([
      createPullRequestViewSuccessCall(
        buildPullRequestPayload({
          number: 64,
          title: 'Support explicit PR URL targets',
          url,
          headRefName: 'feat/explicit-pr-url',
          headRepository: {
            name: 'pi-fork',
          },
          headRepositoryOwner: {
            login: 'contributor',
          },
          baseRefName: 'main',
        }),
        {
          cwd: '/repo',
          timeout: 5_000,
          target: {
            mode: 'url',
            url,
            owner: 'shopify',
            repo: 'pi',
            prNumber: 64,
          },
        },
      ),
      createConversationsSuccessCall(buildConversationsPayload(), {
        cwd: '/repo',
        timeout: 5_000,
        repositoryOwner: 'shopify',
        repositoryName: 'pi',
        pullRequestNumber: 64,
      }),
    ]);

    const status = await getMergeReadyStatus({
      exec,
      cwd: '/repo',
      url,
      timeout: 5_000,
      now: () => new Date(GENERATED_AT),
    });

    assertDone();

    expect(status).toMatchObject({
      state: 'ready',
      target: {
        mode: 'url',
        url,
        owner: 'shopify',
        repo: 'pi',
        prNumber: 64,
      },
      pr: {
        lifecycle: 'open',
        number: 64,
        title: 'Support explicit PR URL targets',
        url,
        headRefName: 'feat/explicit-pr-url',
        baseRefName: 'main',
        headRepository: {
          owner: 'contributor',
          repo: 'pi-fork',
        },
      },
      summary: 'Ready to merge',
      openItems: [],
    });
  });

  it('returns status_ambiguous for a targeted PR when GitHub omits head-repository identity', async () => {
    const { exec, assertDone } = createFakeExec([
      createPullRequestViewSuccessCall(
        buildPullRequestPayload({
          number: 64,
          title: 'Support explicit PR URL targets',
          url: TARGETED_URL,
          headRepository: null,
          headRepositoryOwner: null,
        }),
        {
          cwd: '/repo',
          target: TARGETED_URL_TARGET,
        },
      ),
    ]);

    const status = await getMergeReadyStatus({
      exec,
      cwd: '/repo',
      url: TARGETED_URL,
      now: () => new Date(GENERATED_AT),
    });

    assertDone();

    expect(status).toEqual(
      buildTargetedUrlAmbiguousStatus(
        'Unable to determine readiness for shopify/pi#64: GitHub CLI did not report head repository identity',
      ),
    );
  });

  it.each([
    {
      name: 'merged',
      lifecycle: 'merged' as const,
      state: 'MERGED',
      summary: 'PR is already merged',
    },
    {
      name: 'closed',
      lifecycle: 'closed' as const,
      state: 'CLOSED',
      summary: 'PR is closed',
    },
  ])(
    'returns URL-targeted terminal $name PRs without fetching conversations',
    async ({ lifecycle, state, summary }) => {
      const { exec, assertDone, getCalls } = createFakeExec([
        createPullRequestViewSuccessCall(
          buildPullRequestPayload({
            number: 64,
            title: 'Support explicit PR URL targets',
            url: TARGETED_URL,
            state,
            headRefName: 'feat/explicit-pr-url',
            baseRefName: 'main',
          }),
          {
            cwd: '/repo',
            timeout: 5_000,
            target: TARGETED_URL_TARGET,
          },
        ),
      ]);

      const status = await getMergeReadyStatus({
        exec,
        cwd: '/repo',
        url: TARGETED_URL,
        timeout: 5_000,
        now: () => new Date(GENERATED_AT),
      });

      assertDone();

      expect(status.target).toEqual(TARGETED_URL_TARGET);
      expect(status.pr).toMatchObject({
        lifecycle,
        number: 64,
        url: TARGETED_URL,
        headRefName: 'feat/explicit-pr-url',
        baseRefName: 'main',
      });
      expect(status.state).toBe('unknown');
      expect(status.summary).toBe(summary);
      expect(status.openItems).toEqual([]);
      expect(
        getCalls().some(
          (call) => call.command === 'gh' && call.args[0] === 'api' && call.args[1] === 'graphql',
        ),
      ).toBe(false);
    },
  );

  it('returns a structured not-found status for a valid targeted PR URL that does not exist', async () => {
    const url = 'https://github.com/shopify/pi/pull/64';
    const { exec, assertDone } = createFakeExec([
      createPullRequestViewFailureCall(
        {
          exitCode: 1,
          stderr: 'pull request not found\n',
        },
        {
          cwd: '/repo',
          target: {
            mode: 'url',
            url,
            owner: 'shopify',
            repo: 'pi',
            prNumber: 64,
          },
        },
      ),
    ]);

    const status = await getMergeReadyStatus({
      exec,
      cwd: '/repo',
      url,
      now: () => new Date(GENERATED_AT),
    });

    assertDone();

    expect(status).toEqual({
      state: 'unknown',
      target: {
        mode: 'url',
        url,
        owner: 'shopify',
        repo: 'pi',
        prNumber: 64,
      },
      pr: null,
      summary: 'Pull request not found: shopify/pi#64',
      openItems: [
        {
          id: 'no_pull_request',
          summary: 'Pull request not found: shopify/pi#64',
        },
      ],
      signals: {
        draft: false,
        mergeability: 'unknown',
        checks: 'unknown',
        review: 'unknown',
        unresolvedConversations: false,
        unresolvedConversationRequirement: 'unknown',
      },
      generatedAt: GENERATED_AT,
    });
  });

  it.each([
    {
      name: 'returns a repository access failure',
      call: createPullRequestViewFailureCall(
        {
          exitCode: 1,
          stderr: 'could not resolve to a repository with the name "shopify/pi"\n',
        },
        {
          cwd: '/repo',
          target: TARGETED_URL_TARGET,
        },
      ),
      expectedSummary:
        'Unable to determine readiness for shopify/pi#64: the repository or pull request is not accessible',
    },
    {
      name: 'returns an authentication failure',
      call: createPullRequestViewFailureCall(
        {
          exitCode: 1,
          stderr: 'authentication required; run gh auth login\n',
        },
        {
          cwd: '/repo',
          target: TARGETED_URL_TARGET,
        },
      ),
      expectedSummary:
        'Unable to determine readiness for shopify/pi#64: GitHub CLI authentication failed',
    },
    {
      name: 'returns an API failure',
      call: createPullRequestViewFailureCall(
        {
          exitCode: 1,
          stderr: 'GraphQL: Something went wrong\n',
        },
        {
          cwd: '/repo',
          target: TARGETED_URL_TARGET,
        },
      ),
      expectedSummary:
        'Unable to determine readiness for shopify/pi#64: the GitHub API request failed',
    },
    {
      name: 'returns invalid JSON',
      call: createPullRequestViewFailureCall(
        {
          stdout: '{ definitely not json',
        },
        {
          cwd: '/repo',
          target: TARGETED_URL_TARGET,
        },
      ),
      expectedSummary:
        'Unable to determine readiness for shopify/pi#64: GitHub CLI returned invalid JSON',
    },
    {
      name: 'returns an invalid pull request shape',
      call: createPullRequestViewSuccessCall(
        {
          state: 'OPEN',
        },
        {
          cwd: '/repo',
          target: TARGETED_URL_TARGET,
        },
      ),
      expectedSummary:
        'Unable to determine readiness for shopify/pi#64: GitHub CLI returned an unexpected pull request payload',
    },
  ])(
    'surfaces status_ambiguous for a targeted URL when GitHub PR discovery $name',
    async ({ call, expectedSummary }) => {
      const { exec, assertDone } = createFakeExec([call]);

      const status = await getMergeReadyStatus({
        exec,
        cwd: '/repo',
        url: TARGETED_URL,
        now: () => new Date(GENERATED_AT),
      });

      assertDone();

      expect(status).toEqual(buildTargetedUrlAmbiguousStatus(expectedSummary));
    },
  );

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

  it('attaches blocking review deep links to the changes_requested open item', async () => {
    const { exec, assertDone } = createFakeExec([
      ...createGitDiscoveryCalls(),
      createPullRequestViewSuccessCall(
        buildPullRequestPayload({
          reviews: [
            {
              author: { login: 'reviewer1' },
              state: 'CHANGES_REQUESTED',
              submittedAt: '2026-05-26T20:00:00Z',
            },
          ],
          reviewDecision: 'CHANGES_REQUESTED',
        }),
      ),
      createConversationsSuccessCall(
        buildConversationsPayload({
          latestOpinionatedReviews: {
            nodes: [
              {
                author: { login: 'reviewer1' },
                state: 'CHANGES_REQUESTED',
                submittedAt: '2026-05-26T20:00:00Z',
                url: 'https://github.com/robhowley/pi-userland/pull/42#pullrequestreview-1',
              },
            ],
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

    expect(status.openItems).toEqual([
      {
        id: 'changes_requested',
        summary: 'Changes requested by reviewers',
        details: [
          {
            label: 'reviewer1 requested changes',
            url: 'https://github.com/robhowley/pi-userland/pull/42#pullrequestreview-1',
          },
        ],
      },
    ]);
  });

  it('attaches unresolved conversation deep links to the unresolved_conversations open item', async () => {
    const { exec, assertDone } = createFakeExec([
      ...createGitDiscoveryCalls(),
      createPullRequestViewSuccessCall(buildPullRequestPayload()),
      createConversationsSuccessCall(
        buildConversationsPayload({
          reviewThreads: {
            nodes: [
              {
                isResolved: false,
                path: 'src/feature.ts',
                line: 12,
                comments: {
                  nodes: [
                    {
                      url: 'https://github.com/robhowley/pi-userland/pull/42#discussion_r1',
                      path: 'src/feature.ts',
                      line: 12,
                    },
                  ],
                },
              },
            ],
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

    expect(status.openItems).toEqual([
      {
        id: 'unresolved_conversations',
        summary: '1 unresolved review conversation remains',
        details: [
          {
            label: 'src/feature.ts:12 unresolved conversation',
            url: 'https://github.com/robhowley/pi-userland/pull/42#discussion_r1',
          },
        ],
      },
    ]);
  });

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

  it('rejects invalid explicit URL targets instead of degrading to unknown status', async () => {
    const { exec } = createFakeExec([]);

    await expect(
      getMergeReadyStatus({
        exec,
        cwd: '/repo',
        url: '64',
        now: () => new Date(GENERATED_AT),
      }),
    ).rejects.toThrow('Pass a full HTTPS GitHub pull request URL');
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
