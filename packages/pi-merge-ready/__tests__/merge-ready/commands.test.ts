import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import mergeReadyExtension, {
  MERGE_READY_COMMAND_NAME,
  MERGE_READY_COMMAND_TIMEOUT_MS,
  MERGE_READY_STATUS_BAR_KEY,
  MERGE_READY_STATUS_BAR_TTL_MS,
  createMergeReadyStatus,
  refreshMergeReadyStatusBar,
  renderMergeReadyStatus,
  resetMergeReadyStatusBarCache,
  type MergeReadyCommandAPI,
  type MergeReadyCommandContext,
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

const GENERATED_AT = '2026-05-26T22:00:00.000Z';

function createMockAPI(expectedCalls: ExpectedExecCall[] = []): {
  api: MergeReadyCommandAPI & {
    on: ReturnType<typeof vi.fn>;
    registerTool: ReturnType<typeof vi.fn>;
  };
  assertDone: () => void;
  getCommand: (
    name: string,
  ) => ((args: string, ctx: MergeReadyCommandContext) => Promise<void>) | undefined;
} {
  let index = 0;

  const api = {
    on: vi.fn(),
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
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
        };
      },
    ),
  };

  const getCommand = (name: string) =>
    vi.mocked(api.registerCommand).mock.calls.find((call) => call[0] === name)?.[1].handler;

  return {
    api,
    assertDone: () => {
      expect(index).toBe(expectedCalls.length);
    },
    getCommand,
  };
}

function createCommandContext(): MergeReadyCommandContext {
  return {
    cwd: '/repo',
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
  };
}

