export type MergeReadyState = 'ready' | 'blocked' | 'pending' | 'unknown';

export type PullRequestLifecycle = 'open' | 'merged' | 'closed';

export type MergeReadyBadgeId =
  | 'draft'
  | 'ci_failing'
  | 'changes_requested'
  | 'unresolved_conversations'
  | 'ci_running'
  | 'review_pending'
  | 'ready'
  | 'merged'
  | 'closed'
  | 'unknown';

export type MergeReadyPullRequest = {
  lifecycle: PullRequestLifecycle;
  number?: number;
  title?: string;
  url?: string;
};

export type MergeReadyDiscoveryState = 'complete' | 'ambiguous';

export type MergeReadyPresence = 'present' | 'missing' | 'unknown';

export type MergeReadyBooleanSignal = 'yes' | 'no' | 'unknown';

export type MergeReadyChecksSignal = 'passing' | 'failing' | 'running' | 'unknown';

export type MergeReadyReviewSignal = 'approved' | 'changes_requested' | 'pending' | 'unknown';

export type MergeReadySignals = {
  discovery: MergeReadyDiscoveryState;
  pullRequest: MergeReadyPresence;
  draft: MergeReadyBooleanSignal;
  checks: MergeReadyChecksSignal;
  review: MergeReadyReviewSignal;
  unresolvedConversations: MergeReadyBooleanSignal;
};

export type MergeReadySignalsInput = {
  discovery?: MergeReadyDiscoveryState;
  pullRequest?: boolean | MergeReadyPresence;
  draft?: boolean | MergeReadyBooleanSignal;
  checks?: MergeReadyChecksSignal;
  review?: MergeReadyReviewSignal;
  unresolvedConversations?: boolean | MergeReadyBooleanSignal;
};

export type MergeReadyOpenItemId =
  | 'no_pull_request'
  | 'status_ambiguous'
  | 'draft'
  | 'ci_failing'
  | 'changes_requested'
  | 'unresolved_conversations'
  | 'ci_running'
  | 'review_pending';

export type MergeReadyOpenItemOwner = 'agent' | 'user' | 'reviewer' | 'ci' | 'github' | 'wait';

export type MergeReadyOpenItemActionability = 'actionable' | 'waiting';

export type MergeReadyOpenItem = {
  id: MergeReadyOpenItemId;
  owner: MergeReadyOpenItemOwner;
  actionability: MergeReadyOpenItemActionability;
  summary: string;
};

export type MergeReadyStatus = {
  state: MergeReadyState;
  pr: MergeReadyPullRequest | null;
  summary: string;
  openItems: MergeReadyOpenItem[];
  signals: MergeReadySignals;
  generatedAt: string;
};

export type CreateMergeReadyStatusOptions = {
  generatedAt: string | Date;
  pr?: MergeReadyPullRequest | null;
  signals?: MergeReadySignalsInput;
};

export type MergeReadyBadgeContext = Pick<MergeReadyStatus, 'pr' | 'openItems'>;
