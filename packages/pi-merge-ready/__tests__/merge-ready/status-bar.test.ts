import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  REQUESTED_REVIEWER_SCENARIO,
  buildConversationsPayload,
  buildPullRequestPayload,
  createConversationsSuccessCall,
  createCurrentBranchProbeCall,
  createFakeExec,
  createGitDiscoveryCalls,
  createPullRequestViewFailureCall,
  createPullRequestViewSuccessCall,
  type ExpectedExecCall,
} from './test-fixtures.js';

function createMockAPI(expectedCalls: ExpectedExecCall[] = []): {
  api: MergeReadyStatusBarAPI;
  assertDone: () => void;
  getHandler: (
    event: 'session_start' | 'turn_end' | 'session_shutdown',
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

function createStatusContext(
  options: {
    cwd?: string;
    setStatus?: NonNullable<MergeReadyStatusBarContext['ui']>['setStatus'];
  } = {},
): MergeReadyStatusBarContext {
  return {
    cwd: options.cwd ?? '/repo',
    hasUI: true,
    ui: {
      setStatus: options.setStatus ?? vi.fn(),
    },
  };
}

function createSettingsSandbox() {
  const originalAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const root = mkdtempSync(join(tmpdir(), 'pi-merge-ready-status-bar-'));
  const cwd = join(root, 'repo');
  const agentDir = join(root, 'agent');

  mkdirSync(cwd, { recursive: true });
  process.env['PI_CODING_AGENT_DIR'] = agentDir;

  const writeJsonFile = (path: string, value: unknown) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2), 'utf-8');
  };

  return {
    cwd,
    writeGlobalSettings(settings: unknown) {
      writeJsonFile(join(agentDir, 'settings.json'), settings);
    },
    writeProjectSettings(settings: unknown) {
      writeJsonFile(join(cwd, '.pi', 'settings.json'), settings);
    },
    cleanup() {
      if (originalAgentDir === undefined) {
        delete process.env['PI_CODING_AGENT_DIR'];
      } else {
        process.env['PI_CODING_AGENT_DIR'] = originalAgentDir;
      }

      rmSync(root, { recursive: true, force: true });
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

  it('registers session_start, turn_end, and session_shutdown hooks', () => {
    const { api, getHandler } = createMockAPI();

    registerMergeReadyStatusBar(api);

    expect(api.on).toHaveBeenCalledTimes(3);
    expect(api.on).toHaveBeenCalledWith('session_start', expect.any(Function));
    expect(api.on).toHaveBeenCalledWith('turn_end', expect.any(Function));
    expect(api.on).toHaveBeenCalledWith('session_shutdown', expect.any(Function));
    expect(getHandler('session_start')).toBeTypeOf('function');
    expect(getHandler('turn_end')).toBeTypeOf('function');
    expect(getHandler('session_shutdown')).toBeTypeOf('function');
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
    expect(ctx.ui?.setStatus).toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, '✅ #42 Ready');
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
      expected: '⚠️ #42 Conflicts',
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
      expected: '🔄 #42 Out of date',
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
      expected: '⛔ #42 Merge blocked',
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
      expected: '🎉 #42 Merged',
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
          details: REQUESTED_REVIEWER_SCENARIO.openItemDetails,
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

    expect(renderMergeReadyStatusBar(status)).toBe('👀 #42 Review pending');
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

    expect(renderMergeReadyStatusBar(status)).toBe('❌ #42 💬 2 unresolved');
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

    expect(renderMergeReadyStatusBar(status)).toBe('✅ #42 Mergeable · 💬 2 comments');
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
    const { exec, assertDone } = createFakeExec([
      createCurrentBranchProbeCall({ timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS }),
    ]);

    const synced = syncMergeReadyStatusBar({
      ctx,
      status,
      now: 1_000,
    });
    const refreshed = await refreshMergeReadyStatusBar({
      exec,
      ctx,
      now: 1_000 + MERGE_READY_STATUS_BAR_TTL_MS - 1,
    });

    assertDone();
    expect(synced).toEqual({ text: '✅ #42 Ready', cached: false });
    expect(refreshed).toEqual({ text: '✅ #42 Ready', cached: true });
    expect(ctx.ui?.setStatus).toHaveBeenCalledTimes(2);
  });

  it('uses the stored configured TTL for sync-seeded cache expiry', async () => {
    const sandbox = createSettingsSandbox();

    try {
      sandbox.writeProjectSettings({
        'pi-merge-ready': {
          cacheTTLSeconds: 5,
        },
      });

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
      const ctx = createStatusContext({ cwd: sandbox.cwd });
      const { exec, assertDone } = createFakeExec([
        createCurrentBranchProbeCall({
          cwd: sandbox.cwd,
          timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
        }),
        ...createGitDiscoveryCalls({
          cwd: sandbox.cwd,
          timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
        }),
        createPullRequestViewSuccessCall(buildPullRequestPayload(), {
          cwd: sandbox.cwd,
          timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
        }),
        createConversationsSuccessCall(buildConversationsPayload(), {
          cwd: sandbox.cwd,
          timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
        }),
      ]);

      syncMergeReadyStatusBar({
        ctx,
        status,
        now: 1_000,
        projectTrusted: true,
      });

      const cached = await refreshMergeReadyStatusBar({
        exec,
        ctx,
        now: 5_999,
      });
      const expired = await refreshMergeReadyStatusBar({
        exec,
        ctx,
        now: 6_000,
      });

      assertDone();
      expect(cached).toEqual({ text: '✅ #42 Ready', cached: true });
      expect(expired).toEqual({ text: '✅ #42 Ready', cached: false });
    } finally {
      sandbox.cleanup();
    }
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
    const { exec, assertDone } = createFakeExec([
      createCurrentBranchProbeCall({ timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS }),
    ]);

    const targeted = syncMergeReadyStatusBar({
      ctx: targetedCtx,
      status: targetedStatus,
      now: 2_000,
    });
    const refreshed = await refreshMergeReadyStatusBar({
      exec,
      ctx: createStatusContext(),
      now: 1_000 + MERGE_READY_STATUS_BAR_TTL_MS - 1,
    });

    assertDone();
    expect(targeted).toEqual({ text: '✅ #64 Ready', cached: false });
    expect(targetedCtx.ui?.setStatus).not.toHaveBeenCalled();
    expect(refreshed).toEqual({ text: '✅ #42 Ready', cached: true });
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
    const { exec, assertDone } = createFakeExec([
      createCurrentBranchProbeCall({ timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS }),
      createCurrentBranchProbeCall({ timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS }),
    ]);
    expect(isMergeReadyStatusBarSuspended()).toBe(true);
    expect(setStatus).toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, undefined);

    setStatus.mockClear();
    const hiddenRefresh = await refreshMergeReadyStatusBar({
      exec,
      ctx,
      now: 1_000 + MERGE_READY_STATUS_BAR_TTL_MS - 1,
    });

    expect(hiddenRefresh).toEqual({ text: '✅ #42 Ready', cached: true });
    expect(setStatus).toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, undefined);
    expect(setStatus).not.toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, '✅ #42 Ready');

    setStatus.mockClear();
    resume();
    expect(isMergeReadyStatusBarSuspended()).toBe(false);
    expect(setStatus).not.toHaveBeenCalled();

    const visibleRefresh = await refreshMergeReadyStatusBar({
      exec,
      ctx,
      now: 1_000 + MERGE_READY_STATUS_BAR_TTL_MS - 1,
    });

    assertDone();
    expect(visibleRefresh).toEqual({ text: '✅ #42 Ready', cached: true });
    expect(setStatus).toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, '✅ #42 Ready');
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
      createCurrentBranchProbeCall({ timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS }),
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

    expect(hiddenRefresh).toEqual({ text: '✅ #42 Ready', cached: false });
    expect(setStatus).toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, undefined);
    expect(setStatus).not.toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, '✅ #42 Ready');

    setStatus.mockClear();
    resume();
    expect(isMergeReadyStatusBarSuspended()).toBe(false);
    expect(setStatus).not.toHaveBeenCalled();

    const visibleRefresh = await refreshMergeReadyStatusBar({
      exec: api.exec,
      ctx,
      now: 2_000 + MERGE_READY_STATUS_BAR_TTL_MS - 1,
    });

    assertDone();
    expect(visibleRefresh).toEqual({ text: '✅ #42 Ready', cached: true });
    expect(setStatus).toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, '✅ #42 Ready');
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
      '❌ #42 💬 2 unresolved',
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
    expect(ctx.ui?.setStatus).toHaveBeenCalledWith(
      MERGE_READY_STATUS_BAR_KEY,
      '❌ #42 Checks failing',
    );
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
      createCurrentBranchProbeCall({ timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS }),
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
    expect(first).toEqual({ text: '✅ #42 Ready', cached: false });
    expect(second).toEqual({ text: '✅ #42 Ready', cached: true });
    expect(ctx.ui?.setStatus).toHaveBeenCalledTimes(2);
  });

  it('misses the TTL cache after a branch switch in the same checkout', async () => {
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
      createCurrentBranchProbeCall({
        timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
        branch: 'feat/status-bar-identity',
      }),
      ...createGitDiscoveryCalls({
        timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
        branch: 'feat/status-bar-identity',
      }),
      createPullRequestViewSuccessCall(
        buildPullRequestPayload({
          number: 64,
          title: 'Use branch identity for status-bar cache reuse',
          url: 'https://github.com/robhowley/pi-userland/pull/64',
          headRefName: 'feat/status-bar-identity',
        }),
        {
          timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
        },
      ),
      createConversationsSuccessCall(
        buildConversationsPayload({
          reviewThreads: {
            nodes: [{ isResolved: true }],
            pageInfo: { hasNextPage: false },
          },
        }),
        {
          timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
          pullRequestNumber: 64,
        },
      ),
    ]);
    const ctx = createStatusContext();

    const first = await refreshMergeReadyStatusBar({
      exec: api.exec,
      ctx,
      now: 3_000,
    });
    const second = await refreshMergeReadyStatusBar({
      exec: api.exec,
      ctx,
      now: 3_000 + MERGE_READY_STATUS_BAR_TTL_MS - 1,
    });

    assertDone();
    expect(first).toEqual({ text: '✅ #42 Ready', cached: false });
    expect(second).toEqual({ text: '✅ #64 Ready', cached: false });
  });

  it('does not treat an unknown current branch as a cache hit', async () => {
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
      createCurrentBranchProbeCall({
        timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
        branch: '',
      }),
      ...createGitDiscoveryCalls({ timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS, branch: '' }),
      createPullRequestViewFailureCall(
        {
          code: 1,
          stderr: 'no pull requests found for detached HEAD\n',
        },
        { timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS },
      ),
    ]);
    const ctx = createStatusContext();

    const first = await refreshMergeReadyStatusBar({
      exec: api.exec,
      ctx,
      now: 4_000,
    });
    const second = await refreshMergeReadyStatusBar({
      exec: api.exec,
      ctx,
      now: 4_000 + MERGE_READY_STATUS_BAR_TTL_MS - 1,
    });

    assertDone();
    expect(first).toEqual({ text: '✅ #42 Ready', cached: false });
    expect(second).toEqual({ text: '❔ No PR', cached: false });
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
    expect(first).toEqual({ text: '✅ #42 Ready', cached: false });
    expect(second).toEqual({ text: '✅ #42 Ready', cached: false });
  });

  describe('background TTL refresh', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it.each([
      { reason: 'reload', shutdownBeforeRestart: true },
      { reason: 'new', shutdownBeforeRestart: false },
    ])(
      'invalidates stale timers across $reason session transitions',
      async ({ reason, shutdownBeforeRestart }) => {
        const firstRuntime = createMockAPI([
          ...createGitDiscoveryCalls({ timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS }),
          createPullRequestViewSuccessCall(buildPullRequestPayload(), {
            timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
          }),
          createConversationsSuccessCall(buildConversationsPayload(), {
            timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
          }),
        ]);
        const secondRuntime = createMockAPI([
          ...createGitDiscoveryCalls({ timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS }),
          createPullRequestViewSuccessCall(buildPullRequestPayload(), {
            timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
          }),
          createConversationsSuccessCall(buildConversationsPayload(), {
            timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
          }),
          ...createGitDiscoveryCalls({ timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS }),
          createPullRequestViewSuccessCall(buildPullRequestPayload(), {
            timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
          }),
          createConversationsSuccessCall(buildConversationsPayload(), {
            timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
          }),
        ]);
        const firstCtx = createStatusContext();
        const secondCtx = createStatusContext();

        registerMergeReadyStatusBar(firstRuntime.api);
        registerMergeReadyStatusBar(secondRuntime.api);

        await firstRuntime.getHandler('session_start')?.({ reason: 'startup' }, firstCtx);
        vi.mocked(firstCtx.ui!.setStatus).mockClear();

        await vi.advanceTimersByTimeAsync(10_000);
        if (shutdownBeforeRestart) {
          await firstRuntime.getHandler('session_shutdown')?.({}, firstCtx);
        }
        await secondRuntime.getHandler('session_start')?.({ reason }, secondCtx);
        vi.mocked(secondCtx.ui!.setStatus).mockClear();

        await vi.advanceTimersByTimeAsync(MERGE_READY_STATUS_BAR_TTL_MS - 10_000);
        expect(firstCtx.ui?.setStatus).not.toHaveBeenCalled();
        expect(secondCtx.ui?.setStatus).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(10_000 - 1);
        expect(firstCtx.ui?.setStatus).not.toHaveBeenCalled();
        expect(secondCtx.ui?.setStatus).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);

        firstRuntime.assertDone();
        secondRuntime.assertDone();
        expect(firstCtx.ui?.setStatus).not.toHaveBeenCalled();
        expect(secondCtx.ui?.setStatus).toHaveBeenCalledWith(
          MERGE_READY_STATUS_BAR_KEY,
          '✅ #42 Ready',
        );
      },
    );

    it('uses the stored configured TTL for background refresh and timer re-arm', async () => {
      const sandbox = createSettingsSandbox();

      try {
        sandbox.writeProjectSettings({
          'pi-merge-ready': {
            cacheTTLSeconds: 5,
          },
        });

        const ctx = createStatusContext({ cwd: sandbox.cwd });
        const refreshExec = createFakeExec([
          ...createGitDiscoveryCalls({
            cwd: sandbox.cwd,
            timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
          }),
          createPullRequestViewSuccessCall(buildPullRequestPayload(), {
            cwd: sandbox.cwd,
            timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
          }),
          createConversationsSuccessCall(buildConversationsPayload(), {
            cwd: sandbox.cwd,
            timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
          }),
          ...createGitDiscoveryCalls({
            cwd: sandbox.cwd,
            timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
          }),
          createPullRequestViewSuccessCall(buildPullRequestPayload(), {
            cwd: sandbox.cwd,
            timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
          }),
          createConversationsSuccessCall(buildConversationsPayload(), {
            cwd: sandbox.cwd,
            timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
          }),
          ...createGitDiscoveryCalls({
            cwd: sandbox.cwd,
            timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
          }),
          createPullRequestViewSuccessCall(buildPullRequestPayload(), {
            cwd: sandbox.cwd,
            timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
          }),
          createConversationsSuccessCall(buildConversationsPayload(), {
            cwd: sandbox.cwd,
            timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
          }),
        ]);

        await refreshMergeReadyStatusBar({
          exec: refreshExec.exec,
          ctx,
          projectTrusted: true,
        });
        vi.mocked(ctx.ui!.setStatus).mockClear();

        sandbox.writeProjectSettings({
          'pi-merge-ready': {
            cacheTTLSeconds: 1,
          },
        });

        await vi.advanceTimersByTimeAsync(5_000 - 1);
        expect(ctx.ui?.setStatus).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(ctx.ui?.setStatus).toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, '✅ #42 Ready');

        vi.mocked(ctx.ui!.setStatus).mockClear();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(ctx.ui?.setStatus).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(4_000);

        refreshExec.assertDone();
        expect(ctx.ui?.setStatus).toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, '✅ #42 Ready');
      } finally {
        sandbox.cleanup();
      }
    });

    it('cached repaints swap the latest ctx without extending the original TTL', async () => {
      const initialCtx = createStatusContext();
      const latestCtx = createStatusContext();
      const initialRefresh = createFakeExec([
        ...createGitDiscoveryCalls({ timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS }),
        createPullRequestViewSuccessCall(buildPullRequestPayload(), {
          timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
        }),
        createConversationsSuccessCall(buildConversationsPayload(), {
          timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
        }),
      ]);
      const latestRefresh = createFakeExec([
        createCurrentBranchProbeCall({ timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS }),
        ...createGitDiscoveryCalls({ timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS }),
        createPullRequestViewSuccessCall(buildPullRequestPayload(), {
          timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
        }),
        createConversationsSuccessCall(buildConversationsPayload(), {
          timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
        }),
      ]);

      await refreshMergeReadyStatusBar({
        exec: initialRefresh.exec,
        ctx: initialCtx,
      });
      vi.mocked(initialCtx.ui!.setStatus).mockClear();

      await vi.advanceTimersByTimeAsync(10_000);
      const cached = await refreshMergeReadyStatusBar({
        exec: latestRefresh.exec,
        ctx: latestCtx,
      });

      expect(cached).toEqual({ text: '✅ #42 Ready', cached: true });
      expect(latestCtx.ui?.setStatus).toHaveBeenCalledWith(
        MERGE_READY_STATUS_BAR_KEY,
        '✅ #42 Ready',
      );
      vi.mocked(latestCtx.ui!.setStatus).mockClear();

      await vi.advanceTimersByTimeAsync(MERGE_READY_STATUS_BAR_TTL_MS - 10_000 - 1);
      expect(initialCtx.ui?.setStatus).not.toHaveBeenCalled();
      expect(latestCtx.ui?.setStatus).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);

      initialRefresh.assertDone();
      latestRefresh.assertDone();
      expect(initialCtx.ui?.setStatus).not.toHaveBeenCalled();
      expect(latestCtx.ui?.setStatus).toHaveBeenCalledWith(
        MERGE_READY_STATUS_BAR_KEY,
        '✅ #42 Ready',
      );
    });

    it('re-arms on ambient sync without letting URL-targeted sync move the ambient deadline', async () => {
      const initialCtx = createStatusContext();
      const ambientSyncCtx = createStatusContext();
      const urlSyncCtx = createStatusContext();
      const readyStatus = createMergeReadyStatus({
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
      const urlStatus = createMergeReadyStatus({
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
      const refreshExec = createFakeExec([
        ...createGitDiscoveryCalls({ timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS }),
        createPullRequestViewSuccessCall(buildPullRequestPayload(), {
          timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
        }),
        createConversationsSuccessCall(buildConversationsPayload(), {
          timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
        }),
        ...createGitDiscoveryCalls({ timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS }),
        createPullRequestViewSuccessCall(buildPullRequestPayload(), {
          timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
        }),
        createConversationsSuccessCall(buildConversationsPayload(), {
          timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
        }),
      ]);

      await refreshMergeReadyStatusBar({
        exec: refreshExec.exec,
        ctx: initialCtx,
      });
      vi.mocked(initialCtx.ui!.setStatus).mockClear();

      await vi.advanceTimersByTimeAsync(10_000);
      syncMergeReadyStatusBar({
        ctx: ambientSyncCtx,
        status: readyStatus,
        now: new Date(Date.now()),
      });
      vi.mocked(ambientSyncCtx.ui!.setStatus).mockClear();

      await vi.advanceTimersByTimeAsync(10_000);
      const targeted = syncMergeReadyStatusBar({
        ctx: urlSyncCtx,
        status: urlStatus,
        now: new Date(Date.now()),
      });

      expect(targeted).toEqual({ text: '✅ #64 Ready', cached: false });
      expect(urlSyncCtx.ui?.setStatus).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(MERGE_READY_STATUS_BAR_TTL_MS - 20_000);
      expect(initialCtx.ui?.setStatus).not.toHaveBeenCalled();
      expect(ambientSyncCtx.ui?.setStatus).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10_000 - 1);
      expect(initialCtx.ui?.setStatus).not.toHaveBeenCalled();
      expect(ambientSyncCtx.ui?.setStatus).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);

      refreshExec.assertDone();
      expect(initialCtx.ui?.setStatus).not.toHaveBeenCalled();
      expect(ambientSyncCtx.ui?.setStatus).toHaveBeenCalledWith(
        MERGE_READY_STATUS_BAR_KEY,
        '✅ #42 Ready',
      );
      expect(urlSyncCtx.ui?.setStatus).not.toHaveBeenCalled();
    });

    it('keeps timer retries TTL-paced after a failed background refresh', async () => {
      const ctx = createStatusContext();
      const refreshExec = createFakeExec([
        ...createGitDiscoveryCalls({ timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS }),
        createPullRequestViewSuccessCall(buildPullRequestPayload(), {
          timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
        }),
        createConversationsSuccessCall(buildConversationsPayload(), {
          timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
        }),
        {
          command: 'git',
          args: ['rev-parse', '--show-toplevel'],
          cwd: '/repo',
          timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
          error: new Error('spawn git EACCES'),
        },
        ...createGitDiscoveryCalls({ timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS }),
        createPullRequestViewSuccessCall(buildPullRequestPayload(), {
          timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
        }),
        createConversationsSuccessCall(buildConversationsPayload(), {
          timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
        }),
      ]);

      await refreshMergeReadyStatusBar({
        exec: refreshExec.exec,
        ctx,
      });
      vi.mocked(ctx.ui!.setStatus).mockClear();

      await vi.advanceTimersByTimeAsync(MERGE_READY_STATUS_BAR_TTL_MS);
      expect(ctx.ui?.setStatus).toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, '❔ No PR');

      vi.mocked(ctx.ui!.setStatus).mockClear();
      await vi.advanceTimersByTimeAsync(MERGE_READY_STATUS_BAR_TTL_MS - 1);
      expect(ctx.ui?.setStatus).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);

      refreshExec.assertDone();
      expect(ctx.ui?.setStatus).toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, '✅ #42 Ready');
    });
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
