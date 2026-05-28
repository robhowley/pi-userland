import type { MergeReadyExec } from './git.js';
import {
  classifyGitHubCliFailureReason,
  getErrorMessage,
  runNormalizedExecCommand,
} from './internal.js';

type MergeReadyConversationRequirement = 'required' | 'optional' | 'unknown';

type ReadConversationPayloadResult = {
  reviewThreads: {
    nodes: unknown[];
    pageInfo: unknown;
  };
  baseRef: unknown;
};

type ConversationRequirementOutcome = {
  requirement: MergeReadyConversationRequirement;
  isPartial: boolean;
};

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
      requirement: 'required' | 'optional' | 'unknown';
      issues: MergeReadyConversationIssue[];
    }
  | {
      kind: 'partial';
      unresolvedCount: number;
      requirement: 'required' | 'optional' | 'unknown';
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

type IssueContext = {
  command: string;
  args: string[];
  cwd?: string | undefined;
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

const REVIEW_THREADS_PAGE_SIZE = 100;
const BASE_REF_RULES_PAGE_SIZE = 100;
const REQUIRED_REVIEW_THREAD_RESOLUTION_RULE = 'REQUIRED_REVIEW_THREAD_RESOLUTION';
const GH_GRAPHQL_REVIEW_THREADS_QUERY = [
  'query MergeReadyReviewThreads($owner: String!, $name: String!, $number: Int!) {',
  'repository(owner: $owner, name: $name) {',
  'pullRequest(number: $number) {',
  `reviewThreads(first: ${String(REVIEW_THREADS_PAGE_SIZE)}) {`,
  'nodes { isResolved }',
  'pageInfo { hasNextPage }',
  '}',
  'baseRef {',
  'branchProtectionRule { requiresConversationResolution }',
  `rules(first: ${String(BASE_REF_RULES_PAGE_SIZE)}) {`,
  'nodes { type }',
  'pageInfo { hasNextPage }',
  '}',
  '}',
  '}',
  '}',
  '}',
].join(' ');
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
      reason: classifyGitHubCliFailureReason(commandResult.stderr, commandResult.stdout),
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
) {
  return runNormalizedExecCommand(exec, command, args, cwd, timeout);
}

function normalizeConversationOutcome(
  value: unknown,
  issueContext: IssueContext,
): MergeReadyPullRequestConversations {
  const issues: MergeReadyConversationIssue[] = [];
  const payload = readConversationPayload(value, issueContext, issues);
  if (!payload) {
    return { kind: 'invalid_shape', issues };
  }

  let unresolvedCount = 0;
  let isPartial = false;

  for (const [index, node] of payload.reviewThreads.nodes.entries()) {
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

  if (!isRecord(payload.reviewThreads.pageInfo)) {
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
    const hasNextPage = parseOptionalBoolean(payload.reviewThreads.pageInfo['hasNextPage']);
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

  const requirementOutcome = normalizeConversationRequirement(
    payload.baseRef,
    issueContext,
    issues,
  );
  if (requirementOutcome.isPartial) {
    isPartial = true;
  }

  if (isPartial) {
    return {
      kind: 'partial',
      unresolvedCount,
      requirement: requirementOutcome.requirement,
      issues,
    };
  }

  return {
    kind: 'known',
    unresolvedCount,
    requirement: requirementOutcome.requirement,
    issues: [],
  };
}

function readConversationPayload(
  value: unknown,
  issueContext: IssueContext,
  issues: MergeReadyConversationIssue[],
): ReadConversationPayloadResult | null {
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
    reviewThreads: {
      nodes,
      pageInfo: reviewThreads['pageInfo'],
    },
    baseRef: pullRequest['baseRef'],
  };
}

function normalizeConversationRequirement(
  baseRefValue: unknown,
  issueContext: IssueContext,
  issues: MergeReadyConversationIssue[],
): ConversationRequirementOutcome {
  if (!isRecord(baseRefValue)) {
    issues.push(
      createIssue(
        issueContext,
        'partial_shape',
        'gh api graphql returned pull request base ref in an invalid shape',
        'data.repository.pullRequest.baseRef',
      ),
    );
    return {
      requirement: 'unknown',
      isPartial: true,
    };
  }

  let isPartial = false;
  let classicPolicyKnown = false;
  let classicRequiresConversationResolution = false;

  const branchProtectionRule = baseRefValue['branchProtectionRule'];
  if (branchProtectionRule === null) {
    classicPolicyKnown = true;
  } else if (branchProtectionRule === undefined) {
    issues.push(
      createIssue(
        issueContext,
        'partial_shape',
        'gh api graphql returned base ref branch protection in an invalid shape',
        'data.repository.pullRequest.baseRef.branchProtectionRule',
      ),
    );
    isPartial = true;
  } else if (!isRecord(branchProtectionRule)) {
    issues.push(
      createIssue(
        issueContext,
        'partial_shape',
        'gh api graphql returned base ref branch protection in an invalid shape',
        'data.repository.pullRequest.baseRef.branchProtectionRule',
      ),
    );
    isPartial = true;
  } else {
    const requiresConversationResolution = parseOptionalBoolean(
      branchProtectionRule['requiresConversationResolution'],
    );
    if (requiresConversationResolution === null) {
      issues.push(
        createIssue(
          issueContext,
          'partial_shape',
          'gh api graphql returned base ref branch protection without a valid requiresConversationResolution flag',
          'data.repository.pullRequest.baseRef.branchProtectionRule.requiresConversationResolution',
        ),
      );
      isPartial = true;
    } else {
      classicPolicyKnown = true;
      classicRequiresConversationResolution = requiresConversationResolution;
    }
  }

  let rulesPolicyKnownComplete = false;
  let hasRequiredReviewThreadResolutionRule = false;

  const rules = baseRefValue['rules'];
  if (!isRecord(rules)) {
    issues.push(
      createIssue(
        issueContext,
        'partial_shape',
        'gh api graphql returned base ref rules in an invalid shape',
        'data.repository.pullRequest.baseRef.rules',
      ),
    );
    isPartial = true;
  } else {
    const nodes = rules['nodes'];
    let nodesValid = false;

    if (!Array.isArray(nodes)) {
      issues.push(
        createIssue(
          issueContext,
          'partial_shape',
          'gh api graphql returned base ref rules with an invalid nodes array',
          'data.repository.pullRequest.baseRef.rules.nodes',
        ),
      );
      isPartial = true;
    } else {
      nodesValid = true;

      for (const [index, node] of nodes.entries()) {
        if (!isRecord(node)) {
          issues.push(
            createIssue(
              issueContext,
              'partial_shape',
              'gh api graphql returned a non-object base ref rule node',
              `data.repository.pullRequest.baseRef.rules.nodes[${String(index)}]`,
            ),
          );
          isPartial = true;
          nodesValid = false;
          continue;
        }

        const type = readOptionalString(node['type']);
        if (type === null) {
          issues.push(
            createIssue(
              issueContext,
              'partial_shape',
              'gh api graphql returned a base ref rule without a valid type',
              `data.repository.pullRequest.baseRef.rules.nodes[${String(index)}].type`,
            ),
          );
          isPartial = true;
          nodesValid = false;
          continue;
        }

        if (type === REQUIRED_REVIEW_THREAD_RESOLUTION_RULE) {
          hasRequiredReviewThreadResolutionRule = true;
        }
      }
    }

    const pageInfo = rules['pageInfo'];
    if (!isRecord(pageInfo)) {
      issues.push(
        createIssue(
          issueContext,
          'partial_shape',
          'gh api graphql returned base ref rules pageInfo in an invalid shape',
          'data.repository.pullRequest.baseRef.rules.pageInfo',
        ),
      );
      isPartial = true;
    } else {
      const hasNextPage = parseOptionalBoolean(pageInfo['hasNextPage']);
      if (hasNextPage === null) {
        issues.push(
          createIssue(
            issueContext,
            'partial_shape',
            'gh api graphql returned base ref rules pageInfo without a valid hasNextPage flag',
            'data.repository.pullRequest.baseRef.rules.pageInfo.hasNextPage',
          ),
        );
        isPartial = true;
      } else if (hasNextPage) {
        issues.push(
          createIssue(
            issueContext,
            'page_limit',
            `Only the first ${String(BASE_REF_RULES_PAGE_SIZE)} base ref rules were inspected`,
            'data.repository.pullRequest.baseRef.rules.pageInfo.hasNextPage',
          ),
        );
        isPartial = true;
      } else if (nodesValid) {
        rulesPolicyKnownComplete = true;
      }
    }
  }

  if (classicRequiresConversationResolution || hasRequiredReviewThreadResolutionRule) {
    return {
      requirement: 'required',
      isPartial,
    };
  }

  if (classicPolicyKnown && rulesPolicyKnownComplete) {
    return {
      requirement: 'optional',
      isPartial,
    };
  }

  return {
    requirement: 'unknown',
    isPartial: true,
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
    reason: classifyGitHubCliFailureReason(combinedMessage, issueContext.stdout),
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
