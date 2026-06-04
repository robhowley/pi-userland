import type { MergeReadyCommandAPI } from './commands.js';
import type { MergeReadyExec, MergeReadyExecOptions, MergeReadyExecResult } from './git.js';
import { getMergeReadyStatus } from './merge-ready.js';
import { MERGE_READY_PULL_REQUEST_URL_EXAMPLE, validateGitHubPullRequestUrl } from './target.js';
import type { MergeReadyStatus } from './types.js';

export const MERGE_READY_STATUS_TOOL_NAME = 'merge_ready_status';
export const MERGE_READY_STATUS_TOOL_TIMEOUT_MS = 20_000;

export type MergeReadyStatusToolParams = {
  url?: string;
};

export type MergeReadyStatusToolContext = {
  cwd?: string;
};

export type MergeReadyStatusToolRegistration = {
  name: typeof MERGE_READY_STATUS_TOOL_NAME;
  label: string;
  description: string;
  promptGuidelines: string[];
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: MergeReadyStatusToolParams,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: MergeReadyStatusToolContext,
  ) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    details: MergeReadyStatus;
  }>;
};

export type MergeReadyStatusToolAPI = Pick<MergeReadyCommandAPI, 'exec'> & {
  registerTool: (tool: MergeReadyStatusToolRegistration) => void;
};

const MERGE_READY_STATUS_TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    url: { type: 'string' },
  },
  additionalProperties: false,
};

export function registerMergeReadyStatusTool(pi: MergeReadyStatusToolAPI): void {
  pi.registerTool({
    name: MERGE_READY_STATUS_TOOL_NAME,
    label: 'Merge Ready Status',
    description:
      'Returns the merge-readiness status for the current branch pull request by default, or for an exact GitHub pull request URL when `url` is provided. Use this before deciding whether a PR is ready to merge or before attempting to resolve merge blockers. The returned `openItems` array is the only authoritative list of merge-readiness items to work from.',
    promptGuidelines: [
      'Use openItems as the actionable list and do not invent additional blockers beyond what is returned.',
      'Do not infer work from raw GitHub states or assume hidden blockers beyond the returned MergeReadyStatus.',
      `When targeting a PR explicitly, pass only a full GitHub pull request URL like ${MERGE_READY_PULL_REQUEST_URL_EXAMPLE}.`,
      'Do not pass branch names, PR numbers, repo names, or other inferred targets.',
    ],
    parameters: MERGE_READY_STATUS_TOOL_PARAMETERS,
    async execute(_toolCallId, params = {}, _signal, _onUpdate, ctx) {
      let url: string | undefined;

      if (params.url !== undefined) {
        const validation = validateGitHubPullRequestUrl(params.url);
        if (!validation.ok) {
          throw new Error(`Invalid url: ${validation.message}`);
        }

        url = validation.target.url;
      }

      const status = await getMergeReadyStatus({
        exec: createToolExec(pi, ctx),
        ...withOptionalCwd(ctx.cwd),
        ...(url === undefined ? {} : { url }),
        timeout: MERGE_READY_STATUS_TOOL_TIMEOUT_MS,
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
        details: status,
      };
    },
  });
}

function createToolExec(
  pi: MergeReadyStatusToolAPI,
  ctx: MergeReadyStatusToolContext,
): MergeReadyExec {
  return async (
    command: string,
    args: string[],
    options?: MergeReadyExecOptions,
  ): Promise<MergeReadyExecResult> => {
    const execOptions: { cwd?: string; timeout?: number } = {
      ...withOptionalCwd(options?.cwd ?? ctx.cwd),
    };

    if (options?.timeout !== undefined) {
      execOptions.timeout = options.timeout;
    }

    return pi.exec(command, args, execOptions);
  };
}

function withOptionalCwd(cwd: string | undefined): { cwd?: string } {
  return cwd === undefined ? {} : { cwd };
}
