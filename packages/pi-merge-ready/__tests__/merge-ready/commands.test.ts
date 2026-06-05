import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import mergeReadyExtension, {
  getActiveMergeReadyWatch,
  MERGE_READY_COMMAND_NAME,
  MERGE_READY_COMMAND_TIMEOUT_MS,
  MERGE_READY_COMMAND_USAGE,
  MERGE_READY_STATUS_BAR_KEY,
  MERGE_READY_STATUS_BAR_TTL_MS,
  MERGE_READY_WATCH_STATUS_KEY,
  createMergeReadyStatus,
  parseMergeReadyCommandArgs,
  refreshMergeReadyStatusBar,
  renderMergeReadyStatus,
  resetMergeReadyStatusBarCache,
  resetMergeReadyWatchState,
  type MergeReadyCommandAPI,
  type MergeReadyCommandContext,
} from '../../extensions/merge-ready/index.js';
import {
  CURRENT_BRANCH_TARGET,
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
    sendUserMessage: ReturnType<typeof vi.fn>;
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
    sendUserMessage: vi.fn(async () => undefined),
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

function createCommandContext(options: { signal?: AbortSignal } = {}): MergeReadyCommandContext {
  return {
    cwd: '/repo',
    isIdle: vi.fn(() => true),
    waitForIdle: vi.fn(async () => undefined),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ui: {
      notify: vi.fn(),
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

describe('merge-ready command', () => {
  beforeEach(() => {
    resetMergeReadyStatusBarCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(GENERATED_AT));
  });

  afterEach(async () => {
    resetMergeReadyStatusBarCache();
    await resetMergeReadyWatchState();
    vi.useRealTimers();
  });

  it.each([
    {
      name: 'merge conflicts',
      status: createMergeReadyStatus({
        generatedAt: GENERATED_AT,
        target: CURRENT_BRANCH_TARGET,
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
      expected: {
        level: 'error',
        message: [
          '⚠️ Merge conflicts detected',
          'Target: current branch feat/merge-ready (robhowley/pi-userland)',
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
        target: CURRENT_BRANCH_TARGET,
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
      expected: {
        level: 'warning',
        message: [
          '🔄 Branch is out of date with base',
          'Target: current branch feat/merge-ready (robhowley/pi-userland)',
          'PR: #42 — Compose merge-ready status boundary',
          'State: blocked',
          'Open items:',
          '- Branch is out of date with base',
        ].join('\n'),
      },
    },
    {
      name: 'explicit URL target',
      status: createMergeReadyStatus({
        generatedAt: GENERATED_AT,
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
      }),
      expected: {
        level: 'info',
        message: [
          '✅ Ready to merge',
          'Target: https://github.com/shopify/pi/pull/64',
          'PR: #64 — Support explicit PR URL targets',
          'State: ready',
          'Open items: none',
        ].join('\n'),
      },
    },
  ])('renders $name via mergeability-aware badges', ({ status, expected }) => {
    expect(renderMergeReadyStatus(status)).toEqual(expected);
  });

  it('renders check detail rows under check open items', () => {
    const status = createMergeReadyStatus({
      generatedAt: GENERATED_AT,
      target: CURRENT_BRANCH_TARGET,
      pr: buildOpenPr(),
      signals: {
        draft: false,
        mergeability: 'mergeable',
        checks: 'failing',
        checkDetails: {
          failing: [
            {
              label: 'linting',
              status: 'failing',
              url: 'https://github.com/robhowley/pi-userland/actions/runs/123/jobs/456',
            },
            { label: 'PR Title Check', status: 'failing' },
          ],
          running: [],
          unknown: [],
        },
        review: 'approved',
        unresolvedConversations: false,
        unresolvedConversationRequirement: 'optional',
      },
    });

    expect(renderMergeReadyStatus(status)).toEqual({
      level: 'error',
      message: [
        '❌ Required checks are failing',
        'Target: current branch feat/merge-ready (robhowley/pi-userland)',
        'PR: #42 — Compose merge-ready status boundary',
        'State: blocked',
        'Open items:',
        '- Required checks are failing',
        '  - linting ❌ — https://github.com/robhowley/pi-userland/actions/runs/123/jobs/456',
        '  - PR Title Check ❌',
      ].join('\n'),
    });
  });

  it('renders URL-only open-item details uniformly', () => {
    const status = createMergeReadyStatus({
      generatedAt: GENERATED_AT,
      target: CURRENT_BRANCH_TARGET,
      pr: buildOpenPr(),
      openItems: [
        {
          id: 'changes_requested',
          summary: 'Changes requested by reviewers',
          details: [
            {
              label: 'alice requested changes',
              url: 'https://github.com/robhowley/pi-userland/pull/42#pullrequestreview-123456',
            },
          ],
        },
      ],
    });

    expect(renderMergeReadyStatus(status)).toEqual({
      level: 'error',
      message: [
        '🔁 Changes requested by reviewers',
        'Target: current branch feat/merge-ready (robhowley/pi-userland)',
        'PR: #42 — Compose merge-ready status boundary',
        'State: blocked',
        'Open items:',
        '- Changes requested by reviewers',
        '  - alice requested changes — https://github.com/robhowley/pi-userland/pull/42#pullrequestreview-123456',
      ].join('\n'),
    });
  });

  it('registers the /merge-ready command, status-bar hooks, and merge_ready_status tool from the default export', () => {
    const { api, getCommand } = createMockAPI();

    mergeReadyExtension(api as Parameters<typeof mergeReadyExtension>[0]);

    expect(api.on).toHaveBeenCalledTimes(3);
    expect(api.on).toHaveBeenCalledWith('session_start', expect.any(Function));
    expect(api.on).toHaveBeenCalledWith('turn_end', expect.any(Function));
    expect(api.on).toHaveBeenCalledWith('session_shutdown', expect.any(Function));
    expect(api.registerCommand).toHaveBeenCalledTimes(1);
    expect(api.registerCommand).toHaveBeenCalledWith(
      MERGE_READY_COMMAND_NAME,
      expect.objectContaining({
        description:
          'Show merge readiness for the current pull request or an explicit GitHub PR URL',
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
        'Target: current branch feat/merge-ready (robhowley/pi-userland)',
        'PR: #42 — Compose merge-ready status boundary',
        'State: ready',
        'Open items: none',
      ].join('\n'),
      'info',
    );
  });

  it('syncs the ambient status bar cache from the command status without an extra fetch', async () => {
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

  it('does not sync URL-targeted command results into the ambient status bar cache', async () => {
    const url = 'https://github.com/shopify/pi/pull/64';
    const { api, assertDone, getCommand } = createMockAPI([
      {
        command: 'gh',
        args: ['pr', 'view', '64', '--repo', 'shopify/pi', '--json', GH_PR_VIEW_JSON_FIELDS],
        cwd: '/repo',
        timeout: MERGE_READY_COMMAND_TIMEOUT_MS,
        result: {
          stdout: `${JSON.stringify(
            buildPullRequestPayload({
              number: 64,
              title: 'Support explicit PR URL targets',
              url,
              headRefName: 'feat/explicit-pr-url',
              baseRefName: 'main',
            }),
          )}\n`,
        },
      },
      createConversationsSuccessCall(buildConversationsPayload(), {
        cwd: '/repo',
        timeout: MERGE_READY_COMMAND_TIMEOUT_MS,
        repositoryOwner: 'shopify',
        repositoryName: 'pi',
        pullRequestNumber: 64,
      }),
    ]);

    mergeReadyExtension(api);
    const handler = getCommand(MERGE_READY_COMMAND_NAME);
    const ctx = createCommandContext();

    await handler?.(`--url ${url}`, ctx);

    const refreshed = await refreshMergeReadyStatusBar({
      exec: api.exec,
      ctx: {
        cwd: ctx.cwd,
        hasUI: true,
        ui: { setStatus: vi.fn() },
      },
      force: false,
      now: new Date(GENERATED_AT).getTime(),
    });

    assertDone();
    expect(ctx.ui.setStatus).not.toHaveBeenCalledWith(
      MERGE_READY_STATUS_BAR_KEY,
      expect.anything(),
    );
    expect(refreshed?.cached).toBe(false);
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
              detailsUrl: 'https://github.com/robhowley/pi-userland/actions/runs/123/jobs/456',
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
        'Target: current branch feat/merge-ready (robhowley/pi-userland)',
        'PR: #42 — Compose merge-ready status boundary',
        'State: blocked',
        'Open items:',
        '- Required checks are failing',
        '  - ci / unit ❌ — https://github.com/robhowley/pi-userland/actions/runs/123/jobs/456',
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
      [
        '❔ No pull request found',
        'Target: current branch feat/merge-ready (robhowley/pi-userland)',
        'State: unknown',
        'Open items:',
        '- No pull request found',
      ].join('\n'),
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
      target: CURRENT_BRANCH_TARGET,
      pr: {
        lifecycle: 'open',
        number: 42,
        title: 'Compose merge-ready status boundary',
        url: 'https://github.com/robhowley/pi-userland/pull/42',
        headRefName: 'feat/merge-ready',
        baseRefName: 'main',
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

  it('accepts --json and --url in either order', async () => {
    const url = 'https://github.com/shopify/pi/pull/64';
    const expectedCalls = [
      {
        command: 'gh',
        args: ['pr', 'view', '64', '--repo', 'shopify/pi', '--json', GH_PR_VIEW_JSON_FIELDS],
        cwd: '/repo',
        timeout: MERGE_READY_COMMAND_TIMEOUT_MS,
        result: {
          stdout: `${JSON.stringify(
            buildPullRequestPayload({
              number: 64,
              title: 'Support explicit PR URL targets',
              url,
              headRefName: 'feat/explicit-pr-url',
              baseRefName: 'main',
            }),
          )}\n`,
        },
      },
      createConversationsSuccessCall(buildConversationsPayload(), {
        cwd: '/repo',
        timeout: MERGE_READY_COMMAND_TIMEOUT_MS,
        repositoryOwner: 'shopify',
        repositoryName: 'pi',
        pullRequestNumber: 64,
      }),
    ];

    for (const args of [`--json --url ${url}`, `--url ${url} --json`]) {
      const { api, assertDone, getCommand } = createMockAPI(expectedCalls);
      mergeReadyExtension(api);
      const handler = getCommand(MERGE_READY_COMMAND_NAME);
      const ctx = createCommandContext();

      await handler?.(args, ctx);

      assertDone();
      const [message] = vi.mocked(ctx.ui.notify).mock.calls[0] ?? [];
      expect(JSON.parse(message as string)).toMatchObject({
        target: {
          mode: 'url',
          url,
        },
      });
    }
  });

  it('parses watch mode with default interval and accepts --url/--interval in either order', () => {
    const url = 'https://github.com/shopify/pi/pull/64';

    expect(parseMergeReadyCommandArgs('watch')).toEqual({
      ok: true,
      mode: 'watch',
      intervalSeconds: 60,
    });
    expect(parseMergeReadyCommandArgs(`watch --url ${url} --interval 30`)).toEqual({
      ok: true,
      mode: 'watch',
      url,
      intervalSeconds: 30,
    });
    expect(parseMergeReadyCommandArgs(`watch --interval 30 --url ${url}`)).toEqual({
      ok: true,
      mode: 'watch',
      url,
      intervalSeconds: 30,
    });
  });

  it('rejects invalid watch arguments with combined usage text', async () => {
    const { api, getCommand } = createMockAPI();
    mergeReadyExtension(api);
    const handler = getCommand(MERGE_READY_COMMAND_NAME);
    const ctx = createCommandContext();

    await handler?.('watch --json', ctx);
    await handler?.('watch --interval', ctx);
    await handler?.('watch --interval nope', ctx);
    await handler?.('watch --interval 14', ctx);
    await handler?.('watch --interval 3601', ctx);
    await handler?.('watch --url', ctx);
    await handler?.(
      'watch --url https://github.com/owner/repo/pull/1 --url https://github.com/owner/repo/pull/2',
      ctx,
    );
    await handler?.('watch --interval 30 --interval 45', ctx);
    await handler?.('watch --stop', ctx);

    expect(vi.mocked(ctx.ui.notify).mock.calls).toEqual([
      [`The --json flag is not supported in watch mode. ${MERGE_READY_COMMAND_USAGE}`, 'error'],
      [`Missing value for --interval. ${MERGE_READY_COMMAND_USAGE}`, 'error'],
      [
        `Invalid value for --interval: "nope". Expected a positive integer number of seconds. ${MERGE_READY_COMMAND_USAGE}`,
        'error',
      ],
      [`--interval must be at least 15 seconds. ${MERGE_READY_COMMAND_USAGE}`, 'error'],
      [`--interval must be at most 3600 seconds. ${MERGE_READY_COMMAND_USAGE}`, 'error'],
      [`Missing value for --url. ${MERGE_READY_COMMAND_USAGE}`, 'error'],
      [`Duplicate --url. ${MERGE_READY_COMMAND_USAGE}`, 'error'],
      [`Duplicate --interval. ${MERGE_READY_COMMAND_USAGE}`, 'error'],
      [`Unsupported arguments: --stop. ${MERGE_READY_COMMAND_USAGE}`, 'error'],
    ]);
  });

  it('keeps watch foreground until the command signal is aborted', async () => {
    const { api, assertDone, getCommand } = createMockAPI([
      ...createGitDiscoveryCalls({ timeout: MERGE_READY_COMMAND_TIMEOUT_MS }),
      createPullRequestViewSuccessCall(buildPullRequestPayload(), {
        timeout: MERGE_READY_COMMAND_TIMEOUT_MS,
      }),
      createConversationsSuccessCall(buildConversationsPayload(), {
        timeout: MERGE_READY_COMMAND_TIMEOUT_MS,
      }),
    ]);

    mergeReadyExtension(api);
    const handler = getCommand(MERGE_READY_COMMAND_NAME);
    const abortController = new AbortController();
    const ctx = createCommandContext({ signal: abortController.signal });

    const run = handler?.('watch --interval 15', ctx) ?? Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(getActiveMergeReadyWatch()).not.toBeNull();

    abortController.abort();
    await run;

    assertDone();
    expect(getActiveMergeReadyWatch()).toBeNull();
    expect(vi.mocked(ctx.ui.notify)).toHaveBeenCalledWith(
      'Watching merge readiness for current branch PR every 15s. Cancel the foreground command to stop.',
      'info',
    );
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(MERGE_READY_WATCH_STATUS_KEY, undefined);
  });

  it('does not sync the ambient status bar for URL-targeted watch polls', async () => {
    const url = 'https://github.com/shopify/pi/pull/64';
    const { api, assertDone, getCommand } = createMockAPI([
      {
        command: 'gh',
        args: ['pr', 'view', '64', '--repo', 'shopify/pi', '--json', GH_PR_VIEW_JSON_FIELDS],
        cwd: '/repo',
        timeout: MERGE_READY_COMMAND_TIMEOUT_MS,
        result: {
          stdout: `${JSON.stringify(
            buildPullRequestPayload({
              number: 64,
              title: 'Support explicit PR URL targets',
              url,
              headRefName: 'feat/explicit-pr-url',
              baseRefName: 'main',
            }),
          )}\n`,
        },
      },
      createConversationsSuccessCall(buildConversationsPayload(), {
        cwd: '/repo',
        timeout: MERGE_READY_COMMAND_TIMEOUT_MS,
        repositoryOwner: 'shopify',
        repositoryName: 'pi',
        pullRequestNumber: 64,
      }),
    ]);

    mergeReadyExtension(api);
    const handler = getCommand(MERGE_READY_COMMAND_NAME);
    const abortController = new AbortController();
    const ctx = createCommandContext({ signal: abortController.signal });

    const run = handler?.(`watch --url ${url} --interval 15`, ctx) ?? Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    abortController.abort();
    await run;

    assertDone();
    expect(ctx.ui.setStatus).not.toHaveBeenCalledWith(
      MERGE_READY_STATUS_BAR_KEY,
      expect.anything(),
    );
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      MERGE_READY_WATCH_STATUS_KEY,
      expect.stringContaining('Watching #64 · Ready to merge'),
    );
  });

  it('reports missing and duplicate --url errors clearly', async () => {
    const { api, getCommand } = createMockAPI();
    mergeReadyExtension(api);
    const handler = getCommand(MERGE_READY_COMMAND_NAME);
    const ctx = createCommandContext();

    await handler?.('--url', ctx);
    await handler?.(
      '--url https://github.com/owner/repo/pull/1 --url https://github.com/owner/repo/pull/2',
      ctx,
    );

    expect(vi.mocked(ctx.ui.notify).mock.calls).toEqual([
      [`Missing value for --url. ${MERGE_READY_COMMAND_USAGE}`, 'error'],
      [`Duplicate --url. ${MERGE_READY_COMMAND_USAGE}`, 'error'],
    ]);
  });

  it('rejects invalid explicit targets instead of guessing', async () => {
    const { api, getCommand } = createMockAPI();
    mergeReadyExtension(api);
    const handler = getCommand(MERGE_READY_COMMAND_NAME);
    const ctx = createCommandContext();

    await handler?.('--url 64', ctx);
    await handler?.('--url branch-name', ctx);
    await handler?.('--url https://github.com/owner/repo/issues/64', ctx);

    const invalidMessage =
      'Invalid --url: Pass a full HTTPS GitHub pull request URL like https://github.com/OWNER/REPO/pull/NUMBER with no query string, fragment, or extra path.';
    expect(vi.mocked(ctx.ui.notify).mock.calls).toEqual([
      [invalidMessage, 'error'],
      [invalidMessage, 'error'],
      [invalidMessage, 'error'],
    ]);
  });
});
