import {
  fetchMergeReadyPullRequestConversations,
  type MergeReadyPullRequestConversations,
} from './conversations.js';
import { discoverMergeReadyGitFacts, type MergeReadyExec } from './git.js';
import {
  fetchMergeReadyGitHubPullRequestFacts,
  type MergeReadyGitHubPullRequest,
  type MergeReadyGitHubReviewDecisionSignal,
} from './github.js';
import { createMergeReadyStatus } from './status.js';
import type {
  MergeReadyBooleanSignal,
  MergeReadyPullRequest,
  MergeReadyReviewSignal,
  MergeReadySignalsInput,
  MergeReadyStatus,
} from './types.js';

export type GetMergeReadyStatusClock = () => string | Date;

export type GetMergeReadyStatusOptions = {
  exec: MergeReadyExec;
  cwd?: string;
  timeout?: number;
  generatedAt?: string | Date;
  now?: GetMergeReadyStatusClock;
};

export async function getMergeReadyStatus(
  options: GetMergeReadyStatusOptions,
): Promise<MergeReadyStatus> {
  const generatedAt = resolveGeneratedAt(options);
  const gitFacts = await discoverMergeReadyGitFacts({
    exec: options.exec,
    ...withOptionalCwd(options.cwd),
    ...withOptionalTimeout(options.timeout),
  });

  if (gitFacts.repository.kind !== 'git' || gitFacts.remote.kind !== 'github') {
    return createMergeReadyStatus({ generatedAt });
  }

  const commandCwd = gitFacts.repository.root;
  const pullRequestFacts = await fetchMergeReadyGitHubPullRequestFacts({
    exec: options.exec,
    cwd: commandCwd,
    ...withOptionalTimeout(options.timeout),
  });

  if (pullRequestFacts.kind === 'no_pr') {
    return createMergeReadyStatus({ generatedAt });
  }

  if (pullRequestFacts.kind !== 'found') {
    return createMergeReadyStatus({ generatedAt });
  }

  const pr = toMergeReadyPullRequest(pullRequestFacts.pullRequest);

  const conversations = await fetchMergeReadyPullRequestConversations({
    exec: options.exec,
    repositoryOwner: gitFacts.remote.owner,
    repositoryName: gitFacts.remote.repo,
    pullRequestNumber: pullRequestFacts.pullRequest.number,
    cwd: commandCwd,
    ...withOptionalTimeout(options.timeout),
  });

  const conversationSignals = normalizeConversationSignals(conversations);
  const signals: MergeReadySignalsInput = {
    draft: toBoolean(pullRequestFacts.pullRequest.draft),
    mergeability: pullRequestFacts.pullRequest.mergeability,
    checks: pullRequestFacts.pullRequest.checks.state,
    review: normalizeReviewSignal(pullRequestFacts.pullRequest),
    ...conversationSignals,
  };

  return createMergeReadyStatus({
    generatedAt,
    pr,
    signals,
  });
}

function resolveGeneratedAt(options: GetMergeReadyStatusOptions): string | Date {
  if (options.generatedAt !== undefined) {
    return options.generatedAt;
  }

  return options.now?.() ?? new Date();
}

function toMergeReadyPullRequest(pullRequest: MergeReadyGitHubPullRequest): MergeReadyPullRequest {
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
  };
}

function normalizeConversationSignals(
  conversations: MergeReadyPullRequestConversations,
): Pick<MergeReadySignalsInput, 'unresolvedConversations' | 'unresolvedConversationCount'> {
  if (conversations.kind === 'known' || conversations.kind === 'partial') {
    return {
      unresolvedConversations: conversations.unresolvedCount > 0,
      ...(conversations.unresolvedCount > 0
        ? { unresolvedConversationCount: conversations.unresolvedCount }
        : {}),
    };
  }

  return { unresolvedConversations: false };
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

function withOptionalCwd(cwd: string | undefined): { cwd?: string } {
  return cwd === undefined ? {} : { cwd };
}

function withOptionalTimeout(timeout: number | undefined): { timeout?: number } {
  return timeout === undefined ? {} : { timeout };
}
