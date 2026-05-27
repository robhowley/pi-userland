import type { MergeReadyExec, MergeReadyExecOptions, MergeReadyExecResult } from './git.js';

export type MergeReadyConversationIssue = {
  code:
    | 'non_zero_exit'
    | 'threw'
    | 'invalid_json'
    | 'invalid_shape'
    | 'partial_shape'
    | 'api_error'
    | 'page_limit';
  message: string;
  command: string;
  args: string[];
  cwd?: string | undefined;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  field?: string | undefined;
};

export type MergeReadyPullRequestConversations =
  | {
      kind: 'known';
      unresolvedCount: number;
      issues: MergeReadyConversationIssue[];
    }
  | {
      kind: 'partial';
      unresolvedCount: number;
      issues: MergeReadyConversationIssue[];
    }
  | {
      kind: 'failure';
      reason: 'auth' | 'api' | 'command';
      issues: MergeReadyConversationIssue[];
    }
  | {
      kind: 'invalid_json';
      issues: MergeReadyConversationIssue[];
    }
  | {
      kind: 'invalid_shape';
      issues: MergeReadyConversationIssue[];
    };

export type FetchMergeReadyPullRequestConversationsOptions = {
  exec: MergeReadyExec;
  repositoryOwner: string;
  repositoryName: string;
  pullRequestNumber: number;
  cwd?: string;
  timeout?: number;
};

type SuccessfulCommand = {
  ok: true;
  stdout: string;
  stderr: string;
  exitCode: number;
};

type FailedCommand = {
  ok: false;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  reason: 'non_zero_exit' | 'threw';
};

type CommandResult = SuccessfulCommand | FailedCommand;

