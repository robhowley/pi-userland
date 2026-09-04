import { discoverMergeReadyGitContext, type MergeReadyExec } from './git.js';
import type {
  MergeReadyProviderEvidenceV1,
  MergeReadyProviderReadResultV1,
  MergeReadyProviderV1,
} from './provider-api.js';
import {
  createMergeReadyProviders,
  readMergeReadyProvider,
  resolveMergeReadyProviderForRemote,
  resolveMergeReadyProviderForUrl,
  type ProviderRemoteSelection,
  type ProviderUrlSelection,
} from './provider-registry.js';
import { createMergeReadyStatus } from './status.js';
import { assertValidGitHubPullRequestUrl, formatMergeReadyUrlTarget } from './target.js';
import type {
  MergeReadyCurrentBranchTarget,
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
  providers?: readonly MergeReadyProviderV1[];
};

export type MergeReadyStatusReader = (
  options: Omit<GetMergeReadyStatusOptions, 'providers'>,
) => Promise<MergeReadyStatus>;

export type MergeReadyUrlStatusReaderFactory = (options: {
  exec: MergeReadyExec;
  url: string;
}) => MergeReadyStatusReader;

export function createMergeReadyUrlStatusReader(
  options: GetMergeReadyStatusOptions & { url: string },
): MergeReadyStatusReader {
  const providers = createMergeReadyProviders(options.exec, options.providers);
  const selection = resolveMergeReadyProviderForUrl(options.url, providers);
  if (!selection) {
    throw new Error(
      `No merge-ready provider recognizes ${JSON.stringify(options.url)}. Pass a full pull request URL supported by a registered provider.`,
    );
  }
  const target: MergeReadyUrlTarget = { mode: 'url', ...selection.target };

  return async (readOptions) => {
    const generatedAt = readOptions.generatedAt ?? readOptions.now?.() ?? new Date();
    return getUrlStatus(readOptions, generatedAt, target, selection);
  };
}

export async function getMergeReadyStatus(
  options: GetMergeReadyStatusOptions,
): Promise<MergeReadyStatus> {
  const generatedAt = options.generatedAt ?? options.now?.() ?? new Date();
  const providers = createMergeReadyProviders(options.exec, options.providers);

  if (options.url !== undefined) {
    const selection = resolveMergeReadyProviderForUrl(options.url, providers);
    const target: MergeReadyUrlTarget = selection
      ? { mode: 'url', ...selection.target }
      : assertValidGitHubPullRequestUrl(options.url);
    return getUrlStatus(options, generatedAt, target, selection);
  }

  return getCurrentBranchStatus(options, generatedAt, providers);
}

async function getCurrentBranchStatus(
  options: GetMergeReadyStatusOptions,
  generatedAt: string | Date,
  providers: readonly MergeReadyProviderV1[],
): Promise<MergeReadyStatus> {
  const { facts: gitFacts, selectedRemote } = await discoverMergeReadyGitContext({
    exec: options.exec,
    ...withOptionalCwd(options.cwd),
    ...withOptionalTimeout(options.timeout),
  });
  const selection =
    gitFacts.repository.kind === 'git' && selectedRemote.kind === 'known'
      ? resolveMergeReadyProviderForRemote(selectedRemote, providers)
      : null;
  const target = toCurrentBranchTarget(gitFacts, selection);
  if (!selection || gitFacts.repository.kind !== 'git' || selectedRemote.kind !== 'known') {
    return createMergeReadyStatus({ generatedAt, target });
  }

  const result = await readMergeReadyProvider(
    selection.provider,
    {
      mode: 'ambient',
      remote: { name: selectedRemote.name, url: selectedRemote.url },
      repository: selection.repository,
      cwd: gitFacts.repository.root,
    },
    options.timeout,
  );
  return createStatusFromProviderResult(result, target, generatedAt);
}

