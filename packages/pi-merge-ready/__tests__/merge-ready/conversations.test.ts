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

function createConversationPayload(overrides: Record<string, unknown> = {}) {
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
      issues: [],
    });
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
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {},
                },
              },
            },
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
