import { discoverMergeReadyGitContext, type MergeReadyExec } from './git.js';
import type { MergeReadyProviderV1 } from './provider-api.js';
import {
  createMergeReadyProviderCatalog,
  type MergeReadyProviderCatalog,
} from './provider-catalog.js';
import type { ProviderReadResult } from './provider.js';
import {
  resolveMergeReadyProviderForRemote,
  resolveMergeReadyProviderForUrl,
  type ProviderRemoteSelection,
  type ProviderUrlSelection,
} from './provider-registry.js';
import { createMergeReadyStatus, createMergeReadyStatusFromFacts } from './status.js';
import { assertValidGitHubPullRequestUrl, formatMergeReadyUrlTarget } from './target.js';
import type {
  MergeReadyCurrentBranchTarget,
  MergeReadyOpenItem,
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

export async function getMergeReadyStatus(
  options: GetMergeReadyStatusOptions,
): Promise<MergeReadyStatus> {
  return getMergeReadyStatusWithCatalog(
    options,
    createMergeReadyProviderCatalog(options.providers),
  );
}

export function createCatalogBoundMergeReadyStatusReader(
  catalog: MergeReadyProviderCatalog,
): MergeReadyStatusReader {
  return (options) => getMergeReadyStatusWithCatalog(options, catalog);
}

async function getMergeReadyStatusWithCatalog(
  options: Omit<GetMergeReadyStatusOptions, 'providers'>,
  catalog: MergeReadyProviderCatalog,
): Promise<MergeReadyStatus> {
  const generatedAt = resolveGeneratedAt(options);

  if (options.url !== undefined) {
    const selection = resolveMergeReadyProviderForUrl(options.url, catalog);
    const target = selection?.target ?? assertValidGitHubPullRequestUrl(options.url);
    return getMergeReadyUrlStatus(options, generatedAt, target, selection);
  }

  return getCurrentBranchMergeReadyStatus(options, generatedAt, catalog);
}

async function getCurrentBranchMergeReadyStatus(
  options: Omit<GetMergeReadyStatusOptions, 'providers'>,
  generatedAt: string | Date,
  catalog: MergeReadyProviderCatalog,
): Promise<MergeReadyStatus> {
  const { facts: gitFacts, selectedRemote } = await discoverMergeReadyGitContext({
    exec: options.exec,
    ...withOptionalCwd(options.cwd),
    ...withOptionalTimeout(options.timeout),
  });
  const selection =
    gitFacts.repository.kind === 'git' && selectedRemote.kind === 'known'
      ? resolveMergeReadyProviderForRemote(selectedRemote, catalog)
      : null;
  const target = toCurrentBranchTarget(gitFacts, selection);

  if (!selection || gitFacts.repository.kind !== 'git' || selectedRemote.kind !== 'known') {
    return createMergeReadyStatus({ generatedAt, target });
  }

  const result = await selection.provider.read({
    mode: 'ambient',
    remote: selectedRemote,
    repository: selection.repository,
    exec: options.exec,
    cwd: gitFacts.repository.root,
    ...withOptionalTimeout(options.timeout),
  });

  return createStatusFromProviderResult(result, target, generatedAt);
}

async function getMergeReadyUrlStatus(
  options: Omit<GetMergeReadyStatusOptions, 'providers'>,
  generatedAt: string | Date,
  target: MergeReadyUrlTarget,
  selection: ProviderUrlSelection | null,
): Promise<MergeReadyStatus> {
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

  if (result.snapshot.pullRequest.lifecycle !== 'open') {
    return createMergeReadyStatus({
      generatedAt,
      target,
      pr: result.snapshot.pullRequest,
    });
  }

  if (!result.snapshot.facts) {
    return createMergeReadyStatus({
      generatedAt,
      target,
      pr: result.snapshot.pullRequest,
      forceStatusAmbiguous: true,
    });
  }

  return createMergeReadyStatusFromFacts({
    generatedAt,
    target,
    pr: result.snapshot.pullRequest,
    facts: result.snapshot.facts,
  });
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
