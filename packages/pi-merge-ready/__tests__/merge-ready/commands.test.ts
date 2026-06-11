import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import mergeReadyExtension, {
  getActiveMergeReadyWatch,
  MERGE_READY_COMMAND_NAME,
  MERGE_READY_COMMAND_TIMEOUT_MS,
  MERGE_READY_COMMAND_USAGE,
  MERGE_READY_STATUS_BAR_KEY,
  MERGE_READY_STATUS_BAR_TTL_MS,
  MERGE_READY_WATCH_STATUS_KEY,
  MERGE_READY_WATCH_STOP_SHORTCUT,
  createMergeReadyStatus,
  parseMergeReadyCommandArgs,
  refreshMergeReadyStatusBar,
  renderMergeReadyStatus,
  resetMergeReadyStatusBarCache,
  resetMergeReadyWatchState,
  type MergeReadyCommandAPI,
  type MergeReadyCommandContext,
  type StartMergeReadyWatchOptions,
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

type CommandEvent = 'session_start' | 'turn_end' | 'session_shutdown' | 'agent_end';

function createMockAPI(expectedCalls: ExpectedExecCall[] = []): {
  api: MergeReadyCommandAPI & {
    on: ReturnType<typeof vi.fn>;
    registerShortcut: ReturnType<typeof vi.fn>;
    registerTool: ReturnType<typeof vi.fn>;
    sendUserMessage: ReturnType<typeof vi.fn>;
  };
  assertDone: () => void;
  getCommand: (
    name: string,
  ) => ((args: string, ctx: MergeReadyCommandContext) => Promise<void>) | undefined;
  getHandler: (event: CommandEvent) => ((event: unknown, ctx: unknown) => unknown) | undefined;
  getShortcutHandler: (
    shortcut: string,
  ) =>
    | ((ctx: {
        isIdle: () => boolean;
        hasPendingMessages: () => boolean;
        abort: () => void;
      }) => Promise<void> | void)
    | undefined;
} {
  let index = 0;
  const handlers = new Map<CommandEvent, (event: unknown, ctx: unknown) => unknown>();
  const shortcutHandlers = new Map<
    string,
    (ctx: {
      isIdle: () => boolean;
      hasPendingMessages: () => boolean;
      abort: () => void;
    }) => Promise<void> | void
  >();

  const api = {
    on: vi.fn((event: CommandEvent, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, handler);
    }),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(
      (
        shortcut: string,
        options: {
          description?: string;
          handler: (ctx: {
            isIdle: () => boolean;
            hasPendingMessages: () => boolean;
            abort: () => void;
          }) => Promise<void> | void;
        },
      ) => {
        shortcutHandlers.set(shortcut, options.handler);
      },
    ),
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
    getHandler: (event: CommandEvent) => handlers.get(event),
    getShortcutHandler: (shortcut: string) => shortcutHandlers.get(shortcut),
  };
}

function createCommandContext(
  options: {
    mode?: MergeReadyCommandContext['mode'];
    signal?: AbortSignal;
    compact?: MergeReadyCommandContext['compact'];
  } = {},
): MergeReadyCommandContext {
  return {
    cwd: '/repo',
    mode: options.mode ?? 'tui',
    isIdle: vi.fn(() => true),
    waitForIdle: vi.fn(async () => undefined),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.compact === undefined ? {} : { compact: options.compact }),
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
  };
}

