import { describe, expect, it } from 'vitest';
import {
  fetchMergeReadyPullRequestConversations,
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

const GH_GRAPHQL_REVIEW_THREADS_QUERY = [
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

function createConversationPayload(pullRequestOverrides: Record<string, unknown> = {}) {
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
            branchProtectionRule: null,
            rules: {
              nodes: [],
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

describe('merge-ready review conversation primitives', () => {
  it('returns known with zero unresolved conversations when every thread is resolved', async () => {
    const { exec, assertDone } = createFakeExec([
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
        timeout: 5_000,
        result: {
          stdout: `${JSON.stringify(
            createConversationPayload({
              reviewThreads: {
                nodes: [{ isResolved: true }, { isResolved: true }],
                pageInfo: { hasNextPage: false },
              },
            }),
          )}\n`,
        },
      },
    ]);

    const conversations = await fetchMergeReadyPullRequestConversations({
      exec,
      repositoryOwner: 'robhowley',
      repositoryName: 'pi-userland',
      pullRequestNumber: 42,
      cwd: '/repo',
      timeout: 5_000,
    });

    assertDone();

    expect(conversations).toEqual({
      kind: 'known',
      unresolvedCount: 0,
      requirement: 'optional',
      issues: [],
    });
  });

  it('counts unresolved conversations without exposing GraphQL thread payloads', async () => {
    const { exec, assertDone } = createFakeExec([
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
        result: {
          stdout: JSON.stringify(
            createConversationPayload({
              reviewThreads: {
                nodes: [{ isResolved: true }, { isResolved: false }, { isResolved: false }],
                pageInfo: { hasNextPage: false },
              },
            }),
          ),
        },
      },
    ]);

    const conversations = await fetchMergeReadyPullRequestConversations({
      exec,
      repositoryOwner: 'robhowley',
      repositoryName: 'pi-userland',
      pullRequestNumber: 42,
    });

    assertDone();

    expect(conversations).toEqual({
      kind: 'known',
      unresolvedCount: 2,
      requirement: 'optional',
      issues: [],
    });
  });

  it('extracts best-effort source-link detail rows for blocking reviews and unresolved conversations', async () => {
    const { exec, assertDone } = createFakeExec([
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
        result: {
          stdout: JSON.stringify(
            createConversationPayload({
              latestOpinionatedReviews: {
                nodes: [
                  {
                    author: { login: 'reviewer1' },
                    state: 'CHANGES_REQUESTED',
                    submittedAt: '2026-05-26T20:00:00Z',
                    url: 'https://github.com/robhowley/pi-userland/pull/42#pullrequestreview-1',
                  },
                  {
                    author: { login: 'reviewer2' },
                    state: 'APPROVED',
                    submittedAt: '2026-05-26T21:00:00Z',
                    url: 'https://github.com/robhowley/pi-userland/pull/42#pullrequestreview-2',
                  },
                ],
                pageInfo: { hasNextPage: false },
              },
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
        },
      },
    ]);

    const conversations = await fetchMergeReadyPullRequestConversations({
      exec,
      repositoryOwner: 'robhowley',
      repositoryName: 'pi-userland',
      pullRequestNumber: 42,
    });

    assertDone();

    expect(conversations).toEqual({
      kind: 'known',
      unresolvedCount: 1,
      requirement: 'optional',
      issues: [],
      openItemDetails: {
        changes_requested: [
          {
            label: 'reviewer1 requested changes',
            url: 'https://github.com/robhowley/pi-userland/pull/42#pullrequestreview-1',
          },
        ],
        unresolved_conversations: [
          {
            label: 'src/feature.ts:12 unresolved conversation',
            url: 'https://github.com/robhowley/pi-userland/pull/42#discussion_r1',
          },
        ],
      },
    });
  });

  it('ignores missing source-link metadata without degrading readiness inputs', async () => {
    const { exec, assertDone } = createFakeExec([
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
        result: {
          stdout: JSON.stringify(
            createConversationPayload({
              latestOpinionatedReviews: {
                nodes: [
                  {
                    author: { login: 'reviewer1' },
                    state: 'CHANGES_REQUESTED',
                    submittedAt: '2026-05-26T20:00:00Z',
                    url: null,
                  },
                ],
                pageInfo: { hasNextPage: true },
              },
              reviewThreads: {
                nodes: [
                  {
                    isResolved: false,
                    path: 'src/feature.ts',
                    line: 12,
                    comments: {
                      nodes: [{}],
                    },
                  },
                ],
                pageInfo: { hasNextPage: false },
              },
            }),
          ),
        },
      },
    ]);

    const conversations = await fetchMergeReadyPullRequestConversations({
      exec,
      repositoryOwner: 'robhowley',
      repositoryName: 'pi-userland',
      pullRequestNumber: 42,
    });

    assertDone();

    expect(conversations).toEqual({
      kind: 'known',
      unresolvedCount: 1,
      requirement: 'optional',
      issues: [],
    });
    expect(conversations).not.toHaveProperty('openItemDetails');
  });

  it('marks unresolved conversations as required when classic branch protection requires resolution', async () => {
    const { exec, assertDone } = createFakeExec([
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
        result: {
          stdout: JSON.stringify(
            createConversationPayload({
              reviewThreads: {
                nodes: [{ isResolved: false }],
                pageInfo: { hasNextPage: false },
              },
              baseRef: {
                branchProtectionRule: {
                  requiresConversationResolution: true,
                },
                rules: {
                  nodes: [],
                  pageInfo: { hasNextPage: false },
                },
              },
            }),
          ),
        },
      },
    ]);

    const conversations = await fetchMergeReadyPullRequestConversations({
      exec,
      repositoryOwner: 'robhowley',
      repositoryName: 'pi-userland',
      pullRequestNumber: 42,
    });

    assertDone();

    expect(conversations).toEqual({
      kind: 'known',
      unresolvedCount: 1,
      requirement: 'required',
      issues: [],
    });
  });

  it('marks unresolved conversations as required when base-ref rules require thread resolution', async () => {
    const { exec, assertDone } = createFakeExec([
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
        result: {
          stdout: JSON.stringify(
            createConversationPayload({
              reviewThreads: {
                nodes: [{ isResolved: false }],
                pageInfo: { hasNextPage: false },
              },
              baseRef: {
                branchProtectionRule: null,
                rules: {
                  nodes: [{ type: 'PULL_REQUEST' }, { type: 'REQUIRED_REVIEW_THREAD_RESOLUTION' }],
                  pageInfo: { hasNextPage: false },
                },
              },
            }),
          ),
        },
      },
    ]);

    const conversations = await fetchMergeReadyPullRequestConversations({
      exec,
      repositoryOwner: 'robhowley',
      repositoryName: 'pi-userland',
      pullRequestNumber: 42,
    });

    assertDone();

    expect(conversations).toEqual({
      kind: 'known',
      unresolvedCount: 1,
      requirement: 'required',
      issues: [],
    });
  });

  it('marks unresolved conversations as optional only when policy discovery is clean and non-required', async () => {
    const { exec, assertDone } = createFakeExec([
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
        result: {
          stdout: JSON.stringify(
            createConversationPayload({
              reviewThreads: {
                nodes: [{ isResolved: false }],
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
        },
      },
    ]);

    const conversations = await fetchMergeReadyPullRequestConversations({
      exec,
      repositoryOwner: 'robhowley',
      repositoryName: 'pi-userland',
      pullRequestNumber: 42,
    });

    assertDone();

    expect(conversations).toEqual({
      kind: 'known',
      unresolvedCount: 1,
      requirement: 'optional',
      issues: [],
    });
  });

  it('returns partial with unknown requirement when base-ref rule discovery is truncated', async () => {
    const { exec, assertDone } = createFakeExec([
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
        result: {
          stdout: JSON.stringify(
            createConversationPayload({
              reviewThreads: {
                nodes: [{ isResolved: false }, { isResolved: false }],
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
        },
      },
    ]);

    const conversations = await fetchMergeReadyPullRequestConversations({
      exec,
      repositoryOwner: 'robhowley',
      repositoryName: 'pi-userland',
      pullRequestNumber: 42,
    });

    assertDone();

    expect(conversations.kind).toBe('partial');
    expect(conversations).toMatchObject({
      unresolvedCount: 2,
      requirement: 'unknown',
    });
    expect(conversations.issues).toEqual([
      expect.objectContaining({
        code: 'page_limit',
        field: 'data.repository.pullRequest.baseRef.rules.pageInfo.hasNextPage',
      }),
    ]);
  });

  it('returns partial with a page-limit issue when more review thread pages exist', async () => {
    const { exec, assertDone } = createFakeExec([
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
        result: {
          stdout: JSON.stringify(
            createConversationPayload({
              reviewThreads: {
                nodes: [{ isResolved: true }, { isResolved: true }],
                pageInfo: { hasNextPage: true },
              },
            }),
          ),
        },
      },
    ]);

    const conversations = await fetchMergeReadyPullRequestConversations({
      exec,
      repositoryOwner: 'robhowley',
      repositoryName: 'pi-userland',
      pullRequestNumber: 42,
    });

    assertDone();

    expect(conversations.kind).toBe('partial');
    expect(conversations).toMatchObject({
      unresolvedCount: 0,
      requirement: 'optional',
    });
    expect(conversations.issues).toEqual([
      expect.objectContaining({
        code: 'page_limit',
        field: 'data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage',
      }),
    ]);
  });

  it('returns invalid_json when gh succeeds with malformed output', async () => {
    const { exec, assertDone } = createFakeExec([
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
        result: {
          stdout: '{ definitely not json',
        },
      },
    ]);

    const conversations = await fetchMergeReadyPullRequestConversations({
      exec,
      repositoryOwner: 'robhowley',
      repositoryName: 'pi-userland',
      pullRequestNumber: 42,
    });

    assertDone();

    expect(conversations.kind).toBe('invalid_json');
    expect(conversations.issues[0]).toMatchObject({
      code: 'invalid_json',
    });
  });

  it('returns invalid_shape when the payload is missing review thread nodes', async () => {
    const { exec, assertDone } = createFakeExec([
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
        result: {
          stdout: JSON.stringify(
            createConversationPayload({
              reviewThreads: {},
            }),
          ),
        },
      },
    ]);

    const conversations = await fetchMergeReadyPullRequestConversations({
      exec,
      repositoryOwner: 'robhowley',
      repositoryName: 'pi-userland',
      pullRequestNumber: 42,
    });

    assertDone();

    expect(conversations.kind).toBe('invalid_shape');
    expect(conversations.issues).toEqual([
      expect.objectContaining({
        code: 'invalid_shape',
        field: 'data.repository.pullRequest.reviewThreads.nodes',
      }),
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
        result,
      },
    ]);

    const conversations = await fetchMergeReadyPullRequestConversations({
      exec,
      repositoryOwner: 'robhowley',
      repositoryName: 'pi-userland',
      pullRequestNumber: 42,
    });

    assertDone();

    expect(conversations).toMatchObject({
      kind: 'failure',
      reason: expectedReason,
    });
  });

  it('returns a typed api failure when GraphQL errors are returned in JSON', async () => {
    const { exec, assertDone } = createFakeExec([
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
        result: {
          stdout: JSON.stringify({
            errors: [{ message: 'GraphQL: Something went wrong' }],
          }),
        },
      },
    ]);

    const conversations = await fetchMergeReadyPullRequestConversations({
      exec,
      repositoryOwner: 'robhowley',
      repositoryName: 'pi-userland',
      pullRequestNumber: 42,
    });

    assertDone();

    expect(conversations).toMatchObject({
      kind: 'failure',
      reason: 'api',
    });
    expect(conversations.issues[0]).toMatchObject({
      code: 'api_error',
      field: 'errors',
    });
  });

  it('returns a command failure when exec throws', async () => {
    const { exec, assertDone } = createFakeExec([
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
        error: new Error('spawn gh ENOENT'),
      },
    ]);

    const conversations = await fetchMergeReadyPullRequestConversations({
      exec,
      repositoryOwner: 'robhowley',
      repositoryName: 'pi-userland',
      pullRequestNumber: 42,
    });

    assertDone();

    expect(conversations).toMatchObject({
      kind: 'failure',
      reason: 'command',
    });
    expect(conversations.issues[0]).toMatchObject({
      code: 'threw',
    });
  });
});
