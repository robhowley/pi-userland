import { describe, expect, it } from 'vitest';
import {
  fetchMergeReadyGitHubPullRequestFacts,
  type MergeReadyExec,
  type MergeReadyExecResult,
} from '../../extensions/merge-ready/index.js';

type ExpectedExecCall = {
  command: string;
  args: string[];
  cwd?: string;
  timeout?: number;
  result?: MergeReadyExecResult;
  error?: unknown;
};

const GH_PR_VIEW_JSON_FIELDS =
  'number,title,url,state,isDraft,mergeable,mergeStateStatus,headRefName,headRepository,headRepositoryOwner,baseRefName,statusCheckRollup,reviews,reviewDecision,reviewRequests,author';

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

function buildPullRequestPayload(overrides: Record<string, unknown> = {}) {
  return {
    number: 42,
    title: 'Normalize merge-ready GitHub facts',
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
      {
        __typename: 'StatusContext',
        context: 'lint',
        state: 'SUCCESS',
      },
    ],
    reviews: [
      {
        author: { login: 'reviewer1' },
        state: 'APPROVED',
        submittedAt: '2026-05-26T18:00:00Z',
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

describe('merge-ready GitHub primitives', () => {
  it('normalizes a ready-ish pull request', async () => {
    const { exec, assertDone } = createFakeExec([
      {
        command: 'gh',
        args: ['pr', 'view', '--json', GH_PR_VIEW_JSON_FIELDS],
        cwd: '/repo',
        timeout: 5_000,
        result: {
          stdout: `${JSON.stringify(buildPullRequestPayload())}\n`,
        },
      },
    ]);

    const facts = await fetchMergeReadyGitHubPullRequestFacts({
      exec,
      cwd: '/repo',
      timeout: 5_000,
    });

    assertDone();

    expect(facts).toEqual({
      kind: 'found',
      integrity: 'complete',
      pullRequest: {
        lifecycle: 'open',
        number: 42,
        title: 'Normalize merge-ready GitHub facts',
        url: 'https://github.com/robhowley/pi-userland/pull/42',
        headRefName: 'feat/merge-ready',
        baseRefName: 'main',
        headRepository: {
          owner: 'robhowley',
          repo: 'pi-userland',
        },
        draft: 'no',
        mergeability: 'mergeable',
        checks: {
          state: 'passing',
          totalCount: 2,
          passingCount: 2,
          failingCount: 0,
          runningCount: 0,
          unknownCount: 0,
          names: {
            passing: ['ci / unit', 'lint'],
            failing: [],
            running: [],
            unknown: [],
          },
          details: {
            failing: [],
            running: [],
            unknown: [],
          },
        },
        reviews: {
          state: 'approved',
          totalCount: 1,
          latestByAuthorCount: 1,
          latestByAuthor: [
            {
              author: 'reviewer1',
              state: 'approved',
              submittedAt: '2026-05-26T18:00:00Z',
            },
          ],
        },
        reviewDecision: 'approved',
        reviewRequests: {
          kind: 'known',
          count: 0,
          requests: [],
        },
        author: {
          login: 'robhowley',
          name: 'Robert Howley',
          isBot: false,
        },
      },
      issues: [],
    });
  });

  it('returns a typed no-pr outcome', async () => {
    const { exec, assertDone } = createFakeExec([
      {
        command: 'gh',
        args: ['pr', 'view', '--json', GH_PR_VIEW_JSON_FIELDS],
        cwd: '/repo',
        result: {
          exitCode: 1,
          stderr: 'no pull requests found for branch "feature/no-pr"\n',
        },
      },
    ]);

    const facts = await fetchMergeReadyGitHubPullRequestFacts({ exec, cwd: '/repo' });

    assertDone();

    expect(facts.kind).toBe('no_pr');
    expect(facts.issues).toHaveLength(1);
    expect(facts.issues[0]).toMatchObject({
      code: 'non_zero_exit',
      cwd: '/repo',
      exitCode: 1,
    });
  });

  it('uses explicit gh pr view targeting and normalizes fork head-repository identity', async () => {
    const { exec, assertDone } = createFakeExec([
      {
        command: 'gh',
        args: ['pr', 'view', '64', '--repo', 'shopify/pi', '--json', GH_PR_VIEW_JSON_FIELDS],
        cwd: '/repo',
        timeout: 5_000,
        result: {
          stdout: `${JSON.stringify(
            buildPullRequestPayload({
              number: 64,
              title: 'Support explicit PR URL targets',
              url: 'https://github.com/shopify/pi/pull/64',
              headRepository: {
                name: 'pi-fork',
              },
              headRepositoryOwner: {
                login: 'contributor',
              },
            }),
          )}\n`,
        },
      },
    ]);

    const facts = await fetchMergeReadyGitHubPullRequestFacts({
      exec,
      cwd: '/repo',
      timeout: 5_000,
      target: {
        mode: 'url',
        url: 'https://github.com/shopify/pi/pull/64',
        owner: 'shopify',
        repo: 'pi',
        prNumber: 64,
      },
    });

    assertDone();

    expect(facts).toMatchObject({
      kind: 'found',
      pullRequest: {
        number: 64,
        url: 'https://github.com/shopify/pi/pull/64',
        headRepository: {
          owner: 'contributor',
          repo: 'pi-fork',
        },
      },
    });
  });

  it('returns a typed not_found outcome for a valid targeted PR URL that does not exist', async () => {
    const { exec, assertDone } = createFakeExec([
      {
        command: 'gh',
        args: ['pr', 'view', '64', '--repo', 'shopify/pi', '--json', GH_PR_VIEW_JSON_FIELDS],
        cwd: '/repo',
        result: {
          exitCode: 1,
          stderr: 'pull request not found\n',
        },
      },
    ]);

    const facts = await fetchMergeReadyGitHubPullRequestFacts({
      exec,
      cwd: '/repo',
      target: {
        mode: 'url',
        url: 'https://github.com/shopify/pi/pull/64',
        owner: 'shopify',
        repo: 'pi',
        prNumber: 64,
      },
    });

    assertDone();

    expect(facts.kind).toBe('not_found');
  });

  it('classifies targeted repository access failures separately from generic command failures', async () => {
    const { exec, assertDone } = createFakeExec([
      {
        command: 'gh',
        args: ['pr', 'view', '64', '--repo', 'shopify/pi', '--json', GH_PR_VIEW_JSON_FIELDS],
        cwd: '/repo',
        result: {
          exitCode: 1,
          stderr: 'could not resolve to a repository with the name "shopify/pi"\n',
        },
      },
    ]);

    const facts = await fetchMergeReadyGitHubPullRequestFacts({
      exec,
      cwd: '/repo',
      target: {
        mode: 'url',
        url: 'https://github.com/shopify/pi/pull/64',
        owner: 'shopify',
        repo: 'pi',
        prNumber: 64,
      },
    });

    assertDone();

    expect(facts).toMatchObject({
      kind: 'failure',
      reason: 'access',
    });
  });

  it('normalizes draft pull requests without exposing GitHub enums', async () => {
    const { exec, assertDone } = createFakeExec([
      {
        command: 'gh',
        args: ['pr', 'view', '--json', GH_PR_VIEW_JSON_FIELDS],
        result: {
          stdout: JSON.stringify(
            buildPullRequestPayload({
              isDraft: true,
              mergeStateStatus: 'DRAFT',
              reviewDecision: 'REVIEW_REQUIRED',
              reviewRequests: [{ __typename: 'User', login: 'babakks' }],
              reviews: [],
            }),
          ),
        },
      },
    ]);

    const facts = await fetchMergeReadyGitHubPullRequestFacts({ exec });

    assertDone();

    expect(facts.kind).toBe('found');
    if (facts.kind !== 'found') {
      return;
    }

    expect(facts.pullRequest.draft).toBe('yes');
    expect(facts.pullRequest.mergeability).toBe('blocked');
    expect(facts.pullRequest.reviews.state).toBe('pending');
    expect(facts.pullRequest.reviewDecision).toBe('review_required');
    expect(facts.pullRequest.reviewRequests).toEqual({
      kind: 'known',
      count: 1,
      requests: [{ type: 'user', name: 'babakks' }],
    });
  });

  it.each([
    {
      name: 'MERGEABLE + CLEAN',
      overrides: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
      expected: 'mergeable',
    },
    {
      name: 'MERGEABLE + DIRTY',
      overrides: { mergeable: 'MERGEABLE', mergeStateStatus: 'DIRTY' },
      expected: 'conflicting',
    },
    {
      name: 'MERGEABLE + UNKNOWN',
      overrides: { mergeable: 'MERGEABLE', mergeStateStatus: 'UNKNOWN' },
      expected: 'unknown',
    },
    {
      name: 'MERGEABLE + BLOCKED',
      overrides: { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' },
      expected: 'blocked',
    },
    {
      name: 'MERGEABLE + BEHIND',
      overrides: { mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' },
      expected: 'behind',
    },
    {
      name: 'MERGEABLE + UNSTABLE',
      overrides: { mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE' },
      expected: 'blocked',
    },
    {
      name: 'MERGEABLE + HAS_HOOKS',
      overrides: { mergeable: 'MERGEABLE', mergeStateStatus: 'HAS_HOOKS' },
      expected: 'blocked',
    },
    {
      name: 'MERGEABLE + DRAFT',
      overrides: { mergeable: 'MERGEABLE', mergeStateStatus: 'DRAFT' },
      expected: 'blocked',
    },
    {
      name: 'CONFLICTING + CLEAN',
      overrides: { mergeable: 'CONFLICTING', mergeStateStatus: 'CLEAN' },
      expected: 'conflicting',
    },
    {
      name: 'CONFLICTING + BEHIND still conflicts',
      overrides: { mergeable: 'CONFLICTING', mergeStateStatus: 'BEHIND' },
      expected: 'conflicting',
    },
    {
      name: 'UNKNOWN + CLEAN',
      overrides: { mergeable: 'UNKNOWN', mergeStateStatus: 'CLEAN' },
      expected: 'unknown',
    },
    {
      name: 'UNKNOWN + DIRTY still conflicts',
      overrides: { mergeable: 'UNKNOWN', mergeStateStatus: 'DIRTY' },
      expected: 'conflicting',
    },
    {
      name: 'missing mergeable field',
      overrides: { mergeable: null },
      expected: 'unknown',
    },
    {
      name: 'missing mergeStateStatus field',
      overrides: { mergeStateStatus: null },
      expected: 'unknown',
    },
    {
      name: 'future mergeable enum',
      overrides: { mergeable: 'REBASEABLE', mergeStateStatus: 'CLEAN' },
      expected: 'blocked',
    },
    {
      name: 'future mergeStateStatus enum',
      overrides: { mergeable: 'MERGEABLE', mergeStateStatus: 'REBASEABLE' },
      expected: 'blocked',
    },
  ])('normalizes mergeability for $name', async ({ overrides, expected }) => {
    const { exec, assertDone } = createFakeExec([
      {
        command: 'gh',
        args: ['pr', 'view', '--json', GH_PR_VIEW_JSON_FIELDS],
        result: {
          stdout: JSON.stringify(buildPullRequestPayload(overrides)),
        },
      },
    ]);

    const facts = await fetchMergeReadyGitHubPullRequestFacts({ exec });

    assertDone();

    expect(facts.kind).toBe('found');
    if (facts.kind !== 'found') {
      return;
    }

    expect(facts.pullRequest.mergeability).toBe(expected);
  });

  it.each([
    {
      name: 'failing checks',
      statusCheckRollup: [
        {
          __typename: 'CheckRun',
          workflowName: 'ci',
          name: 'unit',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          detailsUrl: 'https://github.example/checks/unit',
        },
        {
          __typename: 'StatusContext',
          context: 'lint',
          state: 'PENDING',
          targetUrl: 'https://github.example/status/lint',
        },
      ],
      expectedState: 'failing',
      expectedNames: {
        failing: ['ci / unit'],
        running: ['lint'],
      },
      expectedDetails: {
        failing: [
          {
            label: 'ci / unit',
            status: 'failing',
            url: 'https://github.example/checks/unit',
          },
        ],
        running: [
          {
            label: 'lint',
            status: 'running',
            url: 'https://github.example/status/lint',
          },
        ],
        unknown: [],
      },
    },
    {
      name: 'running checks',
      statusCheckRollup: [
        {
          __typename: 'CheckRun',
          workflowName: 'ci',
          name: 'unit',
          status: 'IN_PROGRESS',
          detailsUrl: 'https://github.example/checks/unit',
        },
        {
          __typename: 'StatusContext',
          context: 'lint',
          state: 'SUCCESS',
        },
      ],
      expectedState: 'running',
      expectedNames: {
        failing: [],
        running: ['ci / unit'],
      },
      expectedDetails: {
        failing: [],
        running: [
          {
            label: 'ci / unit',
            status: 'running',
            url: 'https://github.example/checks/unit',
          },
        ],
        unknown: [],
      },
    },
  ])(
    'normalizes $name',
    async ({ statusCheckRollup, expectedState, expectedNames, expectedDetails }) => {
      const { exec, assertDone } = createFakeExec([
        {
          command: 'gh',
          args: ['pr', 'view', '--json', GH_PR_VIEW_JSON_FIELDS],
          result: {
            stdout: JSON.stringify(buildPullRequestPayload({ statusCheckRollup })),
          },
        },
      ]);

      const facts = await fetchMergeReadyGitHubPullRequestFacts({ exec });

      assertDone();

      expect(facts.kind).toBe('found');
      if (facts.kind !== 'found') {
        return;
      }

      expect(facts.pullRequest.checks.state).toBe(expectedState);
      expect(facts.pullRequest.checks.names.failing).toEqual(expectedNames.failing);
      expect(facts.pullRequest.checks.names.running).toEqual(expectedNames.running);
      expect(facts.pullRequest.checks.details).toEqual(expectedDetails);
    },
  );

  it.each([
    {
      name: 'approved',
      reviewDecision: 'APPROVED',
      expected: 'approved',
    },
    {
      name: 'changes requested',
      reviewDecision: 'CHANGES_REQUESTED',
      expected: 'changes_requested',
    },
    {
      name: 'review required',
      reviewDecision: 'REVIEW_REQUIRED',
      expected: 'review_required',
    },
    {
      name: 'not required',
      reviewDecision: '',
      expected: 'not_required',
    },
  ])('normalizes review decision when $name', async ({ reviewDecision, expected }) => {
    const { exec, assertDone } = createFakeExec([
      {
        command: 'gh',
        args: ['pr', 'view', '--json', GH_PR_VIEW_JSON_FIELDS],
        result: {
          stdout: JSON.stringify(buildPullRequestPayload({ reviewDecision, reviews: [] })),
        },
      },
    ]);

    const facts = await fetchMergeReadyGitHubPullRequestFacts({ exec });

    assertDone();

    expect(facts.kind).toBe('found');
    if (facts.kind !== 'found') {
      return;
    }

    expect(facts.pullRequest.reviewDecision).toBe(expected);
  });

  it('uses the latest review per author so changes requested beat stale approvals', async () => {
    const { exec, assertDone } = createFakeExec([
      {
        command: 'gh',
        args: ['pr', 'view', '--json', GH_PR_VIEW_JSON_FIELDS],
        result: {
          stdout: JSON.stringify(
            buildPullRequestPayload({
              reviews: [
                {
                  author: { login: 'alice' },
                  state: 'CHANGES_REQUESTED',
                  submittedAt: '2026-05-26T20:00:00Z',
                },
                {
                  author: { login: 'alice' },
                  state: 'APPROVED',
                  submittedAt: '2026-05-26T19:00:00Z',
                },
                {
                  author: { login: 'bob' },
                  state: 'APPROVED',
                  submittedAt: '2026-05-26T18:30:00Z',
                },
              ],
            }),
          ),
        },
      },
    ]);

    const facts = await fetchMergeReadyGitHubPullRequestFacts({ exec });

    assertDone();

    expect(facts.kind).toBe('found');
    if (facts.kind !== 'found') {
      return;
    }

    expect(facts.pullRequest.reviews).toEqual({
      state: 'changes_requested',
      totalCount: 3,
      latestByAuthorCount: 2,
      latestByAuthor: [
        {
          author: 'alice',
          state: 'changes_requested',
          submittedAt: '2026-05-26T20:00:00Z',
        },
        {
          author: 'bob',
          state: 'approved',
          submittedAt: '2026-05-26T18:30:00Z',
        },
      ],
    });
  });

  it('returns invalid_json when gh succeeds with malformed output', async () => {
    const { exec, assertDone } = createFakeExec([
      {
        command: 'gh',
        args: ['pr', 'view', '--json', GH_PR_VIEW_JSON_FIELDS],
        result: {
          stdout: '{ definitely not json',
        },
      },
    ]);

    const facts = await fetchMergeReadyGitHubPullRequestFacts({ exec });

    assertDone();

    expect(facts.kind).toBe('invalid_json');
    expect(facts.issues[0]).toMatchObject({
      code: 'invalid_json',
    });
  });

  it('returns invalid_shape when the payload is missing core PR fields', async () => {
    const { exec, assertDone } = createFakeExec([
      {
        command: 'gh',
        args: ['pr', 'view', '--json', GH_PR_VIEW_JSON_FIELDS],
        result: {
          stdout: JSON.stringify({ state: 'OPEN' }),
        },
      },
    ]);

    const facts = await fetchMergeReadyGitHubPullRequestFacts({ exec });

    assertDone();

    expect(facts.kind).toBe('invalid_shape');
    expect(facts.issues.map((issue) => issue.field)).toEqual([
      'headRepositoryOwner',
      'number',
      'title',
      'url',
      'headRefName',
      'baseRefName',
    ]);
  });

  it.each([
    {
      name: 'auth failures',
      expectedReason: 'auth',
      result: {
        exitCode: 4,
        stderr: 'To get started with GitHub CLI, please run:  gh auth login\n',
      } satisfies MergeReadyExecResult,
    },
    {
      name: 'api failures',
      expectedReason: 'api',
      result: {
        exitCode: 1,
        stderr: 'GraphQL: Something went wrong\n',
      } satisfies MergeReadyExecResult,
    },
  ])('returns a typed failure for $name', async ({ expectedReason, result }) => {
    const { exec, assertDone } = createFakeExec([
      {
        command: 'gh',
        args: ['pr', 'view', '--json', GH_PR_VIEW_JSON_FIELDS],
        result,
      },
    ]);

    const facts = await fetchMergeReadyGitHubPullRequestFacts({ exec });

    assertDone();

    expect(facts).toMatchObject({
      kind: 'failure',
      reason: expectedReason,
    });
  });

  it('returns a command failure when exec throws', async () => {
    const { exec, assertDone } = createFakeExec([
      {
        command: 'gh',
        args: ['pr', 'view', '--json', GH_PR_VIEW_JSON_FIELDS],
        error: new Error('spawn gh ENOENT'),
      },
    ]);

    const facts = await fetchMergeReadyGitHubPullRequestFacts({ exec });

    assertDone();

    expect(facts).toMatchObject({
      kind: 'failure',
      reason: 'command',
    });
    expect(facts.issues[0]).toMatchObject({
      code: 'threw',
    });
  });
});
