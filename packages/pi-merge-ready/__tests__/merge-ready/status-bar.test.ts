import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MERGE_READY_STATUS_BAR_KEY,
  MERGE_READY_STATUS_BAR_TIMEOUT_MS,
  MERGE_READY_STATUS_BAR_TTL_MS,
  createMergeReadyStatus,
  refreshMergeReadyStatusBar,
  registerMergeReadyStatusBar,
  renderMergeReadyStatusBar,
  resetMergeReadyStatusBarCache,
  syncMergeReadyStatusBar,
  type MergeReadyStatusBarAPI,
  type MergeReadyStatusBarContext,
} from '../../extensions/merge-ready/index.js';

type ExpectedExecCall = {
  command: string;
  args: string[];
  cwd?: string | undefined;
  timeout?: number | undefined;
  result?: {
    stdout?: string;
    stderr?: string;
    code?: number;
    killed?: boolean;
    exitCode?: number;
  };
  error?: unknown;
};

const GH_PR_VIEW_JSON_FIELDS =
  'number,title,url,state,isDraft,mergeable,mergeStateStatus,headRefName,baseRefName,statusCheckRollup,reviews,reviewDecision,reviewRequests,author';
const GH_GRAPHQL_REVIEW_THREADS_QUERY = [
  'query MergeReadyReviewThreads($owner: String!, $name: String!, $number: Int!) {',
  'repository(owner: $owner, name: $name) {',
  'pullRequest(number: $number) {',
  'reviewThreads(first: 100) {',
  'nodes { isResolved }',
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

function createMockAPI(expectedCalls: ExpectedExecCall[] = []): {
  api: MergeReadyStatusBarAPI;
  assertDone: () => void;
  getHandler: (
    event: 'session_start' | 'turn_end',
  ) => ((event: unknown, ctx: MergeReadyStatusBarContext) => void | Promise<void>) | undefined;
} {
  let index = 0;
  const handlers = new Map<
    string,
    (event: unknown, ctx: MergeReadyStatusBarContext) => void | Promise<void>
  >();

  const api: MergeReadyStatusBarAPI = {
    on: vi.fn((event, handler) => {
      handlers.set(event, handler);
    }),
    exec: vi.fn(
      async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
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

        return {
          stdout: expectedCall?.result?.stdout ?? '',
          stderr: expectedCall?.result?.stderr ?? '',
          code: expectedCall?.result?.code ?? 0,
          killed: expectedCall?.result?.killed ?? false,
          exitCode: expectedCall?.result?.exitCode,
        };
      },
    ),
  };

  return {
    api,
    assertDone: () => {
      expect(index).toBe(expectedCalls.length);
    },
    getHandler: (event) => handlers.get(event),
  };
}

function createStatusContext(): MergeReadyStatusBarContext {
  return {
    cwd: '/repo',
    hasUI: true,
    ui: {
      setStatus: vi.fn(),
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

function buildConversationsPayload(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [],
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
          ...overrides,
        },
      },
    },
  };
}

