import {
  fetchMergeReadyPullRequestConversations,
  type MergeReadyPullRequestConversations,
} from './conversations.js';
import { discoverMergeReadyGitFacts, type MergeReadyExec } from './git.js';
import {
  fetchMergeReadyGitHubPullRequestFacts,
  type MergeReadyGitHubPullRequest,
} from './github.js';
import { createMergeReadyStatus } from './status.js';
import type {
  MergeReadyBooleanSignal,
  MergeReadyPullRequest,
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
    return createMergeReadyStatus({
      generatedAt,
      signals: { pullRequest: false },
    });
  }

  if (pullRequestFacts.kind !== 'found') {
    return createMergeReadyStatus({ generatedAt });
  }

  const pr = toMergeReadyPullRequest(pullRequestFacts.pullRequest);
  if (pr.lifecycle !== 'open') {
    return createMergeReadyStatus({ generatedAt, pr });
  }

  const signals: MergeReadySignalsInput = {
    draft: pullRequestFacts.pullRequest.draft,
    checks: pullRequestFacts.pullRequest.checks.state,
    review: pullRequestFacts.pullRequest.reviews.state,
    unresolvedConversations: normalizeConversationSignal(
      await fetchMergeReadyPullRequestConversations({
        exec: options.exec,
        repositoryOwner: gitFacts.remote.owner,
        repositoryName: gitFacts.remote.repo,
        pullRequestNumber: pullRequestFacts.pullRequest.number,
        cwd: commandCwd,
        ...withOptionalTimeout(options.timeout),
      }),
    ),
  };

  return createMergeReadyStatus({
    generatedAt,
    pr,
    // Preserve the phase-1 rule that any unknown open-PR signal degrades the
    // composed status to ambiguous rather than reporting a false negative.
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
    lifecycle: pullRequest.lifecycle,
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
  };
}

function normalizeConversationSignal(
  conversations: MergeReadyPullRequestConversations,
): MergeReadyBooleanSignal {
  if (conversations.kind === 'known') {
    return conversations.unresolvedCount > 0 ? 'yes' : 'no';
  }

  if (conversations.kind === 'partial') {
    return conversations.unresolvedCount > 0 ? 'yes' : 'unknown';
  }

  return 'unknown';
}

function withOptionalCwd(cwd: string | undefined): { cwd?: string } {
  return cwd === undefined ? {} : { cwd };
}

function withOptionalTimeout(timeout: number | undefined): { timeout?: number } {
  return timeout === undefined ? {} : { timeout };
}
