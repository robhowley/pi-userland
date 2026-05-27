import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import mergeReadyExtension, {
  MERGE_READY_COMMAND_NAME,
  MERGE_READY_STATUS_TOOL_NAME,
  MERGE_READY_STATUS_TOOL_TIMEOUT_MS,
  registerMergeReadyStatusTool,
  type MergeReadyStatusToolContext,
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

type RegisteredTool = ReturnType<ReturnType<typeof createMockAPI>['getTool']>;

const GENERATED_AT = '2026-05-26T22:00:00.000Z';
const GH_PR_VIEW_JSON_FIELDS =
  'number,title,url,state,isDraft,mergeable,mergeStateStatus,headRefName,baseRefName,statusCheckRollup,reviews,reviewRequests,author';
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

function createMockAPI(expectedCalls: ExpectedExecCall[] = []) {
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

  const getTool = (name: string) =>
    vi.mocked(api.registerTool).mock.calls.find((call) => call[0].name === name)?.[0];

  return {
    api,
    assertDone: () => {
      expect(index).toBe(expectedCalls.length);
    },
    getTool,
  };
}

function createToolContext(cwd = '/repo'): MergeReadyStatusToolContext {
  return { cwd };
}

function createGitDiscoveryCalls(cwd = '/repo'): ExpectedExecCall[] {
  return [
    {
      command: 'git',
      args: ['rev-parse', '--show-toplevel'],
      cwd,
      timeout: MERGE_READY_STATUS_TOOL_TIMEOUT_MS,
      result: { stdout: `${cwd}\n` },
    },
    {
      command: 'git',
      args: ['branch', '--show-current'],
      cwd,
      timeout: MERGE_READY_STATUS_TOOL_TIMEOUT_MS,
      result: { stdout: 'feat/merge-ready\n' },
    },
    {
      command: 'git',
      args: ['remote'],
      cwd,
      timeout: MERGE_READY_STATUS_TOOL_TIMEOUT_MS,
      result: { stdout: 'origin\n' },
    },
    {
      command: 'git',
      args: ['remote', 'get-url', 'origin'],
      cwd,
      timeout: MERGE_READY_STATUS_TOOL_TIMEOUT_MS,
      result: { stdout: 'git@github.com:robhowley/pi-userland.git\n' },
    },
    {
      command: 'git',
      args: ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
      cwd,
      timeout: MERGE_READY_STATUS_TOOL_TIMEOUT_MS,
      result: { stdout: 'origin/main\n' },
    },
    {
      command: 'git',
      args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      cwd,
      timeout: MERGE_READY_STATUS_TOOL_TIMEOUT_MS,
      result: { stdout: 'origin/main\n' },
    },
    {
      command: 'git',
      args: ['rev-list', '--left-right', '--count', 'origin/main...HEAD'],
      cwd,
      timeout: MERGE_READY_STATUS_TOOL_TIMEOUT_MS,
      result: { stdout: '0 0\n' },
    },
    {
      command: 'git',
      args: ['status', '--porcelain', '--untracked-files=normal'],
      cwd,
      timeout: MERGE_READY_STATUS_TOOL_TIMEOUT_MS,
      result: { stdout: '' },
    },
  ];
}

function createPullRequestViewSuccessCall(
  payload: Record<string, unknown>,
  cwd = '/repo',
): ExpectedExecCall {
  return {
    command: 'gh',
    args: ['pr', 'view', '--json', GH_PR_VIEW_JSON_FIELDS],
    cwd,
    timeout: MERGE_READY_STATUS_TOOL_TIMEOUT_MS,
    result: {
      stdout: `${JSON.stringify(payload)}\n`,
    },
  };
}

function createConversationsSuccessCall(
  payload: Record<string, unknown>,
  cwd = '/repo',
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
    cwd,
    timeout: MERGE_READY_STATUS_TOOL_TIMEOUT_MS,
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
    reviewRequests: [],
    author: {
      login: 'robhowley',
      name: 'Robert Howley',
      is_bot: false,
    },
    ...overrides,
  };
}

function createRegisteredTool(tool: RegisteredTool): NonNullable<RegisteredTool> {
  expect(tool).toBeDefined();
  return tool as NonNullable<RegisteredTool>;
}

