import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import mergeReadyExtension, {
  MERGE_READY_COMMAND_NAME,
  MERGE_READY_COMMAND_TIMEOUT_MS,
  createMergeReadyStatus,
  renderMergeReadyStatus,
  type MergeReadyCommandAPI,
  type MergeReadyCommandContext,
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
  };
  error?: unknown;
};

const GENERATED_AT = '2026-05-26T22:00:00.000Z';
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
  '}',
  '}',
  '}',
].join(' ');

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
    },
  };
}

function createGitDiscoveryCalls(): ExpectedExecCall[] {
  return [
    {
      command: 'git',
      args: ['rev-parse', '--show-toplevel'],
      cwd: '/repo',
      timeout: MERGE_READY_COMMAND_TIMEOUT_MS,
      result: { stdout: '/repo\n' },
    },
    {
      command: 'git',
      args: ['branch', '--show-current'],
      cwd: '/repo',
      timeout: MERGE_READY_COMMAND_TIMEOUT_MS,
      result: { stdout: 'feat/merge-ready\n' },
    },
    {
      command: 'git',
      args: ['remote'],
      cwd: '/repo',
      timeout: MERGE_READY_COMMAND_TIMEOUT_MS,
      result: { stdout: 'origin\n' },
    },
    {
      command: 'git',
      args: ['remote', 'get-url', 'origin'],
      cwd: '/repo',
      timeout: MERGE_READY_COMMAND_TIMEOUT_MS,
      result: { stdout: 'git@github.com:robhowley/pi-userland.git\n' },
    },
    {
      command: 'git',
      args: ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
      cwd: '/repo',
      timeout: MERGE_READY_COMMAND_TIMEOUT_MS,
      result: { stdout: 'origin/main\n' },
    },
    {
      command: 'git',
      args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      cwd: '/repo',
      timeout: MERGE_READY_COMMAND_TIMEOUT_MS,
      result: { stdout: 'origin/main\n' },
    },
    {
      command: 'git',
      args: ['rev-list', '--left-right', '--count', 'origin/main...HEAD'],
      cwd: '/repo',
      timeout: MERGE_READY_COMMAND_TIMEOUT_MS,
      result: { stdout: '0 0\n' },
    },
    {
      command: 'git',
      args: ['status', '--porcelain', '--untracked-files=normal'],
      cwd: '/repo',
      timeout: MERGE_READY_COMMAND_TIMEOUT_MS,
      result: { stdout: '' },
    },
  ];
}

function createPullRequestViewSuccessCall(payload: Record<string, unknown>): ExpectedExecCall {
  return {
    command: 'gh',
    args: ['pr', 'view', '--json', GH_PR_VIEW_JSON_FIELDS],
    cwd: '/repo',
    timeout: MERGE_READY_COMMAND_TIMEOUT_MS,
    result: {
      stdout: `${JSON.stringify(payload)}\n`,
    },
  };
}

function createConversationsSuccessCall(payload: Record<string, unknown>): ExpectedExecCall {
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
    timeout: MERGE_READY_COMMAND_TIMEOUT_MS,
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

describe('merge-ready command', () => {
  beforeEach(() => {
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
      ...createGitDiscoveryCalls(),
      createPullRequestViewSuccessCall(buildPullRequestPayload()),
      createConversationsSuccessCall({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [{ isResolved: true }],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      }),
    ]);

    mergeReadyExtension(api);
    const handler = getCommand(MERGE_READY_COMMAND_NAME);
    const ctx = createCommandContext();

    await handler?.('', ctx);

    assertDone();
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

  it('renders blocked output with open items', async () => {
    const { api, assertDone, getCommand } = createMockAPI([
      ...createGitDiscoveryCalls(),
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
      ),
      createConversationsSuccessCall({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [{ isResolved: false }, { isResolved: true }],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      }),
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
        '- 1 unresolved review conversation remains',
      ].join('\n'),
      'error',
    );
  });

  it('renders no-PR unknown output', async () => {
    const { api, assertDone, getCommand } = createMockAPI([
      ...createGitDiscoveryCalls(),
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
      ...createGitDiscoveryCalls(),
      createPullRequestViewSuccessCall(buildPullRequestPayload()),
      createConversationsSuccessCall({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [{ isResolved: true }],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      }),
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
        unresolvedConversations: false,
      },
      generatedAt: GENERATED_AT,
    });
  });
});
