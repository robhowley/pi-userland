import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MERGE_READY_STATUS_BAR_KEY,
  MERGE_READY_STATUS_BAR_TIMEOUT_MS,
  MERGE_READY_STATUS_BAR_TTL_MS,
  createMergeReadyStatus,
  isMergeReadyStatusBarSuspended,
  refreshMergeReadyStatusBar,
  registerMergeReadyStatusBar,
  renderMergeReadyStatusBar,
  resetMergeReadyStatusBarCache,
  suspendMergeReadyStatusBar,
  syncMergeReadyStatusBar,
  type MergeReadyStatusBarAPI,
  type MergeReadyStatusBarContext,
} from '../../extensions/merge-ready/index.js';
import {
  GH_PR_VIEW_JSON_FIELDS,
  buildConversationsPayload,
  buildPullRequestPayload,
  createConversationsSuccessCall,
  createGitDiscoveryCalls,
  createPullRequestViewSuccessCall,
  type ExpectedExecCall,
} from './test-fixtures.js';

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

function buildOpenPr() {
  return {
    lifecycle: 'open' as const,
    number: 42,
    title: 'Compose merge-ready status boundary',
    url: 'https://github.com/robhowley/pi-userland/pull/42',
    headRefName: 'feat/merge-ready',
    baseRefName: 'main',
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
      ...createGitDiscoveryCalls({ timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS }),
      createPullRequestViewSuccessCall(buildPullRequestPayload(), {
        timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
      }),
      createConversationsSuccessCall(
        buildConversationsPayload({
          reviewThreads: {
            nodes: [{ isResolved: true }],
            pageInfo: { hasNextPage: false },
          },
        }),
        { timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS },
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
        pr: buildOpenPr(),
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
        pr: buildOpenPr(),
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
        pr: buildOpenPr(),
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
    {
      name: 'merged lifecycle',
      status: createMergeReadyStatus({
        generatedAt: '2026-05-27T00:00:00.000Z',
        pr: { ...buildOpenPr(), lifecycle: 'merged' },
        signals: {
          draft: false,
          mergeability: 'mergeable',
          checks: 'passing',
          review: 'approved',
          unresolvedConversations: false,
          unresolvedConversationRequirement: 'optional',
        },
      }),
      expected: '🎉 Merged',
    },
  ])('renders $name with mergeability-aware status text', ({ status, expected }) => {
    expect(renderMergeReadyStatusBar(status)).toBe(expected);
  });

  it('keeps review-pending status text when reviewer details are attached', () => {
    const status = createMergeReadyStatus({
      generatedAt: '2026-05-27T00:00:00.000Z',
      pr: buildOpenPr(),
      openItems: [
        {
          id: 'review_pending',
          summary: 'Waiting for review',
          details: [{ label: '@alice' }, { label: 'team/core-reviewers' }],
        },
      ],
      signals: {
        draft: false,
        mergeability: 'mergeable',
        checks: 'passing',
        review: 'pending',
        unresolvedConversations: false,
        unresolvedConversationRequirement: 'optional',
      },
    });

    expect(renderMergeReadyStatusBar(status)).toBe('👀 Review pending');
  });

  it('renders required unresolved conversations as the top blocker', () => {
    const status = createMergeReadyStatus({
      generatedAt: '2026-05-27T00:00:00.000Z',
      pr: buildOpenPr(),
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
      pr: buildOpenPr(),
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

  it('syncs a provided ambient status into the footer and TTL cache', async () => {
    const status = createMergeReadyStatus({
      generatedAt: '2026-05-27T00:00:00.000Z',
      pr: buildOpenPr(),
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

  it('does not sync URL-targeted command results into the ambient cache', async () => {
    const ambientCtx = createStatusContext();
    const ambientStatus = createMergeReadyStatus({
      generatedAt: '2026-05-27T00:00:00.000Z',
      pr: buildOpenPr(),
      signals: {
        draft: false,
        mergeability: 'mergeable',
        checks: 'passing',
        review: 'approved',
        unresolvedConversations: false,
        unresolvedConversationRequirement: 'optional',
      },
    });
    const targetedStatus = createMergeReadyStatus({
      generatedAt: '2026-05-27T00:00:00.000Z',
      target: {
        mode: 'url',
        url: 'https://github.com/shopify/pi/pull/64',
        owner: 'shopify',
        repo: 'pi',
        prNumber: 64,
      },
      pr: {
        lifecycle: 'open',
        number: 64,
        title: 'Support explicit PR URL targets',
        url: 'https://github.com/shopify/pi/pull/64',
        headRefName: 'feat/explicit-pr-url',
        baseRefName: 'main',
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

    syncMergeReadyStatusBar({ ctx: ambientCtx, status: ambientStatus, now: 1_000 });
    const targetedCtx = createStatusContext();

    const targeted = syncMergeReadyStatusBar({
      ctx: targetedCtx,
      status: targetedStatus,
      now: 2_000,
    });
    const refreshed = await refreshMergeReadyStatusBar({
      exec: vi.fn(),
      ctx: createStatusContext(),
      now: 1_000 + MERGE_READY_STATUS_BAR_TTL_MS - 1,
    });

    expect(targeted).toEqual({ text: '✅ Ready', cached: false });
    expect(targetedCtx.ui?.setStatus).not.toHaveBeenCalled();
    expect(refreshed).toEqual({ text: '✅ Ready', cached: true });
  });

  it('suppresses cached ambient refreshes while suspended until resumed', async () => {
    const ctx = createStatusContext();
    const setStatus = vi.mocked(ctx.ui!.setStatus);
    const status = createMergeReadyStatus({
      generatedAt: '2026-05-27T00:00:00.000Z',
      pr: buildOpenPr(),
      signals: {
        draft: false,
        mergeability: 'mergeable',
        checks: 'passing',
        review: 'approved',
        unresolvedConversations: false,
        unresolvedConversationRequirement: 'optional',
      },
    });

    syncMergeReadyStatusBar({ ctx, status, now: 1_000 });
    setStatus.mockClear();

    const resume = suspendMergeReadyStatusBar(ctx);
    expect(isMergeReadyStatusBarSuspended()).toBe(true);
    expect(setStatus).toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, undefined);

    setStatus.mockClear();
    const hiddenRefresh = await refreshMergeReadyStatusBar({
      exec: vi.fn(),
      ctx,
      now: 1_000 + MERGE_READY_STATUS_BAR_TTL_MS - 1,
    });

    expect(hiddenRefresh).toEqual({ text: '✅ Ready', cached: true });
    expect(setStatus).toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, undefined);
    expect(setStatus).not.toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, '✅ Ready');

    setStatus.mockClear();
    resume();
    expect(isMergeReadyStatusBarSuspended()).toBe(false);
    expect(setStatus).toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, '✅ Ready');

    setStatus.mockClear();
    const visibleRefresh = await refreshMergeReadyStatusBar({
      exec: vi.fn(),
      ctx,
      now: 1_000 + MERGE_READY_STATUS_BAR_TTL_MS - 1,
    });

    expect(visibleRefresh).toEqual({ text: '✅ Ready', cached: true });
    expect(setStatus).toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, '✅ Ready');
  });

  it('keeps fresh ambient refreshes hidden while suspended', async () => {
    const { api, assertDone } = createMockAPI([
      ...createGitDiscoveryCalls({ timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS }),
      createPullRequestViewSuccessCall(buildPullRequestPayload(), {
        timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
      }),
      createConversationsSuccessCall(
        buildConversationsPayload({
          reviewThreads: {
            nodes: [{ isResolved: true }],
            pageInfo: { hasNextPage: false },
          },
        }),
        { timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS },
      ),
    ]);
    const ctx = createStatusContext();
    const setStatus = vi.mocked(ctx.ui!.setStatus);
    const resume = suspendMergeReadyStatusBar(ctx);

    setStatus.mockClear();
    const hiddenRefresh = await refreshMergeReadyStatusBar({
      exec: api.exec,
      ctx,
      force: true,
      now: 2_000,
    });

    assertDone();
    expect(hiddenRefresh).toEqual({ text: '✅ Ready', cached: false });
    expect(setStatus).toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, undefined);
    expect(setStatus).not.toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, '✅ Ready');

    setStatus.mockClear();
    resume();
    expect(isMergeReadyStatusBarSuspended()).toBe(false);
    expect(setStatus).toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, '✅ Ready');

    setStatus.mockClear();
    const visibleRefresh = await refreshMergeReadyStatusBar({
      exec: vi.fn(),
      ctx,
      now: 2_000 + MERGE_READY_STATUS_BAR_TTL_MS - 1,
    });

    expect(visibleRefresh).toEqual({ text: '✅ Ready', cached: true });
    expect(setStatus).toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, '✅ Ready');
  });

  it('keeps ambient status suspended until the last cleanup runs', () => {
    const ctx = createStatusContext();
    const resumeFirst = suspendMergeReadyStatusBar(ctx);
    const resumeSecond = suspendMergeReadyStatusBar(ctx);

    expect(isMergeReadyStatusBarSuspended()).toBe(true);

    resumeFirst();
    expect(isMergeReadyStatusBarSuspended()).toBe(true);

    resumeFirst();
    resumeSecond();
    expect(isMergeReadyStatusBarSuspended()).toBe(false);
  });

  it('renders required unresolved conversation count from GitHub conversations', async () => {
    const { api, assertDone, getHandler } = createMockAPI([
      ...createGitDiscoveryCalls({ timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS }),
      createPullRequestViewSuccessCall(buildPullRequestPayload(), {
        timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
      }),
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
        { timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS },
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
      ...createGitDiscoveryCalls({ timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS }),
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
        { timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS },
      ),
      createConversationsSuccessCall(
        buildConversationsPayload({
          reviewThreads: {
            nodes: [{ isResolved: false }, { isResolved: true }],
            pageInfo: { hasNextPage: false },
          },
        }),
        { timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS },
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
      ...createGitDiscoveryCalls({ timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS }),
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
      ...createGitDiscoveryCalls({ timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS }),
      createPullRequestViewSuccessCall(buildPullRequestPayload(), {
        timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
      }),
      createConversationsSuccessCall(
        buildConversationsPayload({
          reviewThreads: {
            nodes: [{ isResolved: true }],
            pageInfo: { hasNextPage: false },
          },
        }),
        { timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS },
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
      ...createGitDiscoveryCalls({ timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS }),
      createPullRequestViewSuccessCall(buildPullRequestPayload(), {
        timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
      }),
      createConversationsSuccessCall(
        buildConversationsPayload({
          reviewThreads: {
            nodes: [{ isResolved: true }],
            pageInfo: { hasNextPage: false },
          },
        }),
        { timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS },
      ),
      ...createGitDiscoveryCalls({ timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS }),
      createPullRequestViewSuccessCall(buildPullRequestPayload(), {
        timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
      }),
      createConversationsSuccessCall(
        buildConversationsPayload({
          reviewThreads: {
            nodes: [{ isResolved: true }],
            pageInfo: { hasNextPage: false },
          },
        }),
        { timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS },
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
