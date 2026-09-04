import { describe, expect, it } from 'vitest';
import { createGitHubProvider } from '../../extensions/merge-ready/github-provider.js';
import {
  REQUESTED_REVIEWER_SCENARIO,
  buildConversationsPayload,
  buildPullRequestPayload,
  createConversationsSuccessCall,
  createFakeExec,
  createPullRequestViewFailureCall,
  createPullRequestViewSuccessCall,
  createRequiredChecksCall,
  PR_62_NO_REQUIRED_CHECKS_RESULT,
  PR_62_RUNNING_ROLLUP,
} from './test-fixtures.js';

const TARGET = {
  url: 'https://github.com/shopify/pi/pull/64',
  owner: 'shopify',
  repo: 'pi',
  prNumber: 64,
} as const;

const AMBIENT = {
  mode: 'ambient' as const,
  remote: { name: 'origin', url: 'git@github.com:robhowley/pi-userland.git' },
  repository: { owner: 'robhowley', repo: 'pi-userland' },
  cwd: '/repo',
  timeoutMs: 20_000,
};

describe('merge-ready GitHub provider', () => {
  it('returns normalized signals and real supporting evidence', async () => {
    const { exec, assertDone } = createFakeExec([
      createPullRequestViewSuccessCall(
        buildPullRequestPayload(REQUESTED_REVIEWER_SCENARIO.pullRequestOverrides),
        { timeout: 20_000 },
      ),
      createConversationsSuccessCall(
        buildConversationsPayload({
          latestOpinionatedReviews: {
            nodes: [
              {
                author: { login: 'reviewer1' },
                state: 'CHANGES_REQUESTED',
                submittedAt: '2026-05-26T20:00:00Z',
                url: 'https://github.com/robhowley/pi-userland/pull/42#pullrequestreview-7',
              },
            ],
          },
          reviewThreads: {
            nodes: [
              {
                isResolved: false,
                path: 'src/provider.ts',
                line: 24,
                comments: {
                  nodes: [
                    {
                      url: 'https://github.com/robhowley/pi-userland/pull/42#discussion_r9',
                      path: 'src/provider.ts',
                      line: 24,
                    },
                  ],
                },
              },
            ],
            pageInfo: { hasNextPage: false },
          },
          baseRef: {
            branchProtectionRule: { requiresConversationResolution: true },
            rules: { nodes: [], pageInfo: { hasNextPage: false } },
          },
        }),
        { timeout: 20_000 },
      ),
    ]);

    const result = await createGitHubProvider(exec).read(AMBIENT);
    assertDone();
    expect(result).toMatchObject({
      kind: 'found',
      pullRequest: { lifecycle: 'open', number: 42 },
      signals: {
        draft: false,
        mergeability: 'mergeable',
        checks: 'passing',
        review: 'pending',
        unresolvedConversations: true,
        unresolvedConversationCount: 1,
        unresolvedConversationRequirement: 'required',
      },
      evidence: {
        reviewPending: [{ label: '@alice' }, { label: 'team/core-reviewers' }],
        changesRequested: [{ label: 'reviewer1 requested changes' }],
        unresolvedConversations: [{ label: 'src/provider.ts:24 unresolved conversation' }],
      },
    });
    expect(JSON.stringify(result)).not.toContain('Unresolved conversation"');
    expect(JSON.stringify(result)).not.toContain('openItems');
  });

  it('ignores failed and unknown optional rollup checks when no required checks exist', async () => {
    const { exec, assertDone } = createFakeExec([
      createPullRequestViewSuccessCall(
        buildPullRequestPayload({
          mergeStateStatus: 'UNSTABLE',
          statusCheckRollup: [
            {
              workflowName: 'optional',
              name: 'preview',
              status: 'COMPLETED',
              conclusion: 'FAILURE',
            },
            {
              workflowName: 'optional',
              name: 'experimental',
              status: 'COMPLETED',
              conclusion: 'FUTURE_CONCLUSION',
            },
          ],
        }),
        { timeout: 20_000, requiredChecksResult: PR_62_NO_REQUIRED_CHECKS_RESULT },
      ),
      createConversationsSuccessCall(buildConversationsPayload(), { timeout: 20_000 }),
    ]);

    const result = await createGitHubProvider(exec).read(AMBIENT);
    assertDone();
    expect(result).toMatchObject({
      kind: 'found',
      signals: { mergeability: 'mergeable', checks: 'passing' },
    });
    expect(JSON.stringify(result)).not.toContain('optional / preview');
    expect(JSON.stringify(result)).not.toContain('optional / experimental');
    expect(result).not.toHaveProperty('issues');
    expect(result).not.toHaveProperty('openItems');
  });

  it('uses running rollup rows when PR 62 has no required checks', async () => {
    const { exec, assertDone } = createFakeExec([
      createPullRequestViewSuccessCall(
        buildPullRequestPayload({
          number: 62,
          title: 'Fix stale integer epoch handling',
          url: 'https://github.com/robhowley/pi-userland/pull/62',
          headRefName: 'fix/okf-search-native-integer-stale-epoch',
          statusCheckRollup: PR_62_RUNNING_ROLLUP,
        }),
        {
          timeout: 20_000,
          requiredChecksResult: PR_62_NO_REQUIRED_CHECKS_RESULT,
        },
      ),
      createConversationsSuccessCall(buildConversationsPayload(), {
        timeout: 20_000,
        pullRequestNumber: 62,
      }),
    ]);

    const result = await createGitHubProvider(exec).read(AMBIENT);
    assertDone();
    expect(result).toMatchObject({
      kind: 'found',
      pullRequest: { number: 62 },
      signals: {
        checks: 'running',
        checkDetails: {
          failing: [],
          running: [
            {
              label: 'ci / unit',
              status: 'running',
              url: 'https://github.example/checks/unit',
            },
            {
              label: 'ci / lint',
              status: 'running',
              url: 'https://github.example/checks/lint',
            },
            {
              label: 'ci / integration',
              status: 'running',
              url: 'https://github.example/checks/integration',
            },
          ],
          unknown: [],
        },
      },
    });
    expect(result).not.toHaveProperty('issues');
  });

  it.each([
    {
      name: 'failed',
      exitCode: 1,
      bucket: 'fail',
      state: 'FAILURE',
      expectedSignal: 'failing',
      expectedStatus: 'failing',
    },
    {
      name: 'running',
      exitCode: 8,
      bucket: 'pending',
      state: 'IN_PROGRESS',
      expectedSignal: 'running',
      expectedStatus: 'running',
    },
  ])('uses only $name required-check rows for check signals and details', async (fixture) => {
    const { exec, assertDone } = createFakeExec([
      createPullRequestViewSuccessCall(
        buildPullRequestPayload({
          statusCheckRollup: [
            {
              workflowName: 'optional',
              name: 'preview',
              status: 'COMPLETED',
              conclusion: 'FAILURE',
            },
          ],
        }),
        { timeout: 20_000 },
      ),
      createRequiredChecksCall(
        {
          stdout: JSON.stringify([
            {
              name: 'required / unit',
              bucket: fixture.bucket,
              state: fixture.state,
              link: 'https://github.example/checks/required',
            },
          ]),
          exitCode: fixture.exitCode,
        },
        { timeout: 20_000 },
      ),
      createConversationsSuccessCall(buildConversationsPayload(), { timeout: 20_000 }),
    ]);

    const result = await createGitHubProvider(exec).read(AMBIENT);
    assertDone();
    expect(result).toMatchObject({
      kind: 'found',
      signals: {
        checks: fixture.expectedSignal,
        checkDetails: {
          [fixture.expectedStatus]: [
            {
              label: 'required / unit',
              status: fixture.expectedStatus,
              url: 'https://github.example/checks/required',
            },
          ],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('optional / preview');
  });

  it('returns unknown checks and an issue when the required query is malformed', async () => {
    const { exec, assertDone } = createFakeExec([
      createPullRequestViewSuccessCall(buildPullRequestPayload(), { timeout: 20_000 }),
      createRequiredChecksCall({ stdout: '{bad json' }, { timeout: 20_000 }),
      createConversationsSuccessCall(buildConversationsPayload(), { timeout: 20_000 }),
    ]);

    const result = await createGitHubProvider(exec).read(AMBIENT);
    assertDone();
    expect(result).toMatchObject({
      kind: 'found',
      signals: { checks: 'unknown' },
      issues: ['GitHub CLI returned invalid JSON for required checks'],
    });
  });

  it('retains malformed normalized fields as issue strings', async () => {
    const { exec, assertDone } = createFakeExec([
      createPullRequestViewSuccessCall(buildPullRequestPayload({ isDraft: 'bad' }), {
        timeout: 20_000,
      }),
      createConversationsSuccessCall(buildConversationsPayload(), { timeout: 20_000 }),
    ]);
    const result = await createGitHubProvider(exec).read(AMBIENT);
    assertDone();
    expect(result).toMatchObject({
      kind: 'found',
      signals: { draft: false, checks: 'passing' },
      issues: ['gh pr view JSON payload had an invalid draft flag'],
    });
  });

  it('distinguishes absent and unavailable URL reads', async () => {
    const absent = createFakeExec([
      createPullRequestViewFailureCall(
        { exitCode: 1, stderr: 'pull request not found\n' },
        { target: { mode: 'url', ...TARGET }, timeout: 20_000 },
      ),
    ]);
    const unavailable = createFakeExec([
      createPullRequestViewFailureCall(
        { exitCode: 1, stderr: 'authentication required; run gh auth login\n' },
        { target: { mode: 'url', ...TARGET }, timeout: 20_000 },
      ),
    ]);
    await expect(
      createGitHubProvider(absent.exec).read({
        mode: 'url',
        target: TARGET,
        cwd: '/repo',
        timeoutMs: 20_000,
      }),
    ).resolves.toEqual({ kind: 'absent' });
    await expect(
      createGitHubProvider(unavailable.exec).read({
        mode: 'url',
        target: TARGET,
        cwd: '/repo',
        timeoutMs: 20_000,
      }),
    ).resolves.toEqual({
      kind: 'unavailable',
      presence: 'unknown',
      message: 'GitHub CLI authentication failed',
    });
    absent.assertDone();
    unavailable.assertDone();
  });
});
