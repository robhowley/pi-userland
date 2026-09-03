import type {
  MergeReadyBooleanSignal,
  MergeReadyCheckDetail,
  MergeReadyCheckDetails,
  MergeReadyChecksSignal,
  MergeReadyRepositoryIdentity,
  MergeReadyReviewSignal,
  MergeReadyUrlTarget,
  PullRequestLifecycle,
} from './types.js';
import type { MergeReadyExec } from './git.js';
import {
  classifyGitHubCliFailureReason,
  getErrorMessage,
  runNormalizedExecCommand,
} from './internal.js';

export type MergeReadyGitHubMergeability =
  | 'mergeable'
  | 'conflicting'
  | 'behind'
  | 'blocked'
  | 'unknown';

export type MergeReadyGitHubAuthor = {
  login?: string;
  name?: string;
  isBot?: boolean;
};

export type MergeReadyGitHubCheckSummary = {
  state: MergeReadyChecksSignal;
  totalCount: number;
  passingCount: number;
  failingCount: number;
  runningCount: number;
  unknownCount: number;
  names: {
    passing: string[];
    failing: string[];
    running: string[];
    unknown: string[];
  };
  details: MergeReadyCheckDetails;
};

export type MergeReadyGitHubReviewByAuthor = {
  author: string;
  state: MergeReadyReviewSignal;
  submittedAt?: string;
};

export type MergeReadyGitHubReviewSummary = {
  state: MergeReadyReviewSignal;
  totalCount: number;
  latestByAuthorCount: number;
  latestByAuthor: MergeReadyGitHubReviewByAuthor[];
};

export type MergeReadyGitHubReviewDecisionSignal =
  | 'approved'
  | 'changes_requested'
  | 'review_required'
  | 'not_required'
  | 'unknown';

export type MergeReadyGitHubReviewRequest = {
  type: 'user' | 'team' | 'unknown';
  name: string;
};

export type MergeReadyGitHubReviewRequests =
  | {
      kind: 'known';
      count: number;
      requests: MergeReadyGitHubReviewRequest[];
    }
  | {
      kind: 'unknown';
      count: null;
      requests: MergeReadyGitHubReviewRequest[];
    };

export type MergeReadyGitHubPullRequest = {
  lifecycle: PullRequestLifecycle;
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  headRepository: MergeReadyRepositoryIdentity | null;
  draft: MergeReadyBooleanSignal;
  mergeability: MergeReadyGitHubMergeability;
  checks: MergeReadyGitHubCheckSummary;
  reviews: MergeReadyGitHubReviewSummary;
  reviewDecision: MergeReadyGitHubReviewDecisionSignal;
  reviewRequests: MergeReadyGitHubReviewRequests;
  author: MergeReadyGitHubAuthor | null;
};

export type MergeReadyGitHubIssue = {
  code:
    | 'non_zero_exit'
    | 'threw'
    | 'invalid_json'
    | 'invalid_shape'
    | 'partial_shape'
    | 'api_error';
  message: string;
  command: string;
  args: string[];
  cwd?: string | undefined;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  field?: string | undefined;
};

export type MergeReadyGitHubFailureReason = 'auth' | 'access' | 'api' | 'command';

export type MergeReadyGitHubPullRequestFacts =
  | {
      kind: 'found';
      integrity: 'complete' | 'partial';
      pullRequest: MergeReadyGitHubPullRequest;
      issues: MergeReadyGitHubIssue[];
    }
  | {
      kind: 'no_pr';
      issues: MergeReadyGitHubIssue[];
    }
  | {
      kind: 'not_found';
      issues: MergeReadyGitHubIssue[];
    }
  | {
      kind: 'failure';
      reason: MergeReadyGitHubFailureReason;
      issues: MergeReadyGitHubIssue[];
    }
  | {
      kind: 'invalid_json';
      issues: MergeReadyGitHubIssue[];
    }
  | {
      kind: 'invalid_shape';
      issues: MergeReadyGitHubIssue[];
    };

export type GetMergeReadyGitHubPullRequestFactsOptions = {
  exec: MergeReadyExec;
  cwd?: string;
  timeout?: number;
  target?: MergeReadyUrlTarget;
  repositoryOwner?: string;
  repositoryName?: string;
};

