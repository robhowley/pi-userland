import {
  fetchMergeReadyPullRequestConversations,
  type MergeReadyPullRequestConversations,
} from './conversations.js';
import { parseGitHubRemoteUrl } from './git.js';
import {
  fetchMergeReadyGitHubPullRequestFacts,
  type MergeReadyGitHubFailureReason,
  type MergeReadyGitHubPullRequest,
  type MergeReadyGitHubPullRequestFacts,
  type MergeReadyGitHubReviewDecisionSignal,
} from './github.js';
import type {
  MergeReadyProvider,
  ProviderIssue,
  ProviderReadInput,
  ProviderReadResult,
  ProviderSupportingEvidence,
} from './provider.js';
import { parseGitHubPullRequestUrl } from './target.js';
import type {
  MergeReadyPullRequest,
  MergeReadyReviewSignal,
  MergeReadySignalsInput,
} from './types.js';

export const githubProvider: MergeReadyProvider = {
  id: 'github',
  parseUrl: (url) => parseGitHubPullRequestUrl(url.href),
  parseRemote: parseGitHubRemoteUrl,
  read: readGitHubProvider,
};

async function readGitHubProvider(input: ProviderReadInput): Promise<ProviderReadResult> {
  const pullRequestFacts = await fetchMergeReadyGitHubPullRequestFacts({
    exec: input.exec,
    ...withOptionalCwd(input.cwd),
    ...withOptionalTimeout(input.timeout),
    ...(input.mode === 'url' ? { target: input.target } : {}),
  });

  if (pullRequestFacts.kind === 'no_pr' || pullRequestFacts.kind === 'not_found') {
    return { kind: 'absent' };
  }

  if (pullRequestFacts.kind !== 'found') {
    return {
      kind: 'unavailable',
      presence: 'unknown',
      issues: [{ message: describePullRequestLookupFailure(pullRequestFacts) }],
    };
  }

  if (input.mode === 'url' && !pullRequestFacts.pullRequest.headRepository) {
    return {
      kind: 'unavailable',
      presence: 'known',
      issues: [{ message: 'GitHub CLI did not report head repository identity' }],
    };
  }

  const pullRequest = toProviderPullRequest(pullRequestFacts.pullRequest, input.mode);
  const signals = createBaseSignals(pullRequestFacts.pullRequest);
  const supportingEvidence = createReviewSupportingEvidence(pullRequestFacts.pullRequest);
  const integrityIssues = pullRequestFacts.issues.map(toProviderIssue);

  if (pullRequestFacts.pullRequest.lifecycle !== 'open') {
    return {
      kind: 'found',
      snapshot: {
        pullRequest,
        signals: {
          ...signals,
          unresolvedConversations: false,
          unresolvedConversationRequirement: 'unknown',
        },
        forceStatusAmbiguous: false,
        supportingEvidence,
        integrityIssues,
      },
    };
  }

  const repository = input.mode === 'url' ? input.target : input.repository;
  const conversations = await fetchMergeReadyPullRequestConversations({
    exec: input.exec,
    repositoryOwner: repository.owner,
    repositoryName: repository.repo,
    pullRequestNumber: pullRequestFacts.pullRequest.number,
    ...withOptionalCwd(input.cwd),
    ...withOptionalTimeout(input.timeout),
  });

  return {
    kind: 'found',
    snapshot: {
      pullRequest,
      signals: {
        ...signals,
        ...normalizeConversationSignals(conversations),
      },
      forceStatusAmbiguous: conversations.kind !== 'known',
      supportingEvidence: {
        ...supportingEvidence,
        ...createConversationSupportingEvidence(conversations),
      },
      integrityIssues: [...integrityIssues, ...conversationIntegrityIssues(conversations)],
    },
  };
}