type IssueContext = {
  command: string;
  args: string[];
  cwd?: string | undefined;
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

const REVIEW_THREADS_PAGE_SIZE = 100;
const GH_GRAPHQL_REVIEW_THREADS_QUERY = [
  'query MergeReadyReviewThreads($owner: String!, $name: String!, $number: Int!) {',
  'repository(owner: $owner, name: $name) {',
  'pullRequest(number: $number) {',
  `reviewThreads(first: ${String(REVIEW_THREADS_PAGE_SIZE)}) {`,
  'nodes { isResolved }',
  'pageInfo { hasNextPage }',
  '}',
  '}',
  '}',
  '}',
].join(' ');
const AUTH_FAILURE_RE =
  /gh auth login|authentication required|not logged (?:into|in) any hosts|HTTP 401|requires authentication|token .* invalid|resource not accessible by integration/i;
const API_FAILURE_RE =
  /GraphQL:|API rate limit exceeded|HTTP [45]\d\d|failed to connect|dial tcp|i\/o timeout|timed out|context deadline exceeded|EOF|could not resolve to/i;

export async function fetchMergeReadyPullRequestConversations(
  options: FetchMergeReadyPullRequestConversationsOptions,
): Promise<MergeReadyPullRequestConversations> {
  const args = [
    'api',
    'graphql',
    '-f',
    `query=${GH_GRAPHQL_REVIEW_THREADS_QUERY}`,
    '-F',
    `owner=${options.repositoryOwner}`,
    '-F',
    `name=${options.repositoryName}`,
    '-F',
    `number=${String(options.pullRequestNumber)}`,
  ];
  const commandResult = await runCommand(options.exec, 'gh', args, options.cwd, options.timeout);

  if (!commandResult.ok) {
    const issue = createIssue(
      {
        command: 'gh',
        args,
        cwd: options.cwd,
        exitCode: commandResult.exitCode,
        stdout: commandResult.stdout,
        stderr: commandResult.stderr,
      },
      commandResult.reason,
      commandResult.reason === 'threw'
        ? 'gh api graphql threw while fetching pull request conversations'
        : `gh api graphql exited with code ${String(commandResult.exitCode)}`,
    );

    return {
      kind: 'failure',
      reason: classifyFailureReason(commandResult.stderr, commandResult.stdout),
      issues: [issue],
    };
  }

  const issueContext: IssueContext = {
    command: 'gh',
    args,
    cwd: options.cwd,
    exitCode: commandResult.exitCode,
    stdout: commandResult.stdout,
    stderr: commandResult.stderr,
  };

  const parsedJson = parseJson(commandResult.stdout, issueContext);
  if (!parsedJson.ok) {
    return { kind: 'invalid_json', issues: [parsedJson.issue] };
  }

  const graphqlFailure = parseGraphQLErrorOutcome(parsedJson.value, issueContext);
  if (graphqlFailure) {
    return graphqlFailure;
  }

  return normalizeConversationOutcome(parsedJson.value, issueContext);
}

async function runCommand(
  exec: MergeReadyExec,
  command: string,
  args: string[],
  cwd: string | undefined,
  timeout: number | undefined,
): Promise<CommandResult> {
  try {
    const rawResult = await exec(command, args, createExecOptions(cwd, timeout));
    const result = normalizeExecResult(rawResult);

    if (result.exitCode === 0) {
      return { ok: true, ...result };
    }

    return { ok: false, ...result, reason: 'non_zero_exit' };
  } catch (error) {
    return {
      ok: false,
      stdout: getErrorStringProperty(error, 'stdout'),
      stderr: getErrorStringProperty(error, 'stderr') || getErrorMessage(error),
      exitCode: getErrorNumberProperty(error, 'exitCode') ?? getErrorNumberProperty(error, 'code'),
      reason: 'threw',
    };
  }
}

function normalizeConversationOutcome(
  value: unknown,
  issueContext: IssueContext,
): MergeReadyPullRequestConversations {
  const issues: MergeReadyConversationIssue[] = [];
  const reviewThreads = readReviewThreads(value, issueContext, issues);
  if (!reviewThreads) {
    return { kind: 'invalid_shape', issues };
  }

  let unresolvedCount = 0;
  let isPartial = false;

  for (const [index, node] of reviewThreads.nodes.entries()) {
    if (!isRecord(node)) {
      issues.push(
        createIssue(
          issueContext,
          'partial_shape',
          'gh api graphql returned a non-object review thread node',
          `data.repository.pullRequest.reviewThreads.nodes[${String(index)}]`,
        ),
      );
      isPartial = true;
      continue;
    }

    const isResolved = parseOptionalBoolean(node['isResolved']);
    if (isResolved === null) {
      issues.push(
        createIssue(
          issueContext,
          'partial_shape',
          'gh api graphql returned a review thread without a valid isResolved flag',
          `data.repository.pullRequest.reviewThreads.nodes[${String(index)}].isResolved`,
        ),
      );
      isPartial = true;
      continue;
    }

    if (!isResolved) {
      unresolvedCount += 1;
    }
  }

  if (!isRecord(reviewThreads.pageInfo)) {
    issues.push(
      createIssue(
        issueContext,
        'partial_shape',
        'gh api graphql returned review thread pageInfo in an invalid shape',
        'data.repository.pullRequest.reviewThreads.pageInfo',
      ),
    );
    isPartial = true;
  } else {
    const hasNextPage = parseOptionalBoolean(reviewThreads.pageInfo['hasNextPage']);
    if (hasNextPage === null) {
      issues.push(
        createIssue(
          issueContext,
          'partial_shape',
          'gh api graphql returned review thread pageInfo without a valid hasNextPage flag',
          'data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage',
        ),
      );
      isPartial = true;
    } else if (hasNextPage) {
      issues.push(
        createIssue(
          issueContext,
          'page_limit',
          `Only the first ${String(REVIEW_THREADS_PAGE_SIZE)} review threads were inspected`,
          'data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage',
        ),
      );
      isPartial = true;
    }
  }

  if (isPartial) {
    return {
      kind: 'partial',
      unresolvedCount,
      issues,
    };
  }

  return {
    kind: 'known',
    unresolvedCount,
    issues: [],
  };
}

function readReviewThreads(
  value: unknown,
  issueContext: IssueContext,
  issues: MergeReadyConversationIssue[],
): { nodes: unknown[]; pageInfo: unknown } | null {
  if (!isRecord(value)) {
    issues.push(
      createIssue(issueContext, 'invalid_shape', 'gh api graphql JSON payload was not an object'),
    );
    return null;
  }

  const data = value['data'];
  if (!isRecord(data)) {
    issues.push(
      createIssue(
        issueContext,
        'invalid_shape',
        'gh api graphql JSON payload was missing a data object',
        'data',
      ),
    );
    return null;
  }

  const repository = data['repository'];
  if (!isRecord(repository)) {
    issues.push(
      createIssue(
        issueContext,
        'invalid_shape',
        'gh api graphql JSON payload was missing a repository object',
        'data.repository',
      ),
    );
    return null;
  }

  const pullRequest = repository['pullRequest'];
  if (!isRecord(pullRequest)) {
    issues.push(
      createIssue(
        issueContext,
        'invalid_shape',
        'gh api graphql JSON payload was missing a pull request object',
        'data.repository.pullRequest',
      ),
    );
    return null;
  }

  const reviewThreads = pullRequest['reviewThreads'];
  if (!isRecord(reviewThreads)) {
    issues.push(
      createIssue(
        issueContext,
        'invalid_shape',
        'gh api graphql JSON payload was missing review threads',
        'data.repository.pullRequest.reviewThreads',
      ),
    );
    return null;
  }

  const nodes = reviewThreads['nodes'];
  if (!Array.isArray(nodes)) {
    issues.push(
      createIssue(
        issueContext,
        'invalid_shape',
        'gh api graphql JSON payload had an invalid review thread nodes array',
        'data.repository.pullRequest.reviewThreads.nodes',
      ),
    );
    return null;
  }

  return {
    nodes,
    pageInfo: reviewThreads['pageInfo'],
  };
}

function parseGraphQLErrorOutcome(
  value: unknown,
  issueContext: IssueContext,
): Extract<MergeReadyPullRequestConversations, { kind: 'failure' }> | null {
  if (!isRecord(value)) {
    return null;
  }

  const errors = value['errors'];
  if (!Array.isArray(errors) || errors.length === 0) {
    return null;
  }

  const messages = errors.map(formatGraphQLError).filter((message) => message.length > 0);
  const combinedMessage = messages.length > 0 ? messages.join('; ') : 'GraphQL error';

  return {
    kind: 'failure',
    reason: classifyFailureReason(combinedMessage, issueContext.stdout),
    issues: [
      createIssue(
        issueContext,
        'api_error',
        `gh api graphql returned GraphQL errors: ${combinedMessage}`,
        'errors',
      ),
    ],
  };
}

function formatGraphQLError(value: unknown): string {
  if (!isRecord(value)) {
    return typeof value === 'string' ? value : '';
  }

  const message = readOptionalString(value['message']);
  return message ?? '';
}

function parseJson(
  stdout: string,
  issueContext: IssueContext,
): { ok: true; value: unknown } | { ok: false; issue: MergeReadyConversationIssue } {
  try {
    return { ok: true, value: JSON.parse(stdout) };
  } catch (error) {
    return {
      ok: false,
      issue: createIssue(
        issueContext,
        'invalid_json',
        `gh api graphql returned invalid JSON: ${getErrorMessage(error)}`,
      ),
    };
  }
}

function classifyFailureReason(stderr: string, stdout: string): 'auth' | 'api' | 'command' {
  const combinedOutput = `${stderr}\n${stdout}`;

  if (AUTH_FAILURE_RE.test(combinedOutput)) {
    return 'auth';
  }
  if (API_FAILURE_RE.test(combinedOutput)) {
    return 'api';
  }
  return 'command';
}

function createExecOptions(cwd: string | undefined, timeout: number | undefined) {
  if (cwd === undefined && timeout === undefined) {
    return undefined;
  }

  const options: MergeReadyExecOptions = {};
  if (cwd !== undefined) {
    options.cwd = cwd;
  }
  if (timeout !== undefined) {
    options.timeout = timeout;
  }
  return options;
}

function normalizeExecResult(result: MergeReadyExecResult): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.exitCode ?? result.code ?? 0,
  };
}

function createIssue(
  context: IssueContext,
  code: MergeReadyConversationIssue['code'],
  message: string,
  field?: string,
): MergeReadyConversationIssue {
  const issue: MergeReadyConversationIssue = {
    code,
    message,
    command: context.command,
    args: context.args,
    exitCode: context.exitCode,
    stdout: context.stdout,
    stderr: context.stderr,
  };

  if (context.cwd !== undefined) {
    issue.cwd = context.cwd;
  }
  if (field !== undefined) {
    issue.field = field;
  }

  return issue;
}

function readOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  return value.trim().length > 0 ? value : null;
}

function parseOptionalBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === 'string' ? error : String(error);
}

function getErrorStringProperty(error: unknown, key: 'stdout' | 'stderr'): string {
  if (!error || typeof error !== 'object') {
    return '';
  }

  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function getErrorNumberProperty(error: unknown, key: 'exitCode' | 'code'): number | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : null;
}
