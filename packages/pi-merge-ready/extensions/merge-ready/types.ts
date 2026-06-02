export type MergeReadyState = 'ready' | 'blocked' | 'pending' | 'unknown';

export type PullRequestLifecycle = 'open' | 'merged' | 'closed';

export type MergeReadyBadgeId =
  | 'draft'
  | 'merge_conflicts'
  | 'branch_out_of_date'
  | 'merge_blocked'
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
  number: number;
  title: string;
  url: string;
};

export type MergeReadyBooleanSignal = 'yes' | 'no' | 'unknown';

export type MergeReadyChecksSignal = 'passing' | 'failing' | 'running' | 'unknown';

export type MergeReadyCheckDetailStatus = Exclude<MergeReadyChecksSignal, 'passing'>;

export type MergeReadyOpenItemDetail = {
  label: string;
  status: MergeReadyCheckDetailStatus;
  url?: string;
};

export type MergeReadyCheckDetail = MergeReadyOpenItemDetail;

export type MergeReadyCheckDetails = {
  failing: MergeReadyCheckDetail[];
  running: MergeReadyCheckDetail[];
  unknown: MergeReadyCheckDetail[];
};

export type MergeReadyReviewSignal = 'approved' | 'changes_requested' | 'pending' | 'unknown';

export type MergeReadyConversationRequirementSignal = 'required' | 'optional' | 'unknown';

export type MergeReadyMergeabilitySignal =
  | 'mergeable'
  | 'conflicting'
  | 'behind'
  | 'blocked'
  | 'unknown';

export type MergeReadySignals = {
  draft: boolean;
  mergeability: MergeReadyMergeabilitySignal;
  checks: MergeReadyChecksSignal;
  checkDetails?: MergeReadyCheckDetails;
  review: MergeReadyReviewSignal;
  unresolvedConversations: boolean;
  unresolvedConversationCount?: number;
  unresolvedConversationRequirement: MergeReadyConversationRequirementSignal;
};

export type MergeReadySignalsInput = {
  draft?: boolean;
  mergeability?: MergeReadyMergeabilitySignal;
  checks?: MergeReadyChecksSignal;
  checkDetails?: MergeReadyCheckDetails;
  review?: MergeReadyReviewSignal;
  unresolvedConversations?: boolean;
  unresolvedConversationCount?: number;
  unresolvedConversationRequirement?: MergeReadyConversationRequirementSignal;
};

export type MergeReadyOpenItemId =
  | 'no_pull_request'
  | 'status_ambiguous'
  | 'merge_conflicts'
  | 'branch_out_of_date'
  | 'merge_blocked'
  | 'draft'
  | 'ci_failing'
  | 'changes_requested'
  | 'unresolved_conversations'
  | 'ci_running'
  | 'review_pending';

export type MergeReadyOpenItem = {
  id: MergeReadyOpenItemId;
  summary: string;
  details?: MergeReadyOpenItemDetail[];
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
  hasPr?: boolean;
  forceStatusAmbiguous?: boolean;
  signals?: MergeReadySignalsInput;
};

export type MergeReadyBadgeContext = Pick<MergeReadyStatus, 'pr' | 'openItems'>;
