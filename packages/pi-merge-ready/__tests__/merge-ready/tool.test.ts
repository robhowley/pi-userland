import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import mergeReadyExtension, {
  MERGE_READY_COMMAND_NAME,
  MERGE_READY_STATUS_TOOL_NAME,
  MERGE_READY_STATUS_TOOL_TIMEOUT_MS,
  registerMergeReadyStatusTool,
  type MergeReadyStatusToolContext,
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

type RegisteredTool = ReturnType<ReturnType<typeof createMockAPI>['getTool']>;

const GENERATED_AT = '2026-05-26T22:00:00.000Z';

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
      properties?: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };

    expect(tool).toMatchObject({
      name: MERGE_READY_STATUS_TOOL_NAME,
      label: 'Merge Ready Status',
      description: expect.stringContaining('current branch pull request by default'),
      promptGuidelines: expect.arrayContaining([
        expect.stringContaining('openItems'),
        expect.stringContaining('provenance'),
        expect.stringContaining('Do not infer work from raw GitHub states'),
        expect.stringContaining('full GitHub pull request URL'),
      ]),
    });
    expect(parameters.type).toBe('object');
    expect(parameters.properties).toEqual({
      url: { type: 'string' },
    });
    expect(parameters.additionalProperties).toBe(false);
    expect(parameters.required ?? []).toEqual([]);
  });

  it('returns a ready MergeReadyStatus as details and text JSON', async () => {
    const { api, assertDone, getTool } = createMockAPI([
      ...createGitDiscoveryCalls({ timeout: MERGE_READY_STATUS_TOOL_TIMEOUT_MS }),
      createPullRequestViewSuccessCall(buildPullRequestPayload(), {
        timeout: MERGE_READY_STATUS_TOOL_TIMEOUT_MS,
      }),
      createConversationsSuccessCall(
        buildConversationsPayload({
          reviewThreads: {
            nodes: [{ isResolved: true }],
            pageInfo: { hasNextPage: false },
          },
        }),
        { timeout: MERGE_READY_STATUS_TOOL_TIMEOUT_MS },
      ),
    ]);

    registerMergeReadyStatusTool(api);
    const tool = createRegisteredTool(getTool(MERGE_READY_STATUS_TOOL_NAME));

    const result = await tool.execute('tool-call-1', {}, undefined, undefined, createToolContext());

    assertDone();
    expect(result.details).toEqual({
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
        unresolvedConversations: false,
        unresolvedConversationRequirement: 'optional',
      },
      generatedAt: GENERATED_AT,
    });
    expect(result.details).not.toHaveProperty('issues');
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(result.details);
  });

  it('targets an explicit GitHub PR URL without public cwd input', async () => {
    const url = 'https://github.com/shopify/pi/pull/64';
    const { api, assertDone, getTool } = createMockAPI([
      {
        command: 'gh',
        args: ['pr', 'view', '64', '--repo', 'shopify/pi', '--json', GH_PR_VIEW_JSON_FIELDS],
        cwd: '/repo',
        timeout: MERGE_READY_STATUS_TOOL_TIMEOUT_MS,
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
        timeout: MERGE_READY_STATUS_TOOL_TIMEOUT_MS,
        repositoryOwner: 'shopify',
        repositoryName: 'pi',
        pullRequestNumber: 64,
      }),
    ]);

    registerMergeReadyStatusTool(api);
    const tool = createRegisteredTool(getTool(MERGE_READY_STATUS_TOOL_NAME));

    const result = await tool.execute(
      'tool-call-url',
      { url },
      undefined,
      undefined,
      createToolContext(),
    );

    assertDone();
    expect(result.details).toMatchObject({
      target: {
        mode: 'url',
        url,
        owner: 'shopify',
        repo: 'pi',
        prNumber: 64,
      },
      pr: {
        number: 64,
        title: 'Support explicit PR URL targets',
        url,
      },
    });
  });

  it('keeps optional unresolved comments in signals while leaving openItems blocker-only', async () => {
    const { api, assertDone, getTool } = createMockAPI([
      ...createGitDiscoveryCalls({ timeout: MERGE_READY_STATUS_TOOL_TIMEOUT_MS }),
      createPullRequestViewSuccessCall(buildPullRequestPayload(), {
        timeout: MERGE_READY_STATUS_TOOL_TIMEOUT_MS,
      }),
      createConversationsSuccessCall(
        buildConversationsPayload({
          reviewThreads: {
            nodes: [{ isResolved: false }, { isResolved: true }],
            pageInfo: { hasNextPage: false },
          },
        }),
        { timeout: MERGE_READY_STATUS_TOOL_TIMEOUT_MS },
      ),
    ]);

    registerMergeReadyStatusTool(api);
    const tool = createRegisteredTool(getTool(MERGE_READY_STATUS_TOOL_NAME));

    const result = await tool.execute(
      'tool-call-optional',
      {},
      undefined,
      undefined,
      createToolContext(),
    );

    assertDone();
    expect(result.details).toMatchObject({
      state: 'ready',
      summary: 'Ready to merge',
      openItems: [],
      signals: {
        unresolvedConversations: true,
        unresolvedConversationCount: 1,
        unresolvedConversationRequirement: 'optional',
      },
    });
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(result.details);
  });

  it('returns a blocked status with an agent-owned open item', async () => {
    const { api, assertDone, getTool } = createMockAPI([
      ...createGitDiscoveryCalls({ timeout: MERGE_READY_STATUS_TOOL_TIMEOUT_MS }),
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
        { timeout: MERGE_READY_STATUS_TOOL_TIMEOUT_MS },
      ),
      createConversationsSuccessCall(
        buildConversationsPayload({
          reviewThreads: {
            nodes: [{ isResolved: true }],
            pageInfo: { hasNextPage: false },
          },
        }),
        { timeout: MERGE_READY_STATUS_TOOL_TIMEOUT_MS },
      ),
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
        summary: 'Required checks are failing',
        details: [
          {
            label: 'ci / unit',
            status: 'failing',
            url: 'https://github.com/robhowley/pi-userland/actions/runs/123/jobs/456',
          },
        ],
      },
    ]);
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(result.details);
  });

  it('returns the restrained no-PR unknown status', async () => {
    const { api, assertDone, getTool } = createMockAPI([
      ...createGitDiscoveryCalls({ timeout: MERGE_READY_STATUS_TOOL_TIMEOUT_MS }),
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
      target: CURRENT_BRANCH_TARGET,
      pr: null,
      summary: 'No pull request found',
      openItems: [
        {
          id: 'no_pull_request',
          summary: 'No pull request found',
        },
      ],
      signals: {
        draft: false,
        mergeability: 'unknown',
        checks: 'unknown',
        review: 'unknown',
        unresolvedConversations: false,
        unresolvedConversationRequirement: 'unknown',
      },
      generatedAt: GENERATED_AT,
    });
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(result.details);
  });

  it('rejects invalid explicit URL targets instead of guessing', async () => {
    const { api, getTool } = createMockAPI();

    registerMergeReadyStatusTool(api);
    const tool = createRegisteredTool(getTool(MERGE_READY_STATUS_TOOL_NAME));

    await expect(
      tool.execute('tool-call-bad-url', { url: '64' }, undefined, undefined, createToolContext()),
    ).rejects.toThrow(
      'Invalid url: Pass a full HTTPS GitHub pull request URL like https://github.com/OWNER/REPO/pull/NUMBER with no query string, fragment, or extra path.',
    );
  });

  it('degrades thrown exec failures to an unknown MergeReadyStatus instead of throwing', async () => {
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
              target: { mode: 'current_branch' },
              pr: null,
              summary: 'No pull request found',
              openItems: [
                {
                  id: 'no_pull_request',
                  summary: 'No pull request found',
                },
              ],
              signals: {
                draft: false,
                mergeability: 'unknown',
                checks: 'unknown',
                review: 'unknown',
                unresolvedConversations: false,
                unresolvedConversationRequirement: 'unknown',
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
        target: { mode: 'current_branch' },
        pr: null,
        summary: 'No pull request found',
        openItems: [
          {
            id: 'no_pull_request',
            summary: 'No pull request found',
          },
        ],
        signals: {
          draft: false,
          mergeability: 'unknown',
          checks: 'unknown',
          review: 'unknown',
          unresolvedConversations: false,
          unresolvedConversationRequirement: 'unknown',
        },
        generatedAt: GENERATED_AT,
      },
    });

    assertDone();
  });
});
