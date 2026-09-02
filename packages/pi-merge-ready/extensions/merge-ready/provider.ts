import type { MergeReadyExec } from './git.js';
import type {
  MergeReadyOpenItemDetail,
  MergeReadyPullRequest,
  MergeReadySignalsInput,
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
  signals: MergeReadySignalsInput;
  forceStatusAmbiguous: boolean;
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

export type ProviderReadInput = {
  exec: MergeReadyExec;
  cwd?: string;
  timeout?: number;
} & (
  | {
      mode: 'ambient';
      repository: ProviderRepository;
    }
  | {
      mode: 'url';
      target: ProviderUrlTarget;
    }
);

export interface MergeReadyProvider {
  readonly id: 'github';
  parseUrl(url: URL): ProviderUrlTarget | null;
  parseRemote(remote: string): ProviderRepository | null;
  read(input: ProviderReadInput): Promise<ProviderReadResult>;
}
