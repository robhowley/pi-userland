import type { MergeReadyExec } from './git.js';
import type {
  MergeReadyProviderDetailV1,
  MergeReadyProviderFactV1,
  MergeReadyProviderRequiredCheckV1,
  MergeReadyProviderSourceReviewGateV1,
} from './provider-api.js';
import type { MergeReadyPullRequest, MergeReadyUrlTarget } from './types.js';

export type ProviderRepository = {
  owner: string;
  repo: string;
};

export type ProviderUrlTarget = MergeReadyUrlTarget;

export type ProviderIssue = {
  message: string;
};

export type ProviderFact<T> = MergeReadyProviderFactV1<T>;
export type ProviderDetail = MergeReadyProviderDetailV1;
export type ProviderRequiredCheck = MergeReadyProviderRequiredCheckV1;
export type ProviderSourceReviewGate = MergeReadyProviderSourceReviewGateV1;

export type ProviderOpenPullRequestFacts = {
  draft: ProviderFact<boolean>;
  hasConflicts: ProviderFact<boolean>;
  behindBase: ProviderFact<boolean>;
  sourceMergeGate: ProviderFact<'clear' | 'blocked'>;
  requiredChecks: ProviderFact<readonly ProviderRequiredCheck[]>;
  sourceReviewGate: ProviderFact<ProviderSourceReviewGate>;
  unresolvedConversations: ProviderFact<readonly ProviderDetail[]>;
  conversationResolutionRequired: ProviderFact<boolean>;
};

export type ProviderSnapshot =
  | {
      pullRequest: MergeReadyPullRequest & { lifecycle: 'open' };
      facts: ProviderOpenPullRequestFacts;
    }
  | {
      pullRequest: MergeReadyPullRequest & { lifecycle: 'merged' | 'closed' };
      facts?: never;
    };

export type ProviderReadResult =
  | { kind: 'found'; snapshot: ProviderSnapshot }
  | { kind: 'absent' }
  | {
      kind: 'unavailable';
      presence: 'unknown' | 'known';
      issues: [ProviderIssue, ...ProviderIssue[]];
    };

export type ProviderRemote = {
  name: string;
  url: string;
};

export type ProviderReadInput = {
  exec: MergeReadyExec;
  cwd?: string;
  timeout?: number;
} & (
  | {
      mode: 'ambient';
      remote?: ProviderRemote;
      repository: ProviderRepository;
    }
  | {
      mode: 'url';
      target: ProviderUrlTarget;
    }
);

export interface MergeReadyProvider {
  readonly id: string;
  parseUrl(url: URL): ProviderUrlTarget | null;
  parseRemote(remote: ProviderRemote): ProviderRepository | null;
  read(input: ProviderReadInput): Promise<ProviderReadResult>;
}