describe('merge-ready command', () => {
  beforeEach(() => {
    resetMergeReadyStatusBarCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(GENERATED_AT));
  });

  it.each([
    {
      name: 'merge conflicts',
      status: createMergeReadyStatus({
        generatedAt: GENERATED_AT,
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
      expected: {
        level: 'error',
        message: [
          '⚠️ Merge conflicts detected',
          'PR: #42 — Compose merge-ready status boundary',
          'State: blocked',
          'Open items:',
          '- Merge conflicts detected',
        ].join('\n'),
      },
    },
    {
      name: 'branch out of date',
      status: createMergeReadyStatus({
        generatedAt: GENERATED_AT,
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
      expected: {
        level: 'warning',
        message: [
          '🔄 Branch is out of date with base',
          'PR: #42 — Compose merge-ready status boundary',
          'State: blocked',
          'Open items:',
          '- Branch is out of date with base',
        ].join('\n'),
      },
    },
    {
      name: 'generic merge blocked',
      status: createMergeReadyStatus({
        generatedAt: GENERATED_AT,
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
      expected: {
        level: 'error',
        message: [
          '⛔ GitHub reports merge is blocked',
          'PR: #42 — Compose merge-ready status boundary',
          'State: blocked',
          'Open items:',
          '- GitHub reports merge is blocked',
        ].join('\n'),
      },
    },
  ])('renders $name via mergeability-aware badges', ({ status, expected }) => {
    expect(renderMergeReadyStatus(status)).toEqual(expected);
  });

  afterEach(() => {
    resetMergeReadyStatusBarCache();
    vi.useRealTimers();
  });

  it('registers the /merge-ready command, status-bar hooks, and merge_ready_status tool from the default export', () => {
    const { api, getCommand } = createMockAPI();

    mergeReadyExtension(api as Parameters<typeof mergeReadyExtension>[0]);

    expect(api.on).toHaveBeenCalledTimes(2);
    expect(api.on).toHaveBeenCalledWith('session_start', expect.any(Function));
    expect(api.on).toHaveBeenCalledWith('turn_end', expect.any(Function));
    expect(api.registerCommand).toHaveBeenCalledTimes(1);
    expect(api.registerCommand).toHaveBeenCalledWith(
      MERGE_READY_COMMAND_NAME,
      expect.objectContaining({
        description: 'Show merge readiness for the current pull request',
        handler: expect.any(Function),
      }),
    );
    expect(getCommand(MERGE_READY_COMMAND_NAME)).toBeTypeOf('function');
    expect(api.registerTool).toHaveBeenCalledTimes(1);
    expect(api.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'merge_ready_status',
        execute: expect.any(Function),
      }),
    );
  });

  it('renders concise ready output by default', async () => {
    const { api, assertDone, getCommand } = createMockAPI([
      ...createGitDiscoveryCalls({ timeout: MERGE_READY_COMMAND_TIMEOUT_MS }),
      createPullRequestViewSuccessCall(buildPullRequestPayload(), {
        timeout: MERGE_READY_COMMAND_TIMEOUT_MS,
      }),
      createConversationsSuccessCall(
        buildConversationsPayload({
          reviewThreads: {
            nodes: [{ isResolved: true }],
            pageInfo: { hasNextPage: false },
          },
        }),
        { timeout: MERGE_READY_COMMAND_TIMEOUT_MS },
      ),
    ]);

    mergeReadyExtension(api);
    const handler = getCommand(MERGE_READY_COMMAND_NAME);
    const ctx = createCommandContext();

    await handler?.('', ctx);

    assertDone();
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, '✅ Ready');
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      [
        '✅ Ready to merge',
        'PR: #42 — Compose merge-ready status boundary',
        'State: ready',
        'Open items: none',
      ].join('\n'),
      'info',
    );
  });

  it('syncs the status bar cache from the command status without an extra fetch', async () => {
    const { api, assertDone, getCommand } = createMockAPI([
      ...createGitDiscoveryCalls({ timeout: MERGE_READY_COMMAND_TIMEOUT_MS }),
      createPullRequestViewSuccessCall(buildPullRequestPayload(), {
        timeout: MERGE_READY_COMMAND_TIMEOUT_MS,
      }),
      createConversationsSuccessCall(
        buildConversationsPayload({
          reviewThreads: {
            nodes: [{ isResolved: true }],
            pageInfo: { hasNextPage: false },
          },
        }),
        { timeout: MERGE_READY_COMMAND_TIMEOUT_MS },
      ),
    ]);

    mergeReadyExtension(api);
    const handler = getCommand(MERGE_READY_COMMAND_NAME);
    const ctx = createCommandContext();

    await handler?.('', ctx);

    const refreshCtx = {
      cwd: ctx.cwd,
      hasUI: true,
      ui: {
        setStatus: vi.fn(),
      },
    };
    const refreshed = await refreshMergeReadyStatusBar({
      exec: api.exec,
      ctx: refreshCtx,
      now: new Date(GENERATED_AT).getTime() + MERGE_READY_STATUS_BAR_TTL_MS - 1,
    });

    assertDone();
    expect(refreshed).toEqual({ text: '✅ Ready', cached: true });
    expect(refreshCtx.ui.setStatus).toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, '✅ Ready');
  });

  it('keeps optional unresolved comments out of human blocker output', async () => {
    const { api, assertDone, getCommand } = createMockAPI([
      ...createGitDiscoveryCalls({ timeout: MERGE_READY_COMMAND_TIMEOUT_MS }),
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
        { timeout: MERGE_READY_COMMAND_TIMEOUT_MS },
      ),
      createConversationsSuccessCall(
        buildConversationsPayload({
          reviewThreads: {
            nodes: [{ isResolved: false }, { isResolved: true }],
            pageInfo: { hasNextPage: false },
          },
        }),
        { timeout: MERGE_READY_COMMAND_TIMEOUT_MS },
      ),
    ]);

    mergeReadyExtension(api);
    const handler = getCommand(MERGE_READY_COMMAND_NAME);
    const ctx = createCommandContext();

    await handler?.('', ctx);

    assertDone();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      [
        '❌ Required checks are failing',
        'PR: #42 — Compose merge-ready status boundary',
        'State: blocked',
        'Open items:',
        '- Required checks are failing',
      ].join('\n'),
      'error',
    );
  });

  it('renders no-PR unknown output', async () => {
    const { api, assertDone, getCommand } = createMockAPI([
      ...createGitDiscoveryCalls({ timeout: MERGE_READY_COMMAND_TIMEOUT_MS }),
      {
        command: 'gh',
        args: ['pr', 'view', '--json', GH_PR_VIEW_JSON_FIELDS],
        cwd: '/repo',
        timeout: MERGE_READY_COMMAND_TIMEOUT_MS,
        result: {
          code: 1,
          stderr: 'no pull requests found for branch "feat/merge-ready"\n',
        },
      },
    ]);

    mergeReadyExtension(api);
    const handler = getCommand(MERGE_READY_COMMAND_NAME);
    const ctx = createCommandContext();

    await handler?.('', ctx);

    assertDone();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      ['❔ No pull request found', 'State: unknown', 'Open items:', '- No pull request found'].join(
        '\n',
      ),
      'warning',
    );
  });

  it('renders restrained MergeReadyStatus JSON with --json', async () => {
    const { api, assertDone, getCommand } = createMockAPI([
      ...createGitDiscoveryCalls({ timeout: MERGE_READY_COMMAND_TIMEOUT_MS }),
      createPullRequestViewSuccessCall(buildPullRequestPayload(), {
        timeout: MERGE_READY_COMMAND_TIMEOUT_MS,
      }),
      createConversationsSuccessCall(
        buildConversationsPayload({
          reviewThreads: {
            nodes: [{ isResolved: false }, { isResolved: true }],
            pageInfo: { hasNextPage: false },
          },
        }),
        { timeout: MERGE_READY_COMMAND_TIMEOUT_MS },
      ),
    ]);

    mergeReadyExtension(api);
    const handler = getCommand(MERGE_READY_COMMAND_NAME);
    const ctx = createCommandContext();

    await handler?.('--json', ctx);

    assertDone();
    const [message, level] = vi.mocked(ctx.ui.notify).mock.calls[0] ?? [];
    expect(level).toBe('info');
    expect(JSON.parse(message as string)).toEqual({
      state: 'ready',
      pr: {
        number: 42,
        title: 'Compose merge-ready status boundary',
        url: 'https://github.com/robhowley/pi-userland/pull/42',
      },
      summary: 'Ready to merge',
      openItems: [],
      signals: {
        draft: false,
        mergeability: 'mergeable',
        checks: 'passing',
        review: 'approved',
        unresolvedConversations: true,
        unresolvedConversationCount: 1,
        unresolvedConversationRequirement: 'optional',
      },
      generatedAt: GENERATED_AT,
    });
  });
});
