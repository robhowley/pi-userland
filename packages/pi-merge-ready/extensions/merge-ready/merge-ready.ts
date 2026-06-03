import {
  fetchMergeReadyPullRequestConversations,
  type MergeReadyPullRequestConversations,
} from './conversations.js';
import { discoverMergeReadyGitFacts, type MergeReadyExec } from './git.js';
import {
  fetchMergeReadyGitHubPullRequestFacts,
  type MergeReadyGitHubFailureReason,
  type MergeReadyGitHubPullRequest,
  type MergeReadyGitHubPullRequestFacts,
  type MergeReadyGitHubReviewDecisionSignal,
} from './github.js';
import { createMergeReadyStatus } from './status.js';
import { assertValidGitHubPullRequestUrl, formatMergeReadyUrlTarget } from './target.js';
import type {
  MergeReadyBooleanSignal,
  MergeReadyCurrentBranchTarget,
  MergeReadyOpenItem,
  MergeReadyPullRequest,
  MergeReadyReviewSignal,
  MergeReadySignalsInput,
  MergeReadyStatus,
  MergeReadyTarget,
  MergeReadyUrlTarget,
} from './types.js';

export type GetMergeReadyStatusClock = () => string | Date;

export type GetMergeReadyStatusOptions = {
  exec: MergeReadyExec;
  cwd?: string;
  url?: string;
  timeout?: number;
  generatedAt?: string | Date;
  now?: GetMergeReadyStatusClock;
};

export async function getMergeReadyStatus(
  options: GetMergeReadyStatusOptions,
): Promise<MergeReadyStatus> {
  const generatedAt = resolveGeneratedAt(options);

  if (options.url !== undefined) {
    return getMergeReadyUrlStatus(
      options,
      generatedAt,
      assertValidGitHubPullRequestUrl(options.url),
    );
  }

  return getCurrentBranchMergeReadyStatus(options, generatedAt);
}

async function getCurrentBranchMergeReadyStatus(
  options: GetMergeReadyStatusOptions,
  generatedAt: string | Date,
): Promise<MergeReadyStatus> {
  const gitFacts = await discoverMergeReadyGitFacts({
    exec: options.exec,
    ...withOptionalCwd(options.cwd),
    ...withOptionalTimeout(options.timeout),
  });
  const target = toCurrentBranchTarget(gitFacts);

  if (gitFacts.repository.kind !== 'git' || gitFacts.remote.kind !== 'github') {
    return createMergeReadyStatus({ generatedAt, target });
  }

  const commandCwd = gitFacts.repository.root;
  const pullRequestFacts = await fetchMergeReadyGitHubPullRequestFacts({
    exec: options.exec,
    cwd: commandCwd,
    ...withOptionalTimeout(options.timeout),
  });

  if (pullRequestFacts.kind === 'no_pr') {
    return createMergeReadyStatus({ generatedAt, target });
  }

  if (pullRequestFacts.kind !== 'found') {
    return createMergeReadyStatus({
      generatedAt,
      target,
      hasPr: true,
      forceStatusAmbiguous: true,
    });
  }

  return createMergeReadyStatusFromPullRequest({
    exec: options.exec,
    generatedAt,
    target,
    pullRequest: pullRequestFacts.pullRequest,
    repositoryOwner: gitFacts.remote.owner,
    repositoryName: gitFacts.remote.repo,
    cwd: commandCwd,
    ...withOptionalTimeout(options.timeout),
  });
}

