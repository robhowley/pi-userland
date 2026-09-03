import {
  fetchMergeReadyPullRequestConversations,
  type MergeReadyPullRequestConversations,
} from './conversations.js';
import { parseGitHubRemoteUrl } from './git.js';
import {
  fetchMergeReadyGitHubPullRequestFacts,
  fetchMergeReadyGitHubRequiredChecks,
  type MergeReadyGitHubFailureReason,
  type MergeReadyGitHubPullRequest,
  type MergeReadyGitHubPullRequestFacts,
  type MergeReadyGitHubRequiredChecks,
} from './github.js';
import type {
  MergeReadyProvider,
  ProviderDetail,
  ProviderFact,
  ProviderOpenPullRequestFacts,
  ProviderReadInput,
  ProviderReadResult,
  ProviderSourceReviewGate,
} from './provider.js';
import { parseGitHubPullRequestUrl } from './target.js';
import type { MergeReadyPullRequest } from './types.js';

export const githubProvider: MergeReadyProvider = {
  id: 'github',
  parseUrl: (url) => parseGitHubPullRequestUrl(url.href),
  parseRemote: (remote) => parseGitHubRemoteUrl(remote.url),
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
  if (pullRequestFacts.pullRequest.lifecycle !== 'open') {
    return {
      kind: 'found',
      snapshot: {
        pullRequest: { ...pullRequest, lifecycle: pullRequestFacts.pullRequest.lifecycle },
      },
    };
  }

  const requiredChecks = await fetchMergeReadyGitHubRequiredChecks({
    exec: input.exec,
    ...withOptionalCwd(input.cwd),
    ...withOptionalTimeout(input.timeout),
    ...(input.mode === 'url' ? { target: input.target } : {}),
  });
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
      pullRequest: { ...pullRequest, lifecycle: 'open' },
      facts: createOpenFacts(
        pullRequestFacts.pullRequest,
        pullRequestFacts,
        requiredChecks,
        conversations,
      ),
    },
  };
}

function createOpenFacts(
  pullRequest: MergeReadyGitHubPullRequest,
  pullRequestFacts: Extract<MergeReadyGitHubPullRequestFacts, { kind: 'found' }>,
  requiredChecks: MergeReadyGitHubRequiredChecks,
  conversations: MergeReadyPullRequestConversations,
): ProviderOpenPullRequestFacts {
  const mergeFacts = createMergeFacts(pullRequest, pullRequestFacts);
  return {
    draft:
      pullRequest.draft === 'unknown'
        ? {
            kind: 'unknown',
            message: issueMessage(pullRequestFacts, 'isDraft', 'GitHub draft status is unknown'),
          }
        : { kind: 'known', value: pullRequest.draft === 'yes' },
    ...mergeFacts,
    requiredChecks: mapRequiredChecks(requiredChecks),
    sourceReviewGate: createReviewGateFact(pullRequest, pullRequestFacts, conversations),
    unresolvedConversations: createUnresolvedConversationsFact(conversations),
    conversationResolutionRequired: createConversationRequirementFact(conversations),
  };
}

function mapRequiredChecks(
  checks: MergeReadyGitHubRequiredChecks,
): ProviderOpenPullRequestFacts['requiredChecks'] {
  if (checks.kind === 'unknown') {
    return { kind: 'unknown', message: checks.message };
  }

  const value = checks.checks.map((check) => ({
    label: check.name,
    status: check.status,
    ...(check.link === undefined ? {} : { url: check.link }),
  }));

  return checks.kind === 'partial'
    ? { kind: 'partial', value, message: checks.message }
    : { kind: 'known', value };
}

function createMergeFacts(
  pullRequest: MergeReadyGitHubPullRequest,
  pullRequestFacts: Extract<MergeReadyGitHubPullRequestFacts, { kind: 'found' }>,
): Pick<ProviderOpenPullRequestFacts, 'hasConflicts' | 'behindBase' | 'sourceMergeGate'> {
  if (pullRequest.mergeability === 'unknown') {
    const message = issueMessage(pullRequestFacts, 'mergeable', 'GitHub merge status is unknown');
    return {
      hasConflicts: { kind: 'unknown', message },
      behindBase: { kind: 'unknown', message },
      sourceMergeGate: { kind: 'unknown', message },
    };
  }

  const values = {
    hasConflicts: pullRequest.mergeability === 'conflicting',
    behindBase: pullRequest.mergeability === 'behind',
    sourceMergeGate:
      pullRequest.mergeability === 'mergeable' ? ('clear' as const) : ('blocked' as const),
  };
  const mergeIssue = pullRequestFacts.issues.find(
    (issue) => issue.field === 'mergeable' || issue.field === 'mergeStateStatus',
  );
  if (mergeIssue) {
    return {
      hasConflicts: { kind: 'partial', value: values.hasConflicts, message: mergeIssue.message },
      behindBase: { kind: 'partial', value: values.behindBase, message: mergeIssue.message },
      sourceMergeGate: {
        kind: 'partial',
        value: values.sourceMergeGate,
        message: mergeIssue.message,
      },
    };
  }
  return {
    hasConflicts: { kind: 'known', value: values.hasConflicts },
    behindBase: { kind: 'known', value: values.behindBase },
    sourceMergeGate: { kind: 'known', value: values.sourceMergeGate },
  };
}

