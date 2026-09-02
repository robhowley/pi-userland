import type { MergeReadyExec } from './git.js';
import type {
  MergeReadyOpenItemDetail,
  MergeReadyPullRequest,
  MergeReadySignals,
  MergeReadyUrlTarget,
} from './types.js';

export type ProviderRepository = {
  owner: string;
  repo: string;
};

export type ProviderUrlTarget = MergeReadyUrlTarget;

export type ProviderIssue = {
  message: string;
};

export type ProviderSupportingEvidence = {
  reviewPending?: MergeReadyOpenItemDetail[];
  changesRequested?: MergeReadyOpenItemDetail[];
  unresolvedConversations?: MergeReadyOpenItemDetail[];
};

export type ProviderSnapshot = {
  pullRequest: MergeReadyPullRequest;
  signals: MergeReadySignals;
  supportingEvidence: ProviderSupportingEvidence;
  integrityIssues: ProviderIssue[];
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
