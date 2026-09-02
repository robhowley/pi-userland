import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export const MERGE_READY_PROVIDER_COLLECTION_EVENT_V1 =
  'pi-merge-ready:collect-providers:v1' as const;

export type MergeReadyProviderFactV1<T> =
  | { kind: 'known'; value: T }
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

export type MergeReadyProviderEvidenceDetailV1 = {
  label: string;
  status?: 'failing' | 'running' | 'unknown';
  url?: string;
};

export type MergeReadyProviderEvidenceV1 = {
  reviewPending?: MergeReadyProviderEvidenceDetailV1[];
  changesRequested?: MergeReadyProviderEvidenceDetailV1[];
  unresolvedConversations?: MergeReadyProviderEvidenceDetailV1[];
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

export type MergeReadyProviderCheckDetailV1 = MergeReadyProviderEvidenceDetailV1 & {
  status: 'failing' | 'running' | 'unknown';
};

export type MergeReadyProviderChecksV1 = {
  state: 'passing' | 'failing' | 'running';
  details?: {
    failing: MergeReadyProviderCheckDetailV1[];
    running: MergeReadyProviderCheckDetailV1[];
    unknown: MergeReadyProviderCheckDetailV1[];
  };
};

export type MergeReadyProviderFactsV1 = {
  draft: MergeReadyProviderFactV1<boolean>;
  mergeability: MergeReadyProviderFactV1<'mergeable' | 'conflicting' | 'behind' | 'blocked'>;
  checks: MergeReadyProviderFactV1<MergeReadyProviderChecksV1>;
  review: MergeReadyProviderFactV1<'approved' | 'changes_requested' | 'pending'>;
  conversations: MergeReadyProviderFactV1<{
    unresolvedCount: number;
    requirement: 'required' | 'optional';
  }>;
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

export type MergeReadyProviderReadResultV1 =
  | {
      kind: 'found';
      pullRequest: MergeReadyProviderPullRequestV1;
      facts: MergeReadyProviderFactsV1;
      evidence?: MergeReadyProviderEvidenceV1;
      state?: never;
      summary?: never;
      openItems?: never;
    }
  | { kind: 'absent'; state?: never; summary?: never; openItems?: never }
  | {
      kind: 'unavailable';
      presence: 'known' | 'unknown';
      message: string;
      state?: never;
      summary?: never;
      openItems?: never;
    };

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
