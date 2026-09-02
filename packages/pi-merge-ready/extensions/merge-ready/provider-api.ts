import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export const MERGE_READY_PROVIDER_COLLECTION_EVENT_V1 =
  'pi-merge-ready:collect-providers:v1' as const;

export type MergeReadyProviderFactV1<T> =
  | { kind: 'known'; value: T }
  | { kind: 'partial'; value: T; message: string }
  | { kind: 'unknown'; message: string };

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

export type MergeReadyProviderRequiredCheckV1 = MergeReadyProviderDetailV1 & {
  status: 'passed' | 'failed' | 'running' | 'unknown';
};

export type MergeReadyProviderSourceReviewGateV1 = {
  state: 'satisfied' | 'changes_requested' | 'pending';
  details?: readonly MergeReadyProviderDetailV1[];
};

export type MergeReadyProviderPullRequestV1 = {
  lifecycle: 'open' | 'merged' | 'closed';
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  headRepository?: MergeReadyProviderRemoteMatchV1;
};

export type MergeReadyProviderFactsV1 = {
  draft: MergeReadyProviderFactV1<boolean>;
  hasConflicts: MergeReadyProviderFactV1<boolean>;
  behindBase: MergeReadyProviderFactV1<boolean>;
  sourceMergeGate: MergeReadyProviderFactV1<'clear' | 'blocked'>;
  requiredChecks: MergeReadyProviderFactV1<readonly MergeReadyProviderRequiredCheckV1[]>;
  sourceReviewGate: MergeReadyProviderFactV1<MergeReadyProviderSourceReviewGateV1>;
  unresolvedConversations: MergeReadyProviderFactV1<readonly MergeReadyProviderDetailV1[]>;
  conversationResolutionRequired: MergeReadyProviderFactV1<boolean>;
};

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
  signals?: never;
};

export type MergeReadyProviderReadResultV1 =
  | ({
      kind: 'found';
      pullRequest: MergeReadyProviderPullRequestV1 & { lifecycle: 'open' };
      facts: MergeReadyProviderFactsV1;
    } & ForbiddenReadinessFields)
  | ({
      kind: 'found';
      pullRequest: MergeReadyProviderPullRequestV1 & { lifecycle: 'merged' | 'closed' };
      facts?: never;
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
  readonly signals?: never;
}

export function defineMergeReadyProvider<T extends MergeReadyProviderV1>(provider: T): T {
  return provider;
}

type ProviderCollectionV1 = {
  providers: MergeReadyProviderV1[];
};

export function registerMergeReadyProvider(
  pi: Pick<ExtensionAPI, 'events'>,
  provider: MergeReadyProviderV1,
): () => void {
  return pi.events.on(MERGE_READY_PROVIDER_COLLECTION_EVENT_V1, (payload) => {
    if (!isProviderCollectionV1(payload)) {
      return;
    }

    payload.providers.push(provider);
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
