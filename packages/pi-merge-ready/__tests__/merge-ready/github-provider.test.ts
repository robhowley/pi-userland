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