describe('merge_ready_status tool', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(GENERATED_AT));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers merge_ready_status alongside /merge-ready and status-bar hooks from the default export', () => {
    const { api, getTool } = createMockAPI();

    mergeReadyExtension(api as Parameters<typeof mergeReadyExtension>[0]);

    expect(api.on).toHaveBeenCalledTimes(2);
    expect(api.registerCommand).toHaveBeenCalledTimes(1);
    expect(api.registerCommand).toHaveBeenCalledWith(
      MERGE_READY_COMMAND_NAME,
      expect.objectContaining({ handler: expect.any(Function) }),
    );
    expect(api.registerTool).toHaveBeenCalledTimes(1);

    const tool = createRegisteredTool(getTool(MERGE_READY_STATUS_TOOL_NAME));
    const parameters = tool.parameters as {
      type?: string;
      required?: string[];
      additionalProperties?: boolean;
    };

    expect(tool).toMatchObject({
      name: MERGE_READY_STATUS_TOOL_NAME,
      label: 'Merge Ready Status',
      description: expect.stringContaining('MergeReadyStatus'),
      promptGuidelines: expect.arrayContaining([
        expect.stringContaining("owner === 'agent'"),
        expect.stringContaining('Do not infer work from raw GitHub states'),
      ]),
    });
    expect(parameters.type).toBe('object');
    expect(parameters.additionalProperties).toBe(false);
    expect(parameters.required ?? []).toEqual([]);
  });

  it('returns a ready MergeReadyStatus as details and text JSON', async () => {
    const { api, assertDone, getTool } = createMockAPI([
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

    registerMergeReadyStatusTool(api);
    const tool = createRegisteredTool(getTool(MERGE_READY_STATUS_TOOL_NAME));

    const result = await tool.execute('tool-call-1', {}, undefined, undefined, createToolContext());

    assertDone();
    expect(result.details).toEqual({
      state: 'ready',
      pr: {
        lifecycle: 'open',
        number: 42,
        title: 'Compose merge-ready status boundary',
        url: 'https://github.com/robhowley/pi-userland/pull/42',
      },
      summary: 'Ready to merge',
      openItems: [],
      signals: {
        discovery: 'complete',
        pullRequest: 'present',
        draft: 'no',
        checks: 'passing',
        review: 'approved',
        unresolvedConversations: 'no',
      },
      generatedAt: GENERATED_AT,
    });
    expect(result.details.pr).not.toHaveProperty('headRefName');
    expect(result.details).not.toHaveProperty('issues');
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(result.details);
  });

  it('returns a blocked status with an agent-owned open item', async () => {
    const { api, assertDone, getTool } = createMockAPI([
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
                nodes: [{ isResolved: true }],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      }),
    ]);

    registerMergeReadyStatusTool(api);
    const tool = createRegisteredTool(getTool(MERGE_READY_STATUS_TOOL_NAME));

    const result = await tool.execute('tool-call-2', {}, undefined, undefined, createToolContext());

    assertDone();
    expect(result.details.state).toBe('blocked');
    expect(result.details.summary).toBe('Required checks are failing');
    expect(result.details.openItems).toEqual([
      {
        id: 'ci_failing',
        owner: 'agent',
        actionability: 'actionable',
        summary: 'Required checks are failing',
      },
    ]);
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(result.details);
  });

  it('returns the restrained no-PR unknown status', async () => {
    const { api, assertDone, getTool } = createMockAPI([
      ...createGitDiscoveryCalls(),
      {
        command: 'gh',
        args: ['pr', 'view', '--json', GH_PR_VIEW_JSON_FIELDS],
        cwd: '/repo',
        timeout: MERGE_READY_STATUS_TOOL_TIMEOUT_MS,
        result: {
          code: 1,
          stderr: 'no pull requests found for branch "feat/merge-ready"\n',
        },
      },
    ]);

    registerMergeReadyStatusTool(api);
    const tool = createRegisteredTool(getTool(MERGE_READY_STATUS_TOOL_NAME));

    const result = await tool.execute('tool-call-3', {}, undefined, undefined, createToolContext());

    assertDone();
    expect(result.details).toEqual({
      state: 'unknown',
      pr: null,
      summary: 'No pull request found',
      openItems: [
        {
          id: 'no_pull_request',
          owner: 'user',
          actionability: 'actionable',
          summary: 'No pull request found',
        },
      ],
      signals: {
        discovery: 'complete',
        pullRequest: 'missing',
        draft: 'unknown',
        checks: 'unknown',
        review: 'unknown',
        unresolvedConversations: 'unknown',
      },
      generatedAt: GENERATED_AT,
    });
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(result.details);
  });

  it('uses an optional cwd override when provided', async () => {
    const cwd = '/alternate-repo';
    const { api, assertDone, getTool } = createMockAPI([
      ...createGitDiscoveryCalls(cwd),
      createPullRequestViewSuccessCall(buildPullRequestPayload(), cwd),
      createConversationsSuccessCall(
        {
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
        },
        cwd,
      ),
    ]);

    registerMergeReadyStatusTool(api);
    const tool = createRegisteredTool(getTool(MERGE_READY_STATUS_TOOL_NAME));

    await tool.execute('tool-call-4', { cwd }, undefined, undefined, createToolContext('/repo'));

    assertDone();
  });

  it('degrades thrown exec failures to an ambiguous MergeReadyStatus instead of throwing', async () => {
    const { api, assertDone, getTool } = createMockAPI([
      {
        command: 'git',
        args: ['rev-parse', '--show-toplevel'],
        cwd: '/repo',
        timeout: MERGE_READY_STATUS_TOOL_TIMEOUT_MS,
        error: new Error('spawn git EACCES'),
      },
    ]);

    registerMergeReadyStatusTool(api);
    const tool = createRegisteredTool(getTool(MERGE_READY_STATUS_TOOL_NAME));

    await expect(
      tool.execute('tool-call-5', {}, undefined, undefined, createToolContext()),
    ).resolves.toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              state: 'unknown',
              pr: null,
              summary: 'Merge readiness is ambiguous',
              openItems: [
                {
                  id: 'status_ambiguous',
                  owner: 'github',
                  actionability: 'actionable',
                  summary: 'Merge readiness is ambiguous',
                },
              ],
              signals: {
                discovery: 'ambiguous',
                pullRequest: 'unknown',
                draft: 'unknown',
                checks: 'unknown',
                review: 'unknown',
                unresolvedConversations: 'unknown',
              },
              generatedAt: GENERATED_AT,
            },
            null,
            2,
          ),
        },
      ],
      details: {
        state: 'unknown',
        pr: null,
        summary: 'Merge readiness is ambiguous',
        openItems: [
          {
            id: 'status_ambiguous',
            owner: 'github',
            actionability: 'actionable',
            summary: 'Merge readiness is ambiguous',
          },
        ],
        signals: {
          discovery: 'ambiguous',
          pullRequest: 'unknown',
          draft: 'unknown',
          checks: 'unknown',
          review: 'unknown',
          unresolvedConversations: 'unknown',
        },
        generatedAt: GENERATED_AT,
      },
    });

    assertDone();
  });
});
