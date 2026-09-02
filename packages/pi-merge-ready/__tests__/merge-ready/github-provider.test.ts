import { describe, expect, it } from 'vitest';
import { githubProvider } from '../../extensions/merge-ready/github-provider.js';
import {
  REQUESTED_REVIEWER_SCENARIO,
  buildConversationsPayload,
  buildPullRequestPayload,
  createConversationsSuccessCall,
  createFakeExec,
  createPullRequestViewFailureCall,
  createPullRequestViewSuccessCall,
} from './test-fixtures.js';

const TARGET = {
  mode: 'url',
  url: 'https://github.com/shopify/pi/pull/64',
  owner: 'shopify',
  repo: 'pi',
  prNumber: 64,
} as const;

describe('merge-ready GitHub provider', () => {
  it('composes normalized PR signals and supporting evidence without returning openItems', async () => {
    const { exec, assertDone } = createFakeExec([
      createPullRequestViewSuccessCall(
        buildPullRequestPayload(REQUESTED_REVIEWER_SCENARIO.pullRequestOverrides),
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
      ),
    ]);

    const result = await githubProvider.read({
      mode: 'ambient',
      repository: { owner: 'robhowley', repo: 'pi-userland' },
      exec,
      cwd: '/repo',
    });

    assertDone();

    expect(result).toMatchObject({
      kind: 'found',
      snapshot: {
        pullRequest: {
          lifecycle: 'open',
          number: 42,
          title: 'Compose merge-ready status boundary',
          url: 'https://github.com/robhowley/pi-userland/pull/42',
          headRefName: 'feat/merge-ready',
          baseRefName: 'main',
        },
        signals: {
          draft: false,
          mergeability: 'mergeable',
          checks: 'passing',
          review: 'pending',
          unresolvedConversations: true,
          unresolvedConversationCount: 1,
          unresolvedConversationRequirement: 'required',
        },
        supportingEvidence: {
          reviewPending: [{ label: '@alice' }, { label: 'team/core-reviewers' }],
          changesRequested: [
            {
              label: 'reviewer1 requested changes',
              url: 'https://github.com/robhowley/pi-userland/pull/42#pullrequestreview-7',
            },
          ],
          unresolvedConversations: [
            {
              label: 'src/provider.ts:24 unresolved conversation',
              url: 'https://github.com/robhowley/pi-userland/pull/42#discussion_r9',
            },
          ],
        },
        integrityIssues: [],
      },
    });
    expect(JSON.stringify(result)).not.toContain('"openItems"');
  });

  it('keeps complete signals while retaining malformed readiness facts as integrity issues', async () => {
    const { exec, assertDone } = createFakeExec([
      createPullRequestViewSuccessCall(buildPullRequestPayload({ isDraft: 'not-a-boolean' })),
      createConversationsSuccessCall(buildConversationsPayload()),
    ]);

    const result = await githubProvider.read({
      mode: 'ambient',
      repository: { owner: 'robhowley', repo: 'pi-userland' },
      exec,
      cwd: '/repo',
    });

    assertDone();

    expect(result).toMatchObject({
      kind: 'found',
      snapshot: {
        signals: {
          draft: false,
          mergeability: 'mergeable',
          checks: 'passing',
          review: 'approved',
          unresolvedConversations: false,
          unresolvedConversationRequirement: 'optional',
        },
        integrityIssues: [
          {
            message: 'gh pr view JSON payload had an invalid draft flag',
          },
        ],
      },
    });
    if (result.kind === 'found') {
      expect(result.snapshot).not.toHaveProperty('forceStatusAmbiguous');
    }
  });

  it('distinguishes an absent targeted pull request from provider unavailability', async () => {
    const absentExec = createFakeExec([
      createPullRequestViewFailureCall(
        { exitCode: 1, stderr: 'pull request not found\n' },
        { target: TARGET },
      ),
    ]);
    const unavailableExec = createFakeExec([
      createPullRequestViewFailureCall(
        { exitCode: 1, stderr: 'authentication required; run gh auth login\n' },
        { target: TARGET },
      ),
    ]);

    await expect(
      githubProvider.read({ mode: 'url', target: TARGET, exec: absentExec.exec, cwd: '/repo' }),
    ).resolves.toEqual({ kind: 'absent' });
    await expect(
      githubProvider.read({
        mode: 'url',
        target: TARGET,
        exec: unavailableExec.exec,
        cwd: '/repo',
      }),
    ).resolves.toEqual({
      kind: 'unavailable',
      presence: 'unknown',
      issues: [{ message: 'GitHub CLI authentication failed' }],
    });

    absentExec.assertDone();
    unavailableExec.assertDone();
  });

  it('reports known unavailability and skips GraphQL when targeted head identity is missing', async () => {
    const { exec, assertDone } = createFakeExec([
      createPullRequestViewSuccessCall(
        buildPullRequestPayload({
          number: 64,
          url: TARGET.url,
          headRepository: null,
          headRepositoryOwner: null,
        }),
        { target: TARGET },
      ),
    ]);

    const result = await githubProvider.read({ mode: 'url', target: TARGET, exec, cwd: '/repo' });

    assertDone();
    expect(result).toEqual({
      kind: 'unavailable',
      presence: 'known',
      issues: [{ message: 'GitHub CLI did not report head repository identity' }],
    });
  });
});