async function getMergeReadyUrlStatus(
  options: GetMergeReadyStatusOptions,
  generatedAt: string | Date,
  target: MergeReadyUrlTarget,
): Promise<MergeReadyStatus> {
  const pullRequestFacts = await fetchMergeReadyGitHubPullRequestFacts({
    exec: options.exec,
    ...withOptionalCwd(options.cwd),
    ...withOptionalTimeout(options.timeout),
    target,
  });

  if (pullRequestFacts.kind === 'not_found' || pullRequestFacts.kind === 'no_pr') {
    const summary = `Pull request not found: ${formatMergeReadyUrlTarget(target)}`;
    return createMergeReadyStatus({
      generatedAt,
      target,
      openItems: [createOpenItem('no_pull_request', summary)],
      summary,
    });
  }

  if (pullRequestFacts.kind !== 'found') {
    const summary = createUrlTargetAmbiguousSummary(target, pullRequestFacts);
    return createMergeReadyStatus({
      generatedAt,
      target,
      hasPr: true,
      openItems: [createOpenItem('status_ambiguous', summary)],
      summary,
    });
  }

  if (!pullRequestFacts.pullRequest.headRepository) {
    const summary = createUrlTargetMissingHeadRepositorySummary(target);
    return createMergeReadyStatus({
      generatedAt,
      target,
      hasPr: true,
      openItems: [createOpenItem('status_ambiguous', summary)],
      summary,
    });
  }

  return createMergeReadyStatusFromPullRequest({
    exec: options.exec,
    generatedAt,
    target,
    pullRequest: pullRequestFacts.pullRequest,
    repositoryOwner: target.owner,
    repositoryName: target.repo,
    ...withOptionalCwd(options.cwd),
    ...withOptionalTimeout(options.timeout),
  });
}

type CreateMergeReadyStatusFromPullRequestOptions = {
  exec: MergeReadyExec;
  generatedAt: string | Date;
  target: MergeReadyTarget;
  pullRequest: MergeReadyGitHubPullRequest;
  repositoryOwner: string;
  repositoryName: string;
  cwd?: string;
  timeout?: number;
};

async function createMergeReadyStatusFromPullRequest(
  options: CreateMergeReadyStatusFromPullRequestOptions,
): Promise<MergeReadyStatus> {
  const pr = toMergeReadyPullRequest(options.pullRequest, options.target);
  const baseSignals = createBaseSignals(options.pullRequest);

  if (options.pullRequest.lifecycle !== 'open') {
    return createMergeReadyStatus({
      generatedAt: options.generatedAt,
      target: options.target,
      pr,
      signals: {
        ...baseSignals,
        unresolvedConversations: false,
        unresolvedConversationRequirement: 'unknown',
      },
    });
  }

  const conversations = await fetchMergeReadyPullRequestConversations({
    exec: options.exec,
    repositoryOwner: options.repositoryOwner,
    repositoryName: options.repositoryName,
    pullRequestNumber: options.pullRequest.number,
    ...withOptionalCwd(options.cwd),
    ...withOptionalTimeout(options.timeout),
  });

  return createMergeReadyStatus({
    generatedAt: options.generatedAt,
    target: options.target,
    pr,
    signals: {
      ...baseSignals,
      ...normalizeConversationSignals(conversations),
    },
    forceStatusAmbiguous: conversations.kind !== 'known',
  });
}

function resolveGeneratedAt(options: GetMergeReadyStatusOptions): string | Date {
  if (options.generatedAt !== undefined) {
    return options.generatedAt;
  }

  return options.now?.() ?? new Date();
}

function toMergeReadyPullRequest(
  pullRequest: MergeReadyGitHubPullRequest,
  target: MergeReadyTarget,
): MergeReadyPullRequest {
  return {
    lifecycle: pullRequest.lifecycle,
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    headRefName: pullRequest.headRefName,
    baseRefName: pullRequest.baseRefName,
    ...(target.mode === 'url' && pullRequest.headRepository
      ? { headRepository: pullRequest.headRepository }
      : {}),
  };
}

function createBaseSignals(
  pullRequest: MergeReadyGitHubPullRequest,
): Omit<
  MergeReadySignalsInput,
  'unresolvedConversations' | 'unresolvedConversationCount' | 'unresolvedConversationRequirement'
> {
  return {
    draft: toBoolean(pullRequest.draft),
    mergeability: pullRequest.mergeability,
    checks: pullRequest.checks.state,
    checkDetails: pullRequest.checks.details,
    review: normalizeReviewSignal(pullRequest),
  };
}

