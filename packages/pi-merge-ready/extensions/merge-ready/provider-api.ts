import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { MergeReadyPullRequest, MergeReadySignals } from './types.js';

export const MERGE_READY_PROVIDER_COLLECTION_EVENT_V1 =
  'pi-merge-ready:collect-providers:v1' as const;

export type MergeReadyProviderUrlMatchV1 = {
  url: string;
  owner: string;
  repo: string;
  prNumber: number;
};

export type MergeReadyProviderRemoteV1 = {
  name: string;
  url: string;
};

export type MergeReadyProviderRemoteMatchV1 = {
  owner: string;
  repo: string;
};

export type MergeReadyProviderDetailV1 = {
  label: string;
  url?: string;
};

export type MergeReadyProviderEvidenceV1 = {
  reviewPending?: readonly MergeReadyProviderDetailV1[];
  changesRequested?: readonly MergeReadyProviderDetailV1[];
  unresolvedConversations?: readonly MergeReadyProviderDetailV1[];
};

export type MergeReadyProviderPullRequestV1 = MergeReadyPullRequest;
export type MergeReadyProviderSignalsV1 = MergeReadySignals;

export type MergeReadyProviderReadInputV1 = {
  cwd?: string;
  timeoutMs: number;
} & (
  | {
      mode: 'ambient';
      remote: MergeReadyProviderRemoteV1;
      repository: MergeReadyProviderRemoteMatchV1;
    }
  | {
      mode: 'url';
      target: MergeReadyProviderUrlMatchV1;
    }
);

type ForbiddenReadinessFields = {
  state?: never;
  summary?: never;
  openItems?: never;
};

export type MergeReadyProviderReadResultV1 =
  | ({
      kind: 'found';
      pullRequest: MergeReadyProviderPullRequestV1 & { lifecycle: 'open' };
      signals: MergeReadySignals;
      evidence?: MergeReadyProviderEvidenceV1;
      issues?: readonly string[];
    } & ForbiddenReadinessFields)
  | ({
      kind: 'found';
      pullRequest: MergeReadyProviderPullRequestV1 & { lifecycle: 'merged' | 'closed' };
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

export interface MergeReadyProviderV1 {
  readonly apiVersion: 1;
  readonly id: string;
  matchUrl(url: URL): MergeReadyProviderUrlMatchV1 | null;
  matchRemote(remote: MergeReadyProviderRemoteV1): MergeReadyProviderRemoteMatchV1 | null;
  read(input: MergeReadyProviderReadInputV1): Promise<MergeReadyProviderReadResultV1>;
  readonly state?: never;
  readonly summary?: never;
  readonly openItems?: never;
}

export function defineMergeReadyProvider<T extends MergeReadyProviderV1>(provider: T): T {
  return provider;
}

type ProviderCollectionV1 = { providers: MergeReadyProviderV1[] };

export function registerMergeReadyProvider(
  pi: Pick<ExtensionAPI, 'events'>,
  provider: MergeReadyProviderV1,
): () => void {
  return pi.events.on(MERGE_READY_PROVIDER_COLLECTION_EVENT_V1, (payload) => {
    if (isProviderCollectionV1(payload)) payload.providers.push(provider);
  });
}

function isProviderCollectionV1(value: unknown): value is ProviderCollectionV1 {
  return (
    typeof value === 'object' &&
    value !== null &&
    'providers' in value &&
    Array.isArray((value as { providers?: unknown }).providers)
  );
}
