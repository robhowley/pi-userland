import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { MergeReadyPullRequest, MergeReadySignals } from './types.js';

export const MERGE_READY_PROVIDER_COLLECTION_EVENT = 'pi-merge-ready:collect-providers' as const;

export type MergeReadyProviderUrlMatch = {
  url: string;
  owner: string;
  repo: string;
  prNumber: number;
};

export type MergeReadyProviderRemote = {
  name: string;
  url: string;
};

export type MergeReadyProviderRemoteMatch = {
  owner: string;
  repo: string;
};

export type MergeReadyProviderDetail = {
  label: string;
  url?: string;
};

export type MergeReadyProviderEvidence = {
  reviewPending?: readonly MergeReadyProviderDetail[];
  changesRequested?: readonly MergeReadyProviderDetail[];
  unresolvedConversations?: readonly MergeReadyProviderDetail[];
};

export type MergeReadyProviderPullRequest = MergeReadyPullRequest;
export type MergeReadyProviderSignals = MergeReadySignals;

export type MergeReadyProviderReadInput = {
  cwd?: string;
  timeoutMs: number;
} & (
  | {
      mode: 'ambient';
      remote: MergeReadyProviderRemote;
      repository: MergeReadyProviderRemoteMatch;
    }
  | {
      mode: 'url';
      target: MergeReadyProviderUrlMatch;
    }
);

type ForbiddenReadinessFields = {
  state?: never;
  summary?: never;
  openItems?: never;
};

export type MergeReadyProviderReadResult =
  | ({
      kind: 'found';
      pullRequest: MergeReadyProviderPullRequest & { lifecycle: 'open' };
      signals: MergeReadySignals;
      evidence?: MergeReadyProviderEvidence;
      issues?: readonly string[];
    } & ForbiddenReadinessFields)
  | ({
      kind: 'found';
      pullRequest: MergeReadyProviderPullRequest & { lifecycle: 'merged' | 'closed' };
      signals?: MergeReadySignals;
      evidence?: never;
      issues?: never;
    } & ForbiddenReadinessFields)
  | ({ kind: 'absent' } & ForbiddenReadinessFields)
  | ({
      kind: 'unavailable';
      presence: 'known' | 'unknown';
      message: string;
    } & ForbiddenReadinessFields);

export interface MergeReadyProvider {
  readonly id: string;
  matchUrl(url: URL): MergeReadyProviderUrlMatch | null;
  matchRemote(remote: MergeReadyProviderRemote): MergeReadyProviderRemoteMatch | null;
  read(input: MergeReadyProviderReadInput): Promise<MergeReadyProviderReadResult>;
  readonly state?: never;
  readonly summary?: never;
  readonly openItems?: never;
}

export function defineMergeReadyProvider<T extends MergeReadyProvider>(provider: T): T {
  return provider;
}

type ProviderCollection = { providers: MergeReadyProvider[] };

export function registerMergeReadyProvider(
  pi: Pick<ExtensionAPI, 'events'>,
  provider: MergeReadyProvider,
): () => void {
  return pi.events.on(MERGE_READY_PROVIDER_COLLECTION_EVENT, (payload) => {
    if (isProviderCollection(payload)) payload.providers.push(provider);
  });
}

function isProviderCollection(value: unknown): value is ProviderCollection {
  return (
    typeof value === 'object' &&
    value !== null &&
    'providers' in value &&
    Array.isArray((value as { providers?: unknown }).providers)
  );
}
