import { discoverMergeReadyGitContext, type MergeReadyExec } from './git.js';
import type { ProviderReadResult, ProviderSupportingEvidence } from './provider.js';
import {
  resolveMergeReadyProviderForRemote,
  resolveMergeReadyProviderForUrl,
  type ProviderRemoteSelection,
} from './provider-registry.js';
import { createMergeReadyStatus } from './status.js';
import { assertValidGitHubPullRequestUrl, formatMergeReadyUrlTarget } from './target.js';
import type {
  MergeReadyCurrentBranchTarget,
  MergeReadyOpenItem,
  MergeReadyOpenItemDetail,
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
    const target = assertValidGitHubPullRequestUrl(options.url);
    return getMergeReadyUrlStatus(options, generatedAt, target);
  }

  return getCurrentBranchMergeReadyStatus(options, generatedAt);
}

async function getCurrentBranchMergeReadyStatus(
  options: GetMergeReadyStatusOptions,
  generatedAt: string | Date,
): Promise<MergeReadyStatus> {
  const { facts: gitFacts, selectedRemote } = await discoverMergeReadyGitContext({
    exec: options.exec,
    ...withOptionalCwd(options.cwd),
    ...withOptionalTimeout(options.timeout),
  });
  const selection =
    gitFacts.repository.kind === 'git' && selectedRemote.kind === 'known'
      ? resolveMergeReadyProviderForRemote(selectedRemote)
      : null;
  const target = toCurrentBranchTarget(gitFacts, selection);

  if (!selection || gitFacts.repository.kind !== 'git') {
    return createMergeReadyStatus({ generatedAt, target });
  }

  const result = await selection.provider.read({
    mode: 'ambient',
    repository: selection.repository,
    exec: options.exec,
    cwd: gitFacts.repository.root,
    ...withOptionalTimeout(options.timeout),
  });

  return createStatusFromProviderResult(result, target, generatedAt);
}

async function getMergeReadyUrlStatus(
  options: GetMergeReadyStatusOptions,
  generatedAt: string | Date,
  target: MergeReadyUrlTarget,
): Promise<MergeReadyStatus> {
  const selection = resolveMergeReadyProviderForUrl(target.url);
  if (!selection) {
    return createMergeReadyStatus({ generatedAt, target });
  }

  const result = await selection.provider.read({
    mode: 'url',
    target: selection.target,
    exec: options.exec,
    ...withOptionalCwd(options.cwd),
    ...withOptionalTimeout(options.timeout),
  });

  return createStatusFromProviderResult(result, target, generatedAt);
}

function createStatusFromProviderResult(
  result: ProviderReadResult,
  target: MergeReadyTarget,
  generatedAt: string | Date,
): MergeReadyStatus {
  if (result.kind === 'absent') {
    if (target.mode === 'url') {
      const summary = `Pull request not found: ${formatMergeReadyUrlTarget(target)}`;
      return createMergeReadyStatus({
        generatedAt,
        target,
        openItems: [createOpenItem('no_pull_request', summary)],
        summary,
      });
    }

    return createMergeReadyStatus({ generatedAt, target });
  }

  if (result.kind === 'unavailable') {
    if (target.mode === 'url') {
      const summary = `Unable to determine readiness for ${formatMergeReadyUrlTarget(target)}: ${result.issues[0].message}`;
      return createMergeReadyStatus({
        generatedAt,
        target,
        hasPr: true,
        openItems: [createOpenItem('status_ambiguous', summary)],
        summary,
      });
    }

    return createMergeReadyStatus({
      generatedAt,
      target,
      hasPr: true,
      forceStatusAmbiguous: true,
    });
  }

  const status = createMergeReadyStatus({
    generatedAt,
    target,
    pr: result.snapshot.pullRequest,
    signals: result.snapshot.signals,
    forceStatusAmbiguous: result.snapshot.integrityIssues.length > 0,
  });

  return attachSupportingEvidence(status, result.snapshot.supportingEvidence);
}

function attachSupportingEvidence(
  status: MergeReadyStatus,
  evidence: ProviderSupportingEvidence,
): MergeReadyStatus {
  return appendOpenItemDetails(
    appendOpenItemDetails(
      appendOpenItemDetails(status, 'review_pending', evidence.reviewPending),
      'changes_requested',
      evidence.changesRequested,
    ),
    'unresolved_conversations',
    evidence.unresolvedConversations,
  );
}

function appendOpenItemDetails(
  status: MergeReadyStatus,
  openItemId: MergeReadyOpenItem['id'],
  additionalDetails: MergeReadyOpenItemDetail[] | undefined,
): MergeReadyStatus {
  if (!additionalDetails || additionalDetails.length === 0) {
    return status;
  }

  let didChange = false;
  const openItems = status.openItems.map((openItem) => {
    if (openItem.id !== openItemId) {
      return openItem;
    }

    didChange = true;
    return {
      ...openItem,
      details:
        openItem.details && openItem.details.length > 0
          ? [...openItem.details, ...additionalDetails]
          : additionalDetails,
    };
  });

  return didChange ? { ...status, openItems } : status;
}

function toCurrentBranchTarget(
  gitFacts: Awaited<ReturnType<typeof discoverMergeReadyGitContext>>['facts'],
  selection: ProviderRemoteSelection | null,
): MergeReadyCurrentBranchTarget {
  return {
    mode: 'current_branch',
    ...(selection
      ? {
          owner: selection.repository.owner,
          repo: selection.repository.repo,
        }
      : {}),
    ...(gitFacts.branch.kind === 'known' ? { branch: gitFacts.branch.name } : {}),
  };
}

function resolveGeneratedAt(options: GetMergeReadyStatusOptions): string | Date {
  if (options.generatedAt !== undefined) {
    return options.generatedAt;
  }

  return options.now?.() ?? new Date();
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