async function getUrlStatus(
  options: GetMergeReadyStatusOptions,
  generatedAt: string | Date,
  target: MergeReadyUrlTarget,
  selection: ProviderUrlSelection | null,
): Promise<MergeReadyStatus> {
  if (!selection) return createMergeReadyStatus({ generatedAt, target });
  const result = await readMergeReadyProvider(
    selection.provider,
    {
      mode: 'url',
      target: {
        url: selection.target.url,
        owner: selection.target.owner,
        repo: selection.target.repo,
        prNumber: selection.target.prNumber,
      },
      ...withOptionalCwd(options.cwd),
    },
    options.timeout,
  );
  return createStatusFromProviderResult(result, target, generatedAt);
}

function createStatusFromProviderResult(
  result: MergeReadyProviderReadResultV1,
  target: MergeReadyTarget,
  generatedAt: string | Date,
): MergeReadyStatus {
  if (result.kind === 'absent') {
    if (target.mode !== 'url') return createMergeReadyStatus({ generatedAt, target });
    const summary = `Pull request not found: ${formatMergeReadyUrlTarget(target)}`;
    return createMergeReadyStatus({
      generatedAt,
      target,
      openItems: [{ id: 'no_pull_request', summary }],
      summary,
    });
  }
  if (result.kind === 'unavailable') {
    if (target.mode === 'url') {
      const summary = `Unable to determine readiness for ${formatMergeReadyUrlTarget(target)}: ${result.message}`;
      return createMergeReadyStatus({
        generatedAt,
        target,
        hasPr: true,
        openItems: [{ id: 'status_ambiguous', summary }],
        summary,
      });
    }
    const summary = `Unable to determine readiness: ${result.message}`;
    return createMergeReadyStatus({
      generatedAt,
      target,
      hasPr: true,
      openItems: [
        {
          id: 'status_ambiguous',
          summary,
          details: [{ label: result.message }],
        },
      ],
      summary,
    });
  }
  if (result.pullRequest.lifecycle !== 'open') {
    return createMergeReadyStatus({
      generatedAt,
      target,
      pr: result.pullRequest,
      ...(result.signals ? { signals: result.signals } : {}),
    });
  }

  const signals = result.signals;
  if (!signals) {
    return createMergeReadyStatus({ generatedAt, target, pr: result.pullRequest });
  }
  let status = createMergeReadyStatus({
    generatedAt,
    target,
    pr: result.pullRequest,
    signals,
    forceStatusAmbiguous: Boolean(result.issues?.length),
  });
  status = attachEvidence(status, result.evidence);
  if (result.issues?.length) status = attachIssues(status, result.issues);
  return status;
}

function attachEvidence(
  status: MergeReadyStatus,
  evidence: MergeReadyProviderEvidenceV1 | undefined,
): MergeReadyStatus {
  if (!evidence) return status;
  const detailsById = {
    review_pending: evidence.reviewPending,
    changes_requested: evidence.changesRequested,
    unresolved_conversations: evidence.unresolvedConversations,
  } as const;
  let changed = false;
  const openItems = status.openItems.map((item) => {
    const details =
      item.id in detailsById ? detailsById[item.id as keyof typeof detailsById] : undefined;
    if (!details?.length) return item;
    changed = true;
    return { ...item, details: [...details] };
  });
  return changed ? { ...status, openItems } : status;
}

function attachIssues(status: MergeReadyStatus, issues: readonly string[]): MergeReadyStatus {
  const details = issues.map((label) => ({ label }));
  return {
    ...status,
    openItems: status.openItems.map((item) =>
      item.id === 'status_ambiguous'
        ? { ...item, details: [...(item.details ?? []), ...details] }
        : item,
    ),
  };
}

function toCurrentBranchTarget(
  gitFacts: Awaited<ReturnType<typeof discoverMergeReadyGitContext>>['facts'],
  selection: ProviderRemoteSelection | null,
): MergeReadyCurrentBranchTarget {
  return {
    mode: 'current_branch',
    ...(selection ? selection.repository : {}),
    ...(gitFacts.branch.kind === 'known' ? { branch: gitFacts.branch.name } : {}),
  };
}

function withOptionalCwd(cwd: string | undefined): { cwd?: string } {
  return cwd === undefined ? {} : { cwd };
}
function withOptionalTimeout(timeout: number | undefined): { timeout?: number } {
  return timeout === undefined ? {} : { timeout };
}
