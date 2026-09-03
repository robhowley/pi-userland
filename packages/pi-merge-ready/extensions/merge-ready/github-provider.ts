import {
  fetchMergeReadyPullRequestConversations,
  type MergeReadyPullRequestConversations,
} from './conversations.js';
import { parseGitHubRemoteUrl, type MergeReadyExec } from './git.js';
import {
  fetchMergeReadyGitHubPullRequestFacts,
  type MergeReadyGitHubFailureReason,
  type MergeReadyGitHubPullRequest,
  type MergeReadyGitHubPullRequestFacts,
  type MergeReadyGitHubReviewDecisionSignal,
} from './github.js';
import type {
  MergeReadyProviderEvidenceV1,
  MergeReadyProviderReadInputV1,
  MergeReadyProviderReadResultV1,
  MergeReadyProviderV1,
} from './provider-api.js';
import { parseGitHubPullRequestUrl } from './target.js';
import type { MergeReadyPullRequest, MergeReadyReviewSignal, MergeReadySignals } from './types.js';

export function createGitHubProvider(exec: MergeReadyExec): MergeReadyProviderV1 {
  return {
    apiVersion: 1,
    id: 'github',
    matchUrl(url) {
      const target = parseGitHubPullRequestUrl(url.href);
      return (
        target && {
          url: target.url,
          owner: target.owner,
          repo: target.repo,
          prNumber: target.prNumber,
        }
      );
    },
    matchRemote(remote) {
      return parseGitHubRemoteUrl(remote.url);
    },
    read(input) {
      return readGitHubProvider(exec, input);
    },
  };
}

async function readGitHubProvider(
  exec: MergeReadyExec,
  input: MergeReadyProviderReadInputV1,
): Promise<MergeReadyProviderReadResultV1> {
  const pullRequestFacts = await fetchMergeReadyGitHubPullRequestFacts({
    exec,
    ...withOptionalCwd(input.cwd),
    timeout: input.timeoutMs,
    ...(input.mode === 'url' ? { target: { mode: 'url', ...input.target } } : {}),
  });

  if (pullRequestFacts.kind === 'no_pr' || pullRequestFacts.kind === 'not_found') {
    return { kind: 'absent' };
  }
  if (pullRequestFacts.kind !== 'found') {
    return {
      kind: 'unavailable',
      presence: 'unknown',
      message: describePullRequestLookupFailure(pullRequestFacts),
    };
  }
  if (input.mode === 'url' && !pullRequestFacts.pullRequest.headRepository) {
    return {
      kind: 'unavailable',
      presence: 'known',
      message: 'GitHub CLI did not report head repository identity',
    };
  }

  const pullRequest = toProviderPullRequest(pullRequestFacts.pullRequest, input.mode);
  if (pullRequest.lifecycle === 'merged' || pullRequest.lifecycle === 'closed') {
    return { kind: 'found', pullRequest: { ...pullRequest, lifecycle: pullRequest.lifecycle } };
  }

  const repository = input.mode === 'url' ? input.target : input.repository;
  const conversations = await fetchMergeReadyPullRequestConversations({
    exec,
    repositoryOwner: repository.owner,
    repositoryName: repository.repo,
    pullRequestNumber: pullRequest.number,
    ...withOptionalCwd(input.cwd),
    timeout: input.timeoutMs,
  });
  const issues = [
    ...pullRequestFacts.issues.map((issue) => issue.message),
    ...conversationIssueMessages(conversations),
  ];

  return {
    kind: 'found',
    pullRequest: { ...pullRequest, lifecycle: 'open' },
    signals: {
      ...createBaseSignals(pullRequestFacts.pullRequest),
      ...normalizeConversationSignals(conversations),
    },
    evidence: {
      ...createReviewEvidence(pullRequestFacts.pullRequest),
      ...createConversationEvidence(conversations),
    },
    ...(issues.length > 0 ? { issues } : {}),
  };
}

function toProviderPullRequest(
  pullRequest: MergeReadyGitHubPullRequest,
  mode: MergeReadyProviderReadInputV1['mode'],
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
  MergeReadySignals,
  'unresolvedConversations' | 'unresolvedConversationCount' | 'unresolvedConversationRequirement'
> {
  return {
    draft: pullRequest.draft === 'yes',
    mergeability: pullRequest.mergeability,
    checks: pullRequest.checks.state,
    checkDetails: pullRequest.checks.details,
    review: normalizeReviewDecisionSignal(pullRequest.reviewDecision, pullRequest.reviews.state),
  };
}

function normalizeReviewDecisionSignal(
  decision: MergeReadyGitHubReviewDecisionSignal,
  fallback: MergeReadyReviewSignal,
): MergeReadyReviewSignal {
  if (decision === 'approved' || decision === 'not_required') return 'approved';
  if (decision === 'changes_requested') return 'changes_requested';
  if (decision === 'review_required') return 'pending';
  return fallback;
}

function normalizeConversationSignals(
  conversations: MergeReadyPullRequestConversations,
): Pick<
  MergeReadySignals,
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

function createReviewEvidence(
  pullRequest: MergeReadyGitHubPullRequest,
): MergeReadyProviderEvidenceV1 {
  if (
    pullRequest.reviewRequests.kind !== 'known' ||
    pullRequest.reviewRequests.requests.length === 0
  )
    return {};
  return {
    reviewPending: pullRequest.reviewRequests.requests.map((request) => ({
      label:
        request.type === 'user'
          ? `@${request.name}`
          : request.type === 'team'
            ? `team/${request.name}`
            : request.name,
    })),
  };
}

function createConversationEvidence(
  conversations: MergeReadyPullRequestConversations,
): MergeReadyProviderEvidenceV1 {
  if (
    (conversations.kind !== 'known' && conversations.kind !== 'partial') ||
    !conversations.openItemDetails
  )
    return {};
  const evidence: MergeReadyProviderEvidenceV1 = {};
  const changesRequested = conversations.openItemDetails.changes_requested;
  const unresolvedConversations = conversations.openItemDetails.unresolved_conversations;
  if (changesRequested?.length) evidence.changesRequested = changesRequested;
  if (unresolvedConversations?.length) evidence.unresolvedConversations = unresolvedConversations;
  return evidence;
}

function conversationIssueMessages(conversations: MergeReadyPullRequestConversations): string[] {
  if (conversations.kind === 'known') return [];
  if (conversations.kind === 'partial') return conversations.issues.map((issue) => issue.message);
  return [describeConversationLookupFailure(conversations)];
}

function describePullRequestLookupFailure(
  facts: Exclude<MergeReadyGitHubPullRequestFacts, { kind: 'found' | 'not_found' | 'no_pr' }>,
): string {
  if (facts.kind === 'failure') return describeGitHubFailureReason(facts.reason, 'pr');
  if (facts.kind === 'invalid_json') return 'GitHub CLI returned invalid JSON';
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
  if (reason === 'auth') return 'GitHub CLI authentication failed';
  if (reason === 'access') return 'the repository or pull request is not accessible';
  if (reason === 'api') return 'the GitHub API request failed';
  return operation === 'pr' ? 'the gh pr view command failed' : 'the gh api graphql command failed';
}

function withOptionalCwd(cwd: string | undefined): { cwd?: string } {
  return cwd === undefined ? {} : { cwd };
}