function normalizeConversationSignals(
  conversations: MergeReadyPullRequestConversations,
): Pick<
  MergeReadySignalsInput,
  'unresolvedConversations' | 'unresolvedConversationCount' | 'unresolvedConversationRequirement'
> {
  if (conversations.kind === 'known' || conversations.kind === 'partial') {
    return {
      unresolvedConversations: conversations.unresolvedCount > 0,
      unresolvedConversationRequirement: conversations.requirement,
      ...(conversations.unresolvedCount > 0
        ? { unresolvedConversationCount: conversations.unresolvedCount }
        : {}),
    };
  }

  return {
    unresolvedConversations: false,
    unresolvedConversationRequirement: 'unknown',
  };
}

function normalizeReviewSignal(pullRequest: MergeReadyGitHubPullRequest): MergeReadyReviewSignal {
  return normalizeReviewDecisionSignal(pullRequest.reviewDecision, pullRequest.reviews.state);
}

function normalizeReviewDecisionSignal(
  reviewDecision: MergeReadyGitHubReviewDecisionSignal,
  fallbackReviewState: MergeReadyReviewSignal,
): MergeReadyReviewSignal {
  if (reviewDecision === 'approved' || reviewDecision === 'not_required') {
    return 'approved';
  }
  if (reviewDecision === 'changes_requested') {
    return 'changes_requested';
  }
  if (reviewDecision === 'review_required') {
    return 'pending';
  }

  return fallbackReviewState;
}

function toBoolean(signal: MergeReadyBooleanSignal): boolean {
  return signal === 'yes';
}

function toCurrentBranchTarget(
  gitFacts: Awaited<ReturnType<typeof discoverMergeReadyGitFacts>>,
): MergeReadyCurrentBranchTarget {
  return {
    mode: 'current_branch',
    ...(gitFacts.remote.kind === 'github'
      ? {
          owner: gitFacts.remote.owner,
          repo: gitFacts.remote.repo,
        }
      : {}),
    ...(gitFacts.branch.kind === 'known' ? { branch: gitFacts.branch.name } : {}),
  };
}

function createUrlTargetMissingHeadRepositorySummary(target: MergeReadyUrlTarget): string {
  return `Unable to determine readiness for ${formatMergeReadyUrlTarget(target)}: GitHub CLI did not report head repository identity`;
}

function createUrlTargetAmbiguousSummary(
  target: MergeReadyUrlTarget,
  pullRequestFacts: Exclude<
    MergeReadyGitHubPullRequestFacts,
    { kind: 'found' | 'not_found' | 'no_pr' }
  >,
): string {
  return `Unable to determine readiness for ${formatMergeReadyUrlTarget(target)}: ${describePullRequestLookupFailure(pullRequestFacts)}`;
}

function describePullRequestLookupFailure(
  pullRequestFacts: Exclude<
    MergeReadyGitHubPullRequestFacts,
    { kind: 'found' | 'not_found' | 'no_pr' }
  >,
): string {
  if (pullRequestFacts.kind === 'failure') {
    return describeGitHubFailureReason(pullRequestFacts.reason);
  }

  if (pullRequestFacts.kind === 'invalid_json') {
    return 'GitHub CLI returned invalid JSON';
  }

  return 'GitHub CLI returned an unexpected pull request payload';
}

function describeGitHubFailureReason(reason: MergeReadyGitHubFailureReason): string {
  if (reason === 'auth') {
    return 'GitHub CLI authentication failed';
  }

  if (reason === 'access') {
    return 'the repository or pull request is not accessible';
  }

  if (reason === 'api') {
    return 'the GitHub API request failed';
  }

  return 'the gh pr view command failed';
}

function createOpenItem(id: MergeReadyOpenItem['id'], summary: string): MergeReadyOpenItem {
  return { id, summary };
}

function withOptionalCwd(cwd: string | undefined): { cwd?: string } {
  return cwd === undefined ? {} : { cwd };
}

function withOptionalTimeout(timeout: number | undefined): { timeout?: number } {
  return timeout === undefined ? {} : { timeout };
}