function createReviewGateFact(
  pullRequest: MergeReadyGitHubPullRequest,
  pullRequestFacts: Extract<MergeReadyGitHubPullRequestFacts, { kind: 'found' }>,
  conversations: MergeReadyPullRequestConversations,
): ProviderFact<ProviderSourceReviewGate> {
  const state = normalizeReviewGateState(pullRequest);
  if (!state) {
    return {
      kind: 'unknown',
      message: issueMessage(
        pullRequestFacts,
        'reviewDecision',
        'GitHub review requirement is unknown',
      ),
    };
  }

  const details =
    state === 'pending'
      ? createReviewRequestDetails(pullRequest)
      : state === 'changes_requested'
        ? readConversationDetails(conversations, 'changes_requested')
        : [];
  const value = { state, ...(details.length > 0 ? { details } : {}) };
  const reviewIssue = pullRequestFacts.issues.find((issue) =>
    ['reviews', 'reviewDecision', 'reviewRequests'].some((field) => issue.field?.startsWith(field)),
  );
  return reviewIssue
    ? { kind: 'partial', value, message: reviewIssue.message }
    : { kind: 'known', value };
}

function normalizeReviewGateState(
  pullRequest: MergeReadyGitHubPullRequest,
): ProviderSourceReviewGate['state'] | null {
  if (pullRequest.reviewDecision === 'approved' || pullRequest.reviewDecision === 'not_required') {
    return 'satisfied';
  }
  if (pullRequest.reviewDecision === 'changes_requested') return 'changes_requested';
  if (pullRequest.reviewDecision === 'review_required') return 'pending';
  return null;
}

function createReviewRequestDetails(pullRequest: MergeReadyGitHubPullRequest): ProviderDetail[] {
  return pullRequest.reviewRequests.requests.map((request) => ({
    label:
      request.type === 'user'
        ? `@${request.name}`
        : request.type === 'team'
          ? `team/${request.name}`
          : request.name,
  }));
}

function createUnresolvedConversationsFact(
  conversations: MergeReadyPullRequestConversations,
): ProviderOpenPullRequestFacts['unresolvedConversations'] {
  if (conversations.kind !== 'known' && conversations.kind !== 'partial') {
    return { kind: 'unknown', message: describeConversationLookupFailure(conversations) };
  }
  const details = readConversationDetails(conversations, 'unresolved_conversations');
  while (details.length < conversations.unresolvedCount) {
    details.push({ label: 'Unresolved conversation' });
  }
  return conversations.kind === 'partial'
    ? {
        kind: 'partial',
        value: details,
        message: conversations.issues[0]?.message ?? 'GitHub conversation facts are partial',
      }
    : { kind: 'known', value: details };
}

function createConversationRequirementFact(
  conversations: MergeReadyPullRequestConversations,
): ProviderOpenPullRequestFacts['conversationResolutionRequired'] {
  if (
    (conversations.kind !== 'known' && conversations.kind !== 'partial') ||
    conversations.requirement === 'unknown'
  ) {
    return { kind: 'unknown', message: describeConversationLookupFailure(conversations) };
  }
  const value = conversations.requirement === 'required';
  return conversations.kind === 'partial'
    ? {
        kind: 'partial',
        value,
        message: conversations.issues[0]?.message ?? 'GitHub conversation policy is partial',
      }
    : { kind: 'known', value };
}

function readConversationDetails(
  conversations: MergeReadyPullRequestConversations,
  key: 'changes_requested' | 'unresolved_conversations',
): ProviderDetail[] {
  if (conversations.kind !== 'known' && conversations.kind !== 'partial') return [];
  return [...(conversations.openItemDetails?.[key] ?? [])];
}

function issueMessage(
  facts: Extract<MergeReadyGitHubPullRequestFacts, { kind: 'found' }>,
  field: string,
  fallback: string,
): string {
  return facts.issues.find((issue) => issue.field?.startsWith(field))?.message ?? fallback;
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

function describePullRequestLookupFailure(
  pullRequestFacts: Exclude<
    MergeReadyGitHubPullRequestFacts,
    { kind: 'found' | 'not_found' | 'no_pr' }
  >,
): string {
  if (pullRequestFacts.kind === 'failure') {
    return describeGitHubFailureReason(pullRequestFacts.reason, 'pr');
  }
  if (pullRequestFacts.kind === 'invalid_json') return 'GitHub CLI returned invalid JSON';
  return 'GitHub CLI returned an unexpected pull request payload';
}

function describeConversationLookupFailure(
  conversations: MergeReadyPullRequestConversations,
): string {
  if (conversations.kind === 'failure') {
    return describeGitHubFailureReason(conversations.reason, 'graphql');
  }
  if (conversations.kind === 'invalid_json') {
    return 'GitHub CLI returned invalid JSON for pull request conversations';
  }
  if (conversations.kind === 'invalid_shape') {
    return 'GitHub CLI returned an unexpected pull request conversation payload';
  }
  return conversations.issues[0]?.message ?? 'GitHub conversation policy is unknown';
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

function withOptionalTimeout(timeout: number | undefined): { timeout?: number } {
  return timeout === undefined ? {} : { timeout };
}
