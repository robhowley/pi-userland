import {
  fetchMergeReadyPullRequestConversations,
  type MergeReadyPullRequestConversations,
} from './conversations.js';
import { parseGitHubRemoteUrl, type MergeReadyExec } from './git.js';
import {
  fetchMergeReadyGitHubPullRequestFacts,
  fetchMergeReadyGitHubRequiredChecks,
  type MergeReadyGitHubFailureReason,
  type MergeReadyGitHubPullRequest,
  type MergeReadyGitHubPullRequestFacts,
  type MergeReadyGitHubRequiredChecks,
  type MergeReadyGitHubReviewDecisionSignal,
} from './github.js';
import type {
  MergeReadyProviderEvidence,
  MergeReadyProviderReadInput,
  MergeReadyProviderReadResult,
  MergeReadyProvider,
} from './provider-api.js';
import { parseGitHubPullRequestUrl } from './target.js';
import type {
  MergeReadyCheckDetails,
  MergeReadyPullRequest,
  MergeReadyReviewSignal,
  MergeReadySignals,
} from './types.js';

export function createGitHubProvider(exec: MergeReadyExec): MergeReadyProvider {
  return {
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
  input: MergeReadyProviderReadInput,
): Promise<MergeReadyProviderReadResult> {
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
    return {
      kind: 'found',
      pullRequest: { ...pullRequest, lifecycle: pullRequest.lifecycle },
      signals: createTerminalSignals(pullRequestFacts.pullRequest),
    };
  }

  const requiredChecks = await fetchMergeReadyGitHubRequiredChecks({
    exec,
    ...withOptionalCwd(input.cwd),
    timeout: input.timeoutMs,
    ...(input.mode === 'url' ? { target: { mode: 'url', ...input.target } } : {}),
  });
  const checkSignals = normalizeRequiredCheckSignals(
    requiredChecks,
    pullRequestFacts.pullRequest.checks,
  );
  const pullRequestIssues =
    requiredChecks.kind === 'known' && checkSignals.checks !== 'unknown'
      ? pullRequestFacts.issues.filter((issue) => !issue.field?.startsWith('statusCheckRollup'))
      : pullRequestFacts.issues;
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
    ...pullRequestIssues.map((issue) => issue.message),
    ...(requiredChecks.kind === 'known' ? [] : [requiredChecks.message]),
    ...conversationIssueMessages(conversations),
  ];

  return {
    kind: 'found',
    pullRequest: { ...pullRequest, lifecycle: 'open' },
    signals: {
      ...createBaseSignals(pullRequestFacts.pullRequest, checkSignals),
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
  mode: MergeReadyProviderReadInput['mode'],
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
  checkSignals: Pick<MergeReadySignals, 'checks' | 'checkDetails'>,
): Omit<
  MergeReadySignals,
  'unresolvedConversations' | 'unresolvedConversationCount' | 'unresolvedConversationRequirement'
> {
  return {
    draft: pullRequest.draft === 'yes',
    mergeability: pullRequest.mergeability,
    ...checkSignals,
    review: normalizeReviewDecisionSignal(pullRequest.reviewDecision, pullRequest.reviews.state),
  };
}

function createTerminalSignals(pullRequest: MergeReadyGitHubPullRequest): MergeReadySignals {
  return {
    ...createBaseSignals(pullRequest, {
      checks: pullRequest.checks.state,
      checkDetails: pullRequest.checks.details,
    }),
    unresolvedConversations: false,
    unresolvedConversationRequirement: 'unknown',
  };
}

function normalizeRequiredCheckSignals(
  requiredChecks: MergeReadyGitHubRequiredChecks,
  rollupChecks: MergeReadyGitHubPullRequest['checks'],
): Pick<MergeReadySignals, 'checks' | 'checkDetails'> {
  if (requiredChecks.kind === 'unknown') return { checks: 'unknown' };

  const checkDetails: MergeReadyCheckDetails = { failing: [], running: [], unknown: [] };
  for (const check of requiredChecks.checks) {
    if (check.status === 'passed') continue;

    const status = check.status === 'failed' ? 'failing' : check.status;
    checkDetails[status].push({
      label: check.name,
      status,
      ...(check.link ? { url: check.link } : {}),
    });
  }

  if (checkDetails.failing.length > 0) return { checks: 'failing', checkDetails };
  if (checkDetails.running.length > 0) return { checks: 'running', checkDetails };
  if (requiredChecks.kind === 'partial' || checkDetails.unknown.length > 0) {
    return { checks: 'unknown', checkDetails };
  }
  if (rollupChecks.runningCount > 0) {
    return {
      checks: 'running',
      checkDetails: {
        failing: [],
        running: rollupChecks.details.running,
        unknown: [],
      },
    };
  }
  return { checks: 'passing' };
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
): MergeReadyProviderEvidence {
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
): MergeReadyProviderEvidence {
  if (
    (conversations.kind !== 'known' && conversations.kind !== 'partial') ||
    !conversations.openItemDetails
  )
    return {};
  const evidence: MergeReadyProviderEvidence = {};
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