type IssueContext = {
  command: string;
  args: string[];
  cwd?: string | undefined;
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

type CheckCategory = MergeReadyChecksSignal;

type NormalizedCheckEntry = {
  category: CheckCategory;
  name?: string | undefined;
  url?: string | undefined;
};

type ReviewCandidate = {
  author: string;
  state: MergeReadyReviewSignal;
  submittedAt?: string | undefined;
  submittedAtMs?: number | undefined;
  order: number;
};

const GH_PR_VIEW_JSON_FIELDS = [
  'number',
  'title',
  'url',
  'state',
  'isDraft',
  'mergeable',
  'mergeStateStatus',
  'headRefName',
  'headRepository',
  'headRepositoryOwner',
  'baseRefName',
  'statusCheckRollup',
  'reviews',
  'reviewDecision',
  'reviewRequests',
  'author',
] as const;

const NO_PULL_REQUEST_RE =
  /no pull requests? found|no open pull requests? found|no pull requests? match/i;
const TARGETED_PULL_REQUEST_NOT_FOUND_RE =
  /pull request not found|could not resolve to a pullrequest with the number of|no pull requests? found|no pull requests? match/i;
const TARGETED_PULL_REQUEST_ACCESS_RE =
  /resource not accessible by integration|forbidden|permission denied|insufficient permissions?|must have .* permission|not authorized|viewer cannot|could not resolve to a repository with the name/i;
const RUNNING_CHECK_STATUSES = new Set([
  'IN_PROGRESS',
  'QUEUED',
  'PENDING',
  'REQUESTED',
  'WAITING',
]);
const PASSING_CHECK_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const FAILING_CHECK_CONCLUSIONS = new Set([
  'ACTION_REQUIRED',
  'CANCELLED',
  'FAILURE',
  'STALE',
  'STARTUP_FAILURE',
  'TIMED_OUT',
]);
const KNOWN_BLOCKED_MERGE_STATE_STATUSES = new Set(['BLOCKED', 'DRAFT', 'HAS_HOOKS', 'UNSTABLE']);
const KNOWN_MERGEABLE_STATES = new Set(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']);
const KNOWN_MERGE_STATE_STATUSES = new Set([
  'CLEAN',
  'DIRTY',
  'UNKNOWN',
  'BLOCKED',
  'BEHIND',
  'UNSTABLE',
  'HAS_HOOKS',
  'DRAFT',
]);

export async function fetchMergeReadyGitHubPullRequestFacts(
  options: GetMergeReadyGitHubPullRequestFactsOptions,
): Promise<MergeReadyGitHubPullRequestFacts> {
  const args = createPullRequestViewArgs(options.target);
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
        ? 'gh pr view threw while fetching pull request facts'
        : `gh pr view exited with code ${commandResult.exitCode}`,
    );

    if (options.target) {
      const reason = classifyTargetedPullRequestFailure(commandResult.stderr, commandResult.stdout);

      if (reason === 'not_found') {
        return { kind: 'not_found', issues: [issue] };
      }

      return {
        kind: 'failure',
        reason,
        issues: [issue],
      };
    }

    if (looksLikeNoPullRequest(commandResult.stderr, commandResult.stdout)) {
      return { kind: 'no_pr', issues: [issue] };
    }

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

  const issues: MergeReadyGitHubIssue[] = [];
  const pullRequest = normalizePullRequest(parsedJson.value, issueContext, issues);
  if (!pullRequest) {
    return { kind: 'invalid_shape', issues };
  }

  return {
    kind: 'found',
    integrity: issues.length === 0 ? 'complete' : 'partial',
    pullRequest,
    issues,
  };
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

function createPullRequestViewArgs(target: MergeReadyUrlTarget | undefined): string[] {
  const args = ['pr', 'view'];

  if (target) {
    args.push(String(target.prNumber), '--repo', `${target.owner}/${target.repo}`);
  }

  args.push('--json', GH_PR_VIEW_JSON_FIELDS.join(','));
  return args;
}

function classifyTargetedPullRequestFailure(
  stderr: string,
  stdout: string,
): 'not_found' | MergeReadyGitHubFailureReason {
  const combinedOutput = `${stderr}\n${stdout}`;

  if (TARGETED_PULL_REQUEST_NOT_FOUND_RE.test(combinedOutput)) {
    return 'not_found';
  }

  if (TARGETED_PULL_REQUEST_ACCESS_RE.test(combinedOutput)) {
    return 'access';
  }

  return classifyGitHubCliFailureReason(stderr, stdout);
}

function normalizePullRequest(
  value: unknown,
  issueContext: IssueContext,
  issues: MergeReadyGitHubIssue[],
): MergeReadyGitHubPullRequest | null {
  if (!isRecord(value)) {
    issues.push(
      createIssue(issueContext, 'invalid_shape', 'gh pr view JSON payload was not an object'),
    );
    return null;
  }

  const lifecycle = parseLifecycle(value['state']);
  const number = parsePullRequestNumber(value['number']);
  const title = readRequiredString(value['title']);
  const url = readRequiredString(value['url']);
  const headRefName = readRequiredString(value['headRefName']);
  const baseRefName = readRequiredString(value['baseRefName']);
  const headRepository = normalizeHeadRepository(
    value['headRepository'],
    value['headRepositoryOwner'],
    issueContext,
    issues,
  );

  if (!lifecycle) {
    issues.push(
      createIssue(
        issueContext,
        'invalid_shape',
        'gh pr view JSON payload had an invalid pull request lifecycle',
        'state',
      ),
    );
  }
  if (number === null) {
    issues.push(
      createIssue(
        issueContext,
        'invalid_shape',
        'gh pr view JSON payload had an invalid pull request number',
        'number',
      ),
    );
  }
  if (!title) {
    issues.push(
      createIssue(
        issueContext,
        'invalid_shape',
        'gh pr view JSON payload had an invalid pull request title',
        'title',
      ),
    );
  }
  if (!url) {
    issues.push(
      createIssue(
        issueContext,
        'invalid_shape',
        'gh pr view JSON payload had an invalid pull request URL',
        'url',
      ),
    );
  }
  if (!headRefName) {
    issues.push(
      createIssue(
        issueContext,
        'invalid_shape',
        'gh pr view JSON payload had an invalid head ref name',
        'headRefName',
      ),
    );
  }
  if (!baseRefName) {
    issues.push(
      createIssue(
        issueContext,
        'invalid_shape',
        'gh pr view JSON payload had an invalid base ref name',
        'baseRefName',
      ),
    );
  }

  if (!lifecycle || number === null || !title || !url || !headRefName || !baseRefName) {
    return null;
  }

  return {
    lifecycle,
    number,
    title,
    url,
    headRefName,
    baseRefName,
    headRepository,
    draft: normalizeDraft(value['isDraft'], issueContext, issues),
    mergeability: normalizeMergeability(
      value['mergeable'],
      value['mergeStateStatus'],
      issueContext,
      issues,
    ),
    checks: normalizeChecks(value['statusCheckRollup'], issueContext, issues),
    reviews: normalizeReviews(value['reviews'], issueContext, issues),
    reviewDecision: normalizeReviewDecision(value['reviewDecision'], issueContext, issues),
    reviewRequests: normalizeReviewRequests(value['reviewRequests'], issueContext, issues),
    author: normalizeAuthor(value['author'], issueContext, issues),
  };
}

function normalizeHeadRepository(
  headRepositoryValue: unknown,
  headRepositoryOwnerValue: unknown,
  issueContext: IssueContext,
  issues: MergeReadyGitHubIssue[],
): MergeReadyRepositoryIdentity | null {
  const fallbackIdentity = readRepositoryIdentity(headRepositoryValue);
  const owner =
    readRepositoryOwner(headRepositoryOwnerValue) ??
    (isRecord(headRepositoryValue) ? readRepositoryOwner(headRepositoryValue['owner']) : null) ??
    fallbackIdentity?.owner ??
    null;
  const repo = readRepositoryName(headRepositoryValue) ?? fallbackIdentity?.repo ?? null;

  if (!owner || !repo) {
    issues.push(
      createIssue(
        issueContext,
        'partial_shape',
        'gh pr view JSON payload had an invalid head repository identity',
        !owner ? 'headRepositoryOwner' : 'headRepository',
      ),
    );
    return null;
  }

  return { owner, repo };
}

function normalizeDraft(
  value: unknown,
  issueContext: IssueContext,
  issues: MergeReadyGitHubIssue[],
): MergeReadyBooleanSignal {
  const parsed = parseOptionalBoolean(value);
  if (parsed === null) {
    issues.push(
      createIssue(
        issueContext,
        'partial_shape',
        'gh pr view JSON payload had an invalid draft flag',
        'isDraft',
      ),
    );
    return 'unknown';
  }

  return parsed ? 'yes' : 'no';
}

function normalizeMergeability(
  mergeableValue: unknown,
  mergeStateStatusValue: unknown,
  issueContext: IssueContext,
  issues: MergeReadyGitHubIssue[],
): MergeReadyGitHubMergeability {
  const mergeable = readOptionalString(mergeableValue)?.toUpperCase();
  const mergeStateStatus = readOptionalString(mergeStateStatusValue)?.toUpperCase();

  if (mergeable === 'CONFLICTING' || mergeStateStatus === 'DIRTY') {
    return 'conflicting';
  }

  if (!mergeable || !mergeStateStatus) {
    issues.push(
      createIssue(
        issueContext,
        'partial_shape',
        'gh pr view JSON payload had incomplete mergeability fields',
        !mergeable ? 'mergeable' : 'mergeStateStatus',
      ),
    );
    return 'unknown';
  }

  if (mergeable === 'UNKNOWN' || mergeStateStatus === 'UNKNOWN') {
    return 'unknown';
  }

  if (mergeable === 'MERGEABLE' && mergeStateStatus === 'CLEAN') {
    return 'mergeable';
  }

  if (mergeable === 'MERGEABLE' && mergeStateStatus === 'BEHIND') {
    return 'behind';
  }

  if (mergeable === 'MERGEABLE' && KNOWN_BLOCKED_MERGE_STATE_STATUSES.has(mergeStateStatus)) {
    return 'blocked';
  }

  if (
    mergeable !== 'MERGEABLE' ||
    !KNOWN_MERGEABLE_STATES.has(mergeable) ||
    !KNOWN_MERGE_STATE_STATUSES.has(mergeStateStatus)
  ) {
    issues.push(
      createIssue(
        issueContext,
        'partial_shape',
        'gh pr view JSON payload had an unrecognized mergeability combination',
        'mergeable',
      ),
    );
    return 'blocked';
  }

  issues.push(
    createIssue(
      issueContext,
      'partial_shape',
      'gh pr view JSON payload had a non-clear mergeability combination',
      'mergeable',
    ),
  );
  return 'blocked';
}

function normalizeChecks(
  value: unknown,
  issueContext: IssueContext,
  issues: MergeReadyGitHubIssue[],
): MergeReadyGitHubCheckSummary {
  const summary: MergeReadyGitHubCheckSummary = {
    state: 'unknown',
    totalCount: 0,
    passingCount: 0,
    failingCount: 0,
    runningCount: 0,
    unknownCount: 0,
    names: {
      passing: [],
      failing: [],
      running: [],
      unknown: [],
    },
    details: {
      failing: [],
      running: [],
      unknown: [],
    },
  };

  if (!Array.isArray(value)) {
    issues.push(
      createIssue(
        issueContext,
        'partial_shape',
        'gh pr view JSON payload had an invalid status check rollup',
        'statusCheckRollup',
      ),
    );
    return summary;
  }

  for (const [index, entry] of value.entries()) {
    const normalizedCheck = normalizeCheckEntry(entry, issueContext, issues, index);
    summary.totalCount += 1;

    if (normalizedCheck.name) {
      summary.names[normalizedCheck.category].push(normalizedCheck.name);
      appendCheckDetail(summary.details, normalizedCheck);
    }

    if (normalizedCheck.category === 'passing') {
      summary.passingCount += 1;
      continue;
    }
    if (normalizedCheck.category === 'failing') {
      summary.failingCount += 1;
      continue;
    }
    if (normalizedCheck.category === 'running') {
      summary.runningCount += 1;
      continue;
    }

    summary.unknownCount += 1;
  }

  if (summary.failingCount > 0) {
    summary.state = 'failing';
  } else if (summary.runningCount > 0) {
    summary.state = 'running';
  } else if (summary.unknownCount > 0) {
    summary.state = 'unknown';
  } else {
    summary.state = 'passing';
  }

  return summary;
}

function normalizeCheckEntry(
  value: unknown,
  issueContext: IssueContext,
  issues: MergeReadyGitHubIssue[],
  index: number,
): NormalizedCheckEntry {
  if (!isRecord(value)) {
    issues.push(
      createIssue(
        issueContext,
        'partial_shape',
        'gh pr view JSON payload included a non-object check entry',
        `statusCheckRollup[${index}]`,
      ),
    );
    return createNormalizedCheckEntry('unknown');
  }

  const checkRunStatus = readOptionalString(value['status'])?.toUpperCase();
  if (checkRunStatus) {
    const name = formatCheckRunName(value);
    const url = readCheckUrl(value);
    if (RUNNING_CHECK_STATUSES.has(checkRunStatus)) {
      return createNormalizedCheckEntry('running', name, url);
    }

    if (checkRunStatus === 'COMPLETED') {
      const conclusion = readOptionalString(value['conclusion'])?.toUpperCase();
      if (!conclusion) {
        issues.push(
          createIssue(
            issueContext,
            'partial_shape',
            'gh pr view JSON payload included a completed check without a conclusion',
            `statusCheckRollup[${index}].conclusion`,
          ),
        );
        return createNormalizedCheckEntry('unknown', name, url);
      }

      if (PASSING_CHECK_CONCLUSIONS.has(conclusion)) {
        return createNormalizedCheckEntry('passing', name, url);
      }
      if (FAILING_CHECK_CONCLUSIONS.has(conclusion)) {
        return createNormalizedCheckEntry('failing', name, url);
      }

      issues.push(
        createIssue(
          issueContext,
          'partial_shape',
          'gh pr view JSON payload included a check with an unknown conclusion',
          `statusCheckRollup[${index}].conclusion`,
        ),
      );
      return createNormalizedCheckEntry('unknown', name, url);
    }

    issues.push(
      createIssue(
        issueContext,
        'partial_shape',
        'gh pr view JSON payload included a check with an unknown status',
        `statusCheckRollup[${index}].status`,
      ),
    );
    return createNormalizedCheckEntry('unknown', name, url);
  }

  const statusContextState = readOptionalString(value['state'])?.toUpperCase();
  if (statusContextState) {
    const name = readOptionalString(value['context']) ?? undefined;
    const url = readCheckUrl(value);
    if (statusContextState === 'SUCCESS') {
      return createNormalizedCheckEntry('passing', name, url);
    }
    if (statusContextState === 'FAILURE' || statusContextState === 'ERROR') {
      return createNormalizedCheckEntry('failing', name, url);
    }
    if (statusContextState === 'EXPECTED' || statusContextState === 'PENDING') {
      return createNormalizedCheckEntry('running', name, url);
    }

    issues.push(
      createIssue(
        issueContext,
        'partial_shape',
        'gh pr view JSON payload included a status context with an unknown state',
        `statusCheckRollup[${index}].state`,
      ),
    );
    return createNormalizedCheckEntry('unknown', name, url);
  }

  issues.push(
    createIssue(
      issueContext,
      'partial_shape',
      'gh pr view JSON payload included an unrecognized check entry shape',
      `statusCheckRollup[${index}]`,
    ),
  );
  return createNormalizedCheckEntry(
    'unknown',
    readOptionalString(value['name']) ?? undefined,
    readCheckUrl(value),
  );
}

function normalizeReviews(
  value: unknown,
  issueContext: IssueContext,
  issues: MergeReadyGitHubIssue[],
): MergeReadyGitHubReviewSummary {
  const summary: MergeReadyGitHubReviewSummary = {
    state: 'unknown',
    totalCount: 0,
    latestByAuthorCount: 0,
    latestByAuthor: [],
  };

  if (!Array.isArray(value)) {
    issues.push(
      createIssue(
        issueContext,
        'partial_shape',
        'gh pr view JSON payload had an invalid reviews array',
        'reviews',
      ),
    );
    return summary;
  }

  const latestReviews = new Map<string, ReviewCandidate>();
  let hasUnknownReview = false;

  summary.totalCount = value.length;

  for (const [index, entry] of value.entries()) {
    const normalizedReview = normalizeReviewEntry(entry, issueContext, issues, index);
    if (!normalizedReview) {
      hasUnknownReview = true;
      continue;
    }

    const existingReview = latestReviews.get(normalizedReview.author);
    if (!existingReview || isLaterReview(existingReview, normalizedReview)) {
      latestReviews.set(normalizedReview.author, normalizedReview);
    }
  }

  const latestByAuthor = Array.from(latestReviews.values())
    .sort((left, right) => left.author.localeCompare(right.author))
    .map((review) => {
      const normalizedReview: MergeReadyGitHubReviewByAuthor = {
        author: review.author,
        state: review.state,
      };

      if (review.submittedAt) {
        normalizedReview.submittedAt = review.submittedAt;
      }

      return normalizedReview;
    });

  summary.latestByAuthor = latestByAuthor;
  summary.latestByAuthorCount = latestByAuthor.length;

  const hasChangesRequested = latestByAuthor.some((review) => review.state === 'changes_requested');
  const hasUnknownLatestReview = latestByAuthor.some((review) => review.state === 'unknown');
  const hasApprovedReview = latestByAuthor.some((review) => review.state === 'approved');

  if (hasChangesRequested) {
    summary.state = 'changes_requested';
  } else if (hasUnknownReview || hasUnknownLatestReview) {
    summary.state = 'unknown';
  } else if (hasApprovedReview) {
    summary.state = 'approved';
  } else {
    summary.state = 'pending';
  }

  return summary;
}

function normalizeReviewEntry(
  value: unknown,
  issueContext: IssueContext,
  issues: MergeReadyGitHubIssue[],
  index: number,
): ReviewCandidate | null {
  if (!isRecord(value)) {
    issues.push(
      createIssue(
        issueContext,
        'partial_shape',
        'gh pr view JSON payload included a non-object review entry',
        `reviews[${index}]`,
      ),
    );
    return null;
  }

  const authorValue = value['author'];
  const author = isRecord(authorValue) ? readOptionalString(authorValue['login']) : null;
  if (!author) {
    issues.push(
      createIssue(
        issueContext,
        'partial_shape',
        'gh pr view JSON payload included a review without an author login',
        `reviews[${index}].author.login`,
      ),
    );
    return null;
  }

  const rawState = readOptionalString(value['state'])?.toUpperCase();
  if (!rawState) {
    issues.push(
      createIssue(
        issueContext,
        'partial_shape',
        'gh pr view JSON payload included a review without a state',
        `reviews[${index}].state`,
      ),
    );
    return null;
  }

  const submittedAt = readOptionalString(value['submittedAt']);
  const parsedState = normalizeReviewState(rawState, issueContext, issues, index);
  const submittedAtMs = submittedAt ? parseTimestamp(submittedAt) : null;

  const review: ReviewCandidate = {
    author,
    state: parsedState,
    order: index,
  };

  if (submittedAt !== null) {
    review.submittedAt = submittedAt;
  }
  if (submittedAtMs !== null) {
    review.submittedAtMs = submittedAtMs;
  }

  return review;
}

function normalizeReviewState(
  state: string,
  issueContext: IssueContext,
  issues: MergeReadyGitHubIssue[],
  index: number,
): MergeReadyReviewSignal {
  if (state === 'APPROVED') {
    return 'approved';
  }
  if (state === 'CHANGES_REQUESTED') {
    return 'changes_requested';
  }
  if (state === 'COMMENTED' || state === 'DISMISSED' || state === 'PENDING') {
    return 'pending';
  }

  issues.push(
    createIssue(
      issueContext,
      'partial_shape',
      'gh pr view JSON payload included a review with an unknown state',
      `reviews[${index}].state`,
    ),
  );
  return 'unknown';
}

function normalizeReviewDecision(
  value: unknown,
  issueContext: IssueContext,
  issues: MergeReadyGitHubIssue[],
): MergeReadyGitHubReviewDecisionSignal {
  if (value === '') {
    return 'not_required';
  }

  const reviewDecision = readOptionalString(value)?.toUpperCase();
  if (!reviewDecision) {
    issues.push(
      createIssue(
        issueContext,
        'partial_shape',
        'gh pr view JSON payload had an invalid review decision',
        'reviewDecision',
      ),
    );
    return 'unknown';
  }

  if (reviewDecision === 'APPROVED') {
    return 'approved';
  }
  if (reviewDecision === 'CHANGES_REQUESTED') {
    return 'changes_requested';
  }
  if (reviewDecision === 'REVIEW_REQUIRED') {
    return 'review_required';
  }

  issues.push(
    createIssue(
      issueContext,
      'partial_shape',
      'gh pr view JSON payload had an unknown review decision',
      'reviewDecision',
    ),
  );
  return 'unknown';
}

function normalizeReviewRequests(
  value: unknown,
  issueContext: IssueContext,
  issues: MergeReadyGitHubIssue[],
): MergeReadyGitHubReviewRequests {
  if (!Array.isArray(value)) {
    issues.push(
      createIssue(
        issueContext,
        'partial_shape',
        'gh pr view JSON payload had an invalid review requests array',
        'reviewRequests',
      ),
    );
    return { kind: 'unknown', count: null, requests: [] };
  }

  const requests: MergeReadyGitHubReviewRequest[] = [];
  let hasMalformedRequest = false;

  for (const [index, entry] of value.entries()) {
    const normalizedRequest = normalizeReviewRequestEntry(entry, issueContext, issues, index);
    if (!normalizedRequest) {
      hasMalformedRequest = true;
      continue;
    }

    requests.push(normalizedRequest);
  }

  if (hasMalformedRequest) {
    return { kind: 'unknown', count: null, requests };
  }

  return { kind: 'known', count: requests.length, requests };
}

function normalizeReviewRequestEntry(
  value: unknown,
  issueContext: IssueContext,
  issues: MergeReadyGitHubIssue[],
  index: number,
): MergeReadyGitHubReviewRequest | null {
  if (!isRecord(value)) {
    issues.push(
      createIssue(
        issueContext,
        'partial_shape',
        'gh pr view JSON payload included a non-object review request entry',
        `reviewRequests[${index}]`,
      ),
    );
    return null;
  }

  const typename = readOptionalString(value['__typename']);
  const login = readOptionalString(value['login']);
  const slug = readOptionalString(value['slug']);
  const name = readOptionalString(value['name']);

  if (typename === 'User' && login) {
    return { type: 'user', name: login };
  }
  if (typename === 'Team' && (slug || name)) {
    return { type: 'team', name: slug ?? name ?? 'unknown-team' };
  }
  if (login) {
    return { type: typename === 'Bot' ? 'unknown' : 'user', name: login };
  }
  if (slug || name) {
    return { type: typename === 'Team' ? 'team' : 'unknown', name: slug ?? name ?? 'unknown' };
  }

  issues.push(
    createIssue(
      issueContext,
      'partial_shape',
      'gh pr view JSON payload included an invalid review request entry',
      `reviewRequests[${index}]`,
    ),
  );
  return null;
}

function normalizeAuthor(
  value: unknown,
  issueContext: IssueContext,
  issues: MergeReadyGitHubIssue[],
): MergeReadyGitHubAuthor | null {
  if (!isRecord(value)) {
    issues.push(
      createIssue(
        issueContext,
        'partial_shape',
        'gh pr view JSON payload had an invalid author object',
        'author',
      ),
    );
    return null;
  }

  const login = readOptionalString(value['login']);
  const name = readOptionalString(value['name']);
  const isBot = parseOptionalBoolean(value['isBot'] ?? value['is_bot']);

  if (!login && !name) {
    issues.push(
      createIssue(
        issueContext,
        'partial_shape',
        'gh pr view JSON payload author was missing identifying fields',
        'author',
      ),
    );
    return null;
  }

  const author: MergeReadyGitHubAuthor = {};
  if (login) {
    author.login = login;
  }
  if (name) {
    author.name = name;
  }
  if (isBot !== null) {
    author.isBot = isBot;
  }

  return author;
}

function parseJson(
  stdout: string,
  issueContext: IssueContext,
): { ok: true; value: unknown } | { ok: false; issue: MergeReadyGitHubIssue } {
  try {
    return { ok: true, value: JSON.parse(stdout) };
  } catch (error) {
    return {
      ok: false,
      issue: createIssue(
        issueContext,
        'invalid_json',
        `gh pr view returned invalid JSON: ${getErrorMessage(error)}`,
      ),
    };
  }
}

function parseLifecycle(value: unknown): PullRequestLifecycle | null {
  const state = readOptionalString(value)?.toUpperCase();
  if (state === 'OPEN') {
    return 'open';
  }
  if (state === 'MERGED') {
    return 'merged';
  }
  if (state === 'CLOSED') {
    return 'closed';
  }
  return null;
}

function parsePullRequestNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string' && /^\d+$/u.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  return null;
}

function readRequiredString(value: unknown): string | null {
  const stringValue = readOptionalString(value);
  return stringValue ?? null;
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

function readRepositoryOwner(value: unknown): string | null {
  if (typeof value === 'string') {
    return readOptionalString(value);
  }

  if (!isRecord(value)) {
    return null;
  }

  return readOptionalString(value['login']) ?? readOptionalString(value['name']);
}

function readRepositoryName(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }

  return readOptionalString(value['name']) ?? readRepositoryIdentity(value)?.repo ?? null;
}

function readRepositoryIdentity(value: unknown): MergeReadyRepositoryIdentity | null {
  if (!isRecord(value)) {
    return null;
  }

  const nameWithOwner = readOptionalString(value['nameWithOwner']);
  if (!nameWithOwner) {
    return null;
  }

  const [owner, repo, ...rest] = nameWithOwner.split('/');
  if (!owner || !repo || rest.length > 0) {
    return null;
  }

  return { owner, repo };
}

function createNormalizedCheckEntry(
  category: CheckCategory,
  name?: string | undefined,
  url?: string | undefined,
): NormalizedCheckEntry {
  return {
    category,
    ...(name === undefined ? {} : { name }),
    ...(url === undefined ? {} : { url }),
  };
}

function appendCheckDetail(details: MergeReadyCheckDetails, check: NormalizedCheckEntry): void {
  if (!check.name || check.category === 'passing') {
    return;
  }

  const detail: MergeReadyCheckDetail = {
    label: check.name,
    status: check.category,
  };

  if (check.url) {
    detail.url = check.url;
  }

  details[check.category].push(detail);
}

function formatCheckRunName(value: Record<string, unknown>): string | undefined {
  const name = readOptionalString(value['name']);
  const workflowName = readOptionalString(value['workflowName']);

  if (workflowName && name && workflowName !== name) {
    return `${workflowName} / ${name}`;
  }

  return workflowName ?? name ?? undefined;
}

function readCheckUrl(value: Record<string, unknown>): string | undefined {
  return (
    readOptionalString(value['detailsUrl']) ??
    readOptionalString(value['targetUrl']) ??
    readOptionalString(value['url']) ??
    readOptionalString(value['link']) ??
    undefined
  );
}

function isLaterReview(existingReview: ReviewCandidate, nextReview: ReviewCandidate): boolean {
  if (
    existingReview.submittedAtMs !== undefined &&
    nextReview.submittedAtMs !== undefined &&
    existingReview.submittedAtMs !== nextReview.submittedAtMs
  ) {
    return nextReview.submittedAtMs > existingReview.submittedAtMs;
  }

  return nextReview.order > existingReview.order;
}

function parseTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function looksLikeNoPullRequest(stderr: string, stdout: string): boolean {
  return NO_PULL_REQUEST_RE.test(`${stderr}\n${stdout}`);
}

function createIssue(
  context: IssueContext,
  code: MergeReadyGitHubIssue['code'],
  message: string,
  field?: string,
): MergeReadyGitHubIssue {
  const issue: MergeReadyGitHubIssue = {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