async function flushMicrotasks(count = 4) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
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
    vi.restoreAllMocks();
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

    expect(api.on).toHaveBeenCalledTimes(4);
    expect(api.on).toHaveBeenCalledWith('session_start', expect.any(Function));
    expect(api.on).toHaveBeenCalledWith('turn_end', expect.any(Function));
    expect(api.on).toHaveBeenCalledWith('session_shutdown', expect.any(Function));
    expect(api.on).toHaveBeenCalledWith('agent_end', expect.any(Function));
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
    expect(parseMergeReadyCommandArgs('watch-ui')).toEqual({
      ok: true,
      mode: 'watch-ui',
      action: 'launch',
    });
    expect(parseMergeReadyCommandArgs('watch-ui stop')).toEqual({
      ok: true,
      mode: 'watch-ui',
      action: 'stop',
    });
  });

  it('launches watch-ui with API-level thinking level even when command ctx lacks it', async () => {
    vi.resetModules();

    const launchMergeReadyWatchUI = vi.fn(async (_options: unknown) => ({
      level: 'info' as const,
      message: 'mock watch-ui launch',
    }));
    const stopMergeReadyWatchUI = vi.fn(async (_options: unknown) => ({
      level: 'info' as const,
      message: 'mock watch-ui stop',
    }));

    vi.doMock('../../extensions/merge-ready/watch-ui/launcher.js', async () => {
      const actual = await vi.importActual<
        typeof import('../../extensions/merge-ready/watch-ui/launcher.js')
      >('../../extensions/merge-ready/watch-ui/launcher.js');
      return {
        ...actual,
        launchMergeReadyWatchUI,
        stopMergeReadyWatchUI,
      };
    });

    try {
      const { registerMergeReadyCommand } = await import('../../extensions/merge-ready/commands.js');
      const { api, getCommand } = createMockAPI();
      const getThinkingLevel = vi.fn(() => 'high' as const);
      const runtimeApi = { ...api, getThinkingLevel };

      registerMergeReadyCommand(runtimeApi);

      const handler = getCommand(MERGE_READY_COMMAND_NAME);
      const ctx = createCommandContext();
      const model: NonNullable<MergeReadyCommandContext['model']> = {
        id: 'claude-sonnet-4-20250514',
        name: 'Claude Sonnet 4',
        api: 'anthropic-messages',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1/messages',
        reasoning: true,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8_192,
      };
      const modelRegistry: NonNullable<MergeReadyCommandContext['modelRegistry']> = {
        getApiKeyAndHeaders: vi.fn(),
      };

      ctx.model = model;
      ctx.modelRegistry = modelRegistry;
      ctx.sessionManager = {
        getSessionDir: vi.fn(() => '/Users/me/.pi/agent-or/sessions/--repo--'),
      };

      expect('getThinkingLevel' in ctx).toBe(false);

      await handler?.('watch-ui', ctx);

      expect(launchMergeReadyWatchUI).toHaveBeenCalledTimes(1);
      expect(stopMergeReadyWatchUI).not.toHaveBeenCalled();
      const launchOptions = launchMergeReadyWatchUI.mock.calls[0]?.[0];
      expect(launchOptions).toEqual({
        exec: runtimeApi.exec,
        cwd: '/repo',
        getThinkingLevel,
        model,
        modelRegistry,
        sessionDir: '/Users/me/.pi/agent-or/sessions/--repo--',
      });
      expect(ctx.ui.notify).toHaveBeenCalledWith('mock watch-ui launch', 'info');
    } finally {
      vi.doUnmock('../../extensions/merge-ready/watch-ui/launcher.js');
      vi.resetModules();
    }
  });

  it('stops watch-ui for the current session agent', async () => {
    vi.resetModules();

    const launchMergeReadyWatchUI = vi.fn(async (_options: unknown) => ({
      level: 'info' as const,
      message: 'mock watch-ui launch',
    }));
    const stopMergeReadyWatchUI = vi.fn(async (_options: unknown) => ({
      level: 'info' as const,
      message: 'mock watch-ui stop',
    }));

    vi.doMock('../../extensions/merge-ready/watch-ui/launcher.js', async () => {
      const actual = await vi.importActual<
        typeof import('../../extensions/merge-ready/watch-ui/launcher.js')
      >('../../extensions/merge-ready/watch-ui/launcher.js');
      return {
        ...actual,
        launchMergeReadyWatchUI,
        stopMergeReadyWatchUI,
      };
    });

    try {
      const { registerMergeReadyCommand } = await import('../../extensions/merge-ready/commands.js');
      const { api, getCommand } = createMockAPI();

      registerMergeReadyCommand(api);

      const handler = getCommand(MERGE_READY_COMMAND_NAME);
      const ctx = createCommandContext();
      ctx.sessionManager = {
        getSessionDir: vi.fn(() => '/Users/me/.pi/agent-or/sessions/--repo--'),
      };

      await handler?.('watch-ui stop', ctx);

      expect(launchMergeReadyWatchUI).not.toHaveBeenCalled();
      expect(stopMergeReadyWatchUI).toHaveBeenCalledTimes(1);
      expect(stopMergeReadyWatchUI).toHaveBeenCalledWith({
        sessionDir: '/Users/me/.pi/agent-or/sessions/--repo--',
      });
      expect(ctx.ui.notify).toHaveBeenCalledWith('mock watch-ui stop', 'info');
    } finally {
      vi.doUnmock('../../extensions/merge-ready/watch-ui/launcher.js');
      vi.resetModules();
    }
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

  it('registers the Ctrl-Shift-S shortcut at extension load', () => {
    const { api } = createMockAPI();

    mergeReadyExtension(api);

    expect(api.registerShortcut).toHaveBeenCalledWith(
      MERGE_READY_WATCH_STOP_SHORTCUT,
      expect.objectContaining({
        description: 'Stop active merge-ready watch',
        handler: expect.any(Function),
      }),
    );
  });

  it('allows watch mode outside TUI when sendUserMessage is available', async () => {
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
    const ctx = createCommandContext({ mode: 'rpc', signal: abortController.signal });

    const run = handler?.('watch --interval 15', ctx) ?? Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(getActiveMergeReadyWatch()).not.toBeNull();

    abortController.abort();
    await run;

    assertDone();
    expect(getActiveMergeReadyWatch()).toBeNull();
    expect(vi.mocked(ctx.ui.notify)).toHaveBeenCalledWith(
      'Watching merge readiness for current branch PR every 15s.',
      'info',
    );
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(MERGE_READY_WATCH_STATUS_KEY, undefined);
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
      'Watching merge readiness for current branch PR every 15s. Press Ctrl-Shift-S to stop.',
      'info',
    );
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(MERGE_READY_WATCH_STATUS_KEY, undefined);
  });

  it('wraps callback-based compaction into a blocking watch promise', async () => {
    vi.resetModules();

    const startMergeReadyWatch = vi.fn(() => ({
      ok: false as const,
      level: 'warning' as const,
      message: 'mock watch start',
    }));

    vi.doMock('../../extensions/merge-ready/watch.js', async () => {
      const actual = await vi.importActual<typeof import('../../extensions/merge-ready/watch.js')>(
        '../../extensions/merge-ready/watch.js',
      );
      return {
        ...actual,
        startMergeReadyWatch,
      };
    });

    const { registerMergeReadyCommand } = await import('../../extensions/merge-ready/commands.js');
    const { api, getCommand } = createMockAPI();
    registerMergeReadyCommand(api);

    const handler = getCommand(MERGE_READY_COMMAND_NAME);
    let onComplete: (() => void) | undefined;
    let onError: ((error: Error) => void) | undefined;
    const compact = vi.fn(
      (options?: Parameters<NonNullable<MergeReadyCommandContext['compact']>>[0]) => {
        onComplete = options?.onComplete;
        onError = options?.onError;
      },
    );
    const ctx = createCommandContext({ compact });

    await handler?.('watch --interval 15', ctx);

    expect(startMergeReadyWatch).toHaveBeenCalledTimes(1);
    const startCall = startMergeReadyWatch.mock.calls[0];
    expect(startCall).toBeDefined();
    const [startOptions] = startCall as unknown as [StartMergeReadyWatchOptions];
    const watchCtx = startOptions.ctx;
    expect(watchCtx.compact).toBeTypeOf('function');

    const wrappedCompact = watchCtx.compact?.({
      customInstructions: 'Compaction triggered after successful merge-ready repair loop completion',
    });
    await flushMicrotasks();

    expect(compact).toHaveBeenCalledWith({
      customInstructions:
        'Compaction triggered after successful merge-ready repair loop completion',
      onComplete: expect.any(Function),
      onError: expect.any(Function),
    });
    expect(onComplete).toBeTypeOf('function');
    expect(onError).toBeTypeOf('function');

    let settled = false;
    wrappedCompact?.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await flushMicrotasks();
    expect(settled).toBe(false);

    onComplete?.();
    await expect(wrappedCompact).resolves.toBeUndefined();

    vi.doUnmock('../../extensions/merge-ready/watch.js');
    vi.resetModules();
  });

  it('queues URL-targeted repair with isolated-worktree instructions and waits for agent_end before refreshing', async () => {
    const url = 'https://github.com/shopify/pi/pull/64';
    const target = {
      mode: 'url' as const,
      url,
      owner: 'shopify',
      repo: 'pi',
      prNumber: 64,
    };
    const failingPullRequestPayload = buildPullRequestPayload({
      number: 64,
      title: 'Support explicit PR URL targets',
      url,
      headRefName: 'feat/explicit-pr-url',
      headRepository: {
        name: 'pi',
      },
      headRepositoryOwner: {
        login: 'shopify',
      },
      baseRefName: 'main',
      statusCheckRollup: [
        {
          __typename: 'CheckRun',
          workflowName: 'ci',
          name: 'unit',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          detailsUrl: 'https://github.example/checks/unit',
        },
      ],
    });
    const { api, assertDone, getCommand, getHandler } = createMockAPI([
      createPullRequestViewSuccessCall(failingPullRequestPayload, {
        cwd: '/repo',
        timeout: MERGE_READY_COMMAND_TIMEOUT_MS,
        target,
      }),
      createConversationsSuccessCall(buildConversationsPayload(), {
        cwd: '/repo',
        timeout: MERGE_READY_COMMAND_TIMEOUT_MS,
        repositoryOwner: 'shopify',
        repositoryName: 'pi',
        pullRequestNumber: 64,
      }),
      createPullRequestViewSuccessCall(failingPullRequestPayload, {
        cwd: '/repo',
        timeout: MERGE_READY_COMMAND_TIMEOUT_MS,
        target,
      }),
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

    const run = handler?.(`watch --url ${url} --interval 15`, ctx) ?? Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks(12);

    expect(getActiveMergeReadyWatch()).not.toBeNull();
    expect(api.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(api.sendUserMessage).toHaveBeenCalledWith(expect.any(String), {
      deliverAs: 'followUp',
    });
    expect(ctx.waitForIdle).not.toHaveBeenCalled();
    expect(vi.mocked(ctx.ui.notify).mock.calls).not.toContainEqual([
      `Stopping merge-ready watch for ${url}: the same actionable blocker is still present after one attempt.`,
      'warning',
    ]);

    await getHandler('agent_end')?.({}, ctx);
    await run;

    assertDone();
    const prompt = vi.mocked(api.sendUserMessage).mock.calls[0]?.[0];
    expect(prompt).toContain(`Use the merge-ready-loop skill for ${url}.`);
    expect(prompt).toContain('Do this URL-targeted repair in an isolated git worktree');
    expect(prompt).toContain(
      'If your environment supports isolated worker/session/agent contexts, prefer using one for this bounded repair',
    );
    expect(prompt).toContain('Do not assume any specific subagent framework.');
    expect(prompt).toContain('Do not mutate the ambient checkout.');
    expect(prompt).toContain("Use the snapshot's pr.headRepository and pr.headRefName");
    expect(ctx.ui.setStatus).not.toHaveBeenCalledWith(
      MERGE_READY_STATUS_BAR_KEY,
      expect.anything(),
    );
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      MERGE_READY_WATCH_STATUS_KEY,
      expect.stringContaining('Repair queued #64 · ci_failing'),
    );
    expect(vi.mocked(ctx.ui.notify).mock.calls).toContainEqual([
      `Stopping merge-ready watch for ${url}: the same actionable blocker is still present after one attempt.`,
      'warning',
    ]);
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