describe('merge-ready status bar', () => {
  beforeEach(() => {
    resetMergeReadyStatusBarCache();
  });

  it('registers session_start and turn_end hooks', () => {
    const { api, getHandler } = createMockAPI();

    registerMergeReadyStatusBar(api);

    expect(api.on).toHaveBeenCalledTimes(2);
    expect(api.on).toHaveBeenCalledWith('session_start', expect.any(Function));
    expect(api.on).toHaveBeenCalledWith('turn_end', expect.any(Function));
    expect(getHandler('session_start')).toBeTypeOf('function');
    expect(getHandler('turn_end')).toBeTypeOf('function');
  });

  it('renders a terse ready status on session start', async () => {
    const { api, assertDone, getHandler } = createMockAPI([
      ...createGitDiscoveryCalls(MERGE_READY_STATUS_BAR_TIMEOUT_MS),
      createPullRequestViewSuccessCall(
        buildPullRequestPayload(),
        MERGE_READY_STATUS_BAR_TIMEOUT_MS,
      ),
      createConversationsSuccessCall(
        buildConversationsPayload({
          reviewThreads: {
            nodes: [{ isResolved: true }],
            pageInfo: { hasNextPage: false },
          },
        }),
        MERGE_READY_STATUS_BAR_TIMEOUT_MS,
      ),
    ]);
    const ctx = createStatusContext();

    registerMergeReadyStatusBar(api);

    await getHandler('session_start')?.({ reason: 'startup' }, ctx);

    assertDone();
    expect(ctx.ui?.setStatus).toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, '✅ Ready');
  });

  it.each([
    {
      name: 'merge conflicts',
      status: createMergeReadyStatus({
        generatedAt: '2026-05-27T00:00:00.000Z',
        pr: {
          number: 42,
          title: 'Compose merge-ready status boundary',
          url: 'https://github.com/robhowley/pi-userland/pull/42',
        },
        signals: {
          draft: false,
          mergeability: 'conflicting',
          checks: 'passing',
          review: 'approved',
          unresolvedConversations: false,
          unresolvedConversationRequirement: 'optional',
        },
      }),
      expected: '⚠️ Conflicts',
    },
    {
      name: 'branch out of date',
      status: createMergeReadyStatus({
        generatedAt: '2026-05-27T00:00:00.000Z',
        pr: {
          number: 42,
          title: 'Compose merge-ready status boundary',
          url: 'https://github.com/robhowley/pi-userland/pull/42',
        },
        signals: {
          draft: false,
          mergeability: 'behind',
          checks: 'passing',
          review: 'approved',
          unresolvedConversations: false,
          unresolvedConversationRequirement: 'optional',
        },
      }),
      expected: '🔄 Out of date',
    },
    {
      name: 'generic merge blocked',
      status: createMergeReadyStatus({
        generatedAt: '2026-05-27T00:00:00.000Z',
        pr: {
          number: 42,
          title: 'Compose merge-ready status boundary',
          url: 'https://github.com/robhowley/pi-userland/pull/42',
        },
        signals: {
          draft: false,
          mergeability: 'blocked',
          checks: 'passing',
          review: 'approved',
          unresolvedConversations: false,
          unresolvedConversationRequirement: 'optional',
        },
      }),
      expected: '⛔ Merge blocked',
    },
  ])('renders $name with mergeability-aware status text', ({ status, expected }) => {
    expect(renderMergeReadyStatusBar(status)).toBe(expected);
  });

  it('renders required unresolved conversations as the top blocker', () => {
    const status = createMergeReadyStatus({
      generatedAt: '2026-05-27T00:00:00.000Z',
      pr: {
        number: 42,
        title: 'Compose merge-ready status boundary',
        url: 'https://github.com/robhowley/pi-userland/pull/42',
      },
      signals: {
        draft: false,
        mergeability: 'mergeable',
        checks: 'passing',
        review: 'approved',
        unresolvedConversations: true,
        unresolvedConversationCount: 2,
        unresolvedConversationRequirement: 'required',
      },
    });

    expect(renderMergeReadyStatusBar(status)).toBe('❌ 💬 2 unresolved');
  });

  it('renders optional unresolved comments on an otherwise ready PR', () => {
    const status = createMergeReadyStatus({
      generatedAt: '2026-05-27T00:00:00.000Z',
      pr: {
        number: 42,
        title: 'Compose merge-ready status boundary',
        url: 'https://github.com/robhowley/pi-userland/pull/42',
      },
      signals: {
        draft: false,
        mergeability: 'mergeable',
        checks: 'passing',
        review: 'approved',
        unresolvedConversations: true,
        unresolvedConversationCount: 2,
        unresolvedConversationRequirement: 'optional',
      },
    });

    expect(renderMergeReadyStatusBar(status)).toBe('✅ Mergeable · 💬 2 comments');
  });

  it('syncs a provided status into the footer and TTL cache', async () => {
    const status = createMergeReadyStatus({
      generatedAt: '2026-05-27T00:00:00.000Z',
      pr: {
        number: 42,
        title: 'Compose merge-ready status boundary',
        url: 'https://github.com/robhowley/pi-userland/pull/42',
      },
      signals: {
        draft: false,
        mergeability: 'mergeable',
        checks: 'passing',
        review: 'approved',
        unresolvedConversations: false,
        unresolvedConversationRequirement: 'optional',
      },
    });
    const ctx = createStatusContext();

    const synced = syncMergeReadyStatusBar({
      ctx,
      status,
      now: 1_000,
    });
    const refreshed = await refreshMergeReadyStatusBar({
      exec: vi.fn(),
      ctx,
      now: 1_000 + MERGE_READY_STATUS_BAR_TTL_MS - 1,
    });

    expect(synced).toEqual({ text: '✅ Ready', cached: false });
    expect(refreshed).toEqual({ text: '✅ Ready', cached: true });
    expect(ctx.ui?.setStatus).toHaveBeenCalledTimes(2);
  });

  it('renders required unresolved conversation count from GitHub conversations', async () => {
    const { api, assertDone, getHandler } = createMockAPI([
      ...createGitDiscoveryCalls(MERGE_READY_STATUS_BAR_TIMEOUT_MS),
      createPullRequestViewSuccessCall(
        buildPullRequestPayload(),
        MERGE_READY_STATUS_BAR_TIMEOUT_MS,
      ),
      createConversationsSuccessCall(
        buildConversationsPayload({
          reviewThreads: {
            nodes: [{ isResolved: false }, { isResolved: false }],
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
        MERGE_READY_STATUS_BAR_TIMEOUT_MS,
      ),
    ]);
    const ctx = createStatusContext();

    registerMergeReadyStatusBar(api);

    await getHandler('turn_end')?.({}, ctx);

    assertDone();
    expect(ctx.ui?.setStatus).toHaveBeenCalledWith(
      MERGE_READY_STATUS_BAR_KEY,
      '❌ 💬 2 unresolved',
    );
  });

  it('renders optional unresolved comments without outranking real blockers', async () => {
    const { api, assertDone, getHandler } = createMockAPI([
      ...createGitDiscoveryCalls(MERGE_READY_STATUS_BAR_TIMEOUT_MS),
      createPullRequestViewSuccessCall(
        buildPullRequestPayload({
          statusCheckRollup: [
            {
              __typename: 'CheckRun',
              workflowName: 'ci',
              name: 'unit',
              status: 'COMPLETED',
              conclusion: 'FAILURE',
            },
          ],
        }),
        MERGE_READY_STATUS_BAR_TIMEOUT_MS,
      ),
      createConversationsSuccessCall(
        buildConversationsPayload({
          reviewThreads: {
            nodes: [{ isResolved: false }, { isResolved: true }],
            pageInfo: { hasNextPage: false },
          },
        }),
        MERGE_READY_STATUS_BAR_TIMEOUT_MS,
      ),
    ]);
    const ctx = createStatusContext();

    registerMergeReadyStatusBar(api);

    await getHandler('turn_end')?.({}, ctx);

    assertDone();
    expect(ctx.ui?.setStatus).toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, '❌ Checks failing');
  });

  it('renders an unknown-looking status when no pull request is found', async () => {
    const { api, assertDone, getHandler } = createMockAPI([
      ...createGitDiscoveryCalls(MERGE_READY_STATUS_BAR_TIMEOUT_MS),
      {
        command: 'gh',
        args: ['pr', 'view', '--json', GH_PR_VIEW_JSON_FIELDS],
        cwd: '/repo',
        timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
        result: {
          code: 1,
          stderr: 'no pull requests found for branch "feat/merge-ready"\n',
        },
      },
    ]);
    const ctx = createStatusContext();

    registerMergeReadyStatusBar(api);

    await getHandler('session_start')?.({ reason: 'startup' }, ctx);

    assertDone();
    expect(ctx.ui?.setStatus).toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, '❔ No PR');
  });

  it('skips boundary refresh within the TTL and reuses cached text', async () => {
    const { api, assertDone } = createMockAPI([
      ...createGitDiscoveryCalls(MERGE_READY_STATUS_BAR_TIMEOUT_MS),
      createPullRequestViewSuccessCall(
        buildPullRequestPayload(),
        MERGE_READY_STATUS_BAR_TIMEOUT_MS,
      ),
      createConversationsSuccessCall(
        buildConversationsPayload({
          reviewThreads: {
            nodes: [{ isResolved: true }],
            pageInfo: { hasNextPage: false },
          },
        }),
        MERGE_READY_STATUS_BAR_TIMEOUT_MS,
      ),
    ]);
    const ctx = createStatusContext();

    const first = await refreshMergeReadyStatusBar({
      exec: api.exec,
      ctx,
      now: 1_000,
    });
    const second = await refreshMergeReadyStatusBar({
      exec: api.exec,
      ctx,
      now: 1_000 + MERGE_READY_STATUS_BAR_TTL_MS - 1,
    });

    assertDone();
    expect(first).toEqual({ text: '✅ Ready', cached: false });
    expect(second).toEqual({ text: '✅ Ready', cached: true });
    expect(ctx.ui?.setStatus).toHaveBeenCalledTimes(2);
  });

  it('bypasses the TTL when refresh is forced', async () => {
    const calls = [
      ...createGitDiscoveryCalls(MERGE_READY_STATUS_BAR_TIMEOUT_MS),
      createPullRequestViewSuccessCall(
        buildPullRequestPayload(),
        MERGE_READY_STATUS_BAR_TIMEOUT_MS,
      ),
      createConversationsSuccessCall(
        buildConversationsPayload({
          reviewThreads: {
            nodes: [{ isResolved: true }],
            pageInfo: { hasNextPage: false },
          },
        }),
        MERGE_READY_STATUS_BAR_TIMEOUT_MS,
      ),
      ...createGitDiscoveryCalls(MERGE_READY_STATUS_BAR_TIMEOUT_MS),
      createPullRequestViewSuccessCall(
        buildPullRequestPayload(),
        MERGE_READY_STATUS_BAR_TIMEOUT_MS,
      ),
      createConversationsSuccessCall(
        buildConversationsPayload({
          reviewThreads: {
            nodes: [{ isResolved: true }],
            pageInfo: { hasNextPage: false },
          },
        }),
        MERGE_READY_STATUS_BAR_TIMEOUT_MS,
      ),
    ];
    const { api, assertDone } = createMockAPI(calls);
    const ctx = createStatusContext();

    const first = await refreshMergeReadyStatusBar({
      exec: api.exec,
      ctx,
      now: 2_000,
    });
    const second = await refreshMergeReadyStatusBar({
      exec: api.exec,
      ctx,
      force: true,
      now: 2_000 + MERGE_READY_STATUS_BAR_TTL_MS - 1,
    });

    assertDone();
    expect(first).toEqual({ text: '✅ Ready', cached: false });
    expect(second).toEqual({ text: '✅ Ready', cached: false });
  });

  it('degrades exec failures to an unknown-looking status instead of throwing through the hook', async () => {
    const { api, assertDone, getHandler } = createMockAPI([
      {
        command: 'git',
        args: ['rev-parse', '--show-toplevel'],
        cwd: '/repo',
        timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
        error: new Error('spawn git EACCES'),
      },
    ]);
    const ctx = createStatusContext();

    registerMergeReadyStatusBar(api);

    await expect(
      getHandler('session_start')?.({ reason: 'startup' }, ctx),
    ).resolves.toBeUndefined();

    assertDone();
    expect(ctx.ui?.setStatus).toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, '❔ No PR');
  });
});