function toProviderPullRequest(
  pullRequest: MergeReadyGitHubPullRequest,
  mode: ProviderReadInput['mode'],
): MergeReadyPullRequest {
  return {
    lifecycle: pullRequest.lifecycle,
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    headRefName: pullRequest.headRefName,
    baseRefName: pullRequest.baseRefName,
    ...(mode === 'url' && pullRequest.headRepository
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
    draft: pullRequest.draft === 'yes',
    mergeability: pullRequest.mergeability,
    checks: pullRequest.checks.state,
    checkDetails: pullRequest.checks.details,
    review: normalizeReviewSignal(pullRequest),
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

function createReviewSupportingEvidence(
  pullRequest: MergeReadyGitHubPullRequest,
): ProviderSupportingEvidence {
  if (
    pullRequest.reviewRequests.kind !== 'known' ||
    pullRequest.reviewRequests.requests.length === 0
  ) {
    return {};
  }

  return {
    reviewPending: pullRequest.reviewRequests.requests.map((request) => ({
      label: formatReviewRequestLabel(request),
    })),
  };
}

function formatReviewRequestLabel(
  request: MergeReadyGitHubPullRequest['reviewRequests']['requests'][number],
): string {
  if (request.type === 'user') {
    return `@${request.name}`;
  }

  if (request.type === 'team') {
    return `team/${request.name}`;
  }

  return request.name;
}

function createConversationSupportingEvidence(
  conversations: MergeReadyPullRequestConversations,
): ProviderSupportingEvidence {
  if (
    (conversations.kind !== 'known' && conversations.kind !== 'partial') ||
    !conversations.openItemDetails
  ) {
    return {};
  }

  const evidence: ProviderSupportingEvidence = {};
  const changesRequested = conversations.openItemDetails.changes_requested;
  const unresolvedConversations = conversations.openItemDetails.unresolved_conversations;

  if (changesRequested && changesRequested.length > 0) {
    evidence.changesRequested = changesRequested;
  }
  if (unresolvedConversations && unresolvedConversations.length > 0) {
    evidence.unresolvedConversations = unresolvedConversations;
  }

  return evidence;
}

function conversationIntegrityIssues(
  conversations: MergeReadyPullRequestConversations,
): ProviderIssue[] {
  if (conversations.kind === 'known') {
    return [];
  }

  if (conversations.kind === 'partial') {
    return conversations.issues.map(toProviderIssue);
  }

  return [{ message: describeConversationLookupFailure(conversations) }];
}

function describePullRequestLookupFailure(
  pullRequestFacts: Exclude<
    MergeReadyGitHubPullRequestFacts,
    { kind: 'found' | 'not_found' | 'no_pr' }
  >,
): string {
  if (pullRequestFacts.kind === 'failure') {
    return describeGitHubFailureReason(pullRequestFacts.reason, 'pr');
  }

  if (pullRequestFacts.kind === 'invalid_json') {
    return 'GitHub CLI returned invalid JSON';
  }

  return 'GitHub CLI returned an unexpected pull request payload';
}

function describeConversationLookupFailure(
  conversations: Exclude<MergeReadyPullRequestConversations, { kind: 'known' | 'partial' }>,
): string {
  if (conversations.kind === 'failure') {
    return describeGitHubFailureReason(conversations.reason, 'graphql');
  }

  if (conversations.kind === 'invalid_json') {
    return 'GitHub CLI returned invalid JSON for pull request conversations';
  }

  return 'GitHub CLI returned an unexpected pull request conversation payload';
}

function describeGitHubFailureReason(
  reason: MergeReadyGitHubFailureReason | 'auth' | 'api' | 'command',
  operation: 'pr' | 'graphql',
): string {
  if (reason === 'auth') {
    return 'GitHub CLI authentication failed';
  }

  if (reason === 'access') {
    return 'the repository or pull request is not accessible';
  }

  if (reason === 'api') {
    return 'the GitHub API request failed';
  }

  return operation === 'pr' ? 'the gh pr view command failed' : 'the gh api graphql command failed';
}

function toProviderIssue(issue: { message: string }): ProviderIssue {
  return { message: issue.message };
}

function withOptionalCwd(cwd: string | undefined): { cwd?: string } {
  return cwd === undefined ? {} : { cwd };
}

function withOptionalTimeout(timeout: number | undefined): { timeout?: number } {
  return timeout === undefined ? {} : { timeout };
}
