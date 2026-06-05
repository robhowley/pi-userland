export type MergeReadyState = 'ready' | 'blocked' | 'pending' | 'unknown';

export type PullRequestLifecycle = 'open' | 'merged' | 'closed';

export type MergeReadyCurrentBranchTarget = {
  mode: 'current_branch';
  owner?: string;
  repo?: string;
  branch?: string;
};

export type MergeReadyUrlTarget = {
  mode: 'url';
  url: string;
  owner: string;
  repo: string;
  prNumber: number;
};

export type MergeReadyTarget = MergeReadyCurrentBranchTarget | MergeReadyUrlTarget;

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

export type MergeReadyRepositoryIdentity = {
  owner: string;
  repo: string;
};

export type MergeReadyPullRequest = {
  lifecycle: PullRequestLifecycle;
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  headRepository?: MergeReadyRepositoryIdentity;
};

export type MergeReadyBooleanSignal = 'yes' | 'no' | 'unknown';

export type MergeReadyChecksSignal = 'passing' | 'failing' | 'running' | 'unknown';

export type MergeReadyCheckDetailStatus = Exclude<MergeReadyChecksSignal, 'passing'>;

export type MergeReadyOpenItemDetail = {
  label: string;
  status?: MergeReadyCheckDetailStatus;
  url?: string;
};

export type MergeReadyCheckDetail = MergeReadyOpenItemDetail & {
  status: MergeReadyCheckDetailStatus;
};

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
  target: MergeReadyTarget;
  pr: MergeReadyPullRequest | null;
  summary: string;
  openItems: MergeReadyOpenItem[];
  signals: MergeReadySignals;
  generatedAt: string;
};

export type CreateMergeReadyStatusOptions = {
  generatedAt: string | Date;
  target?: MergeReadyTarget;
  pr?: MergeReadyPullRequest | null;
  hasPr?: boolean;
  forceStatusAmbiguous?: boolean;
  signals?: MergeReadySignalsInput;
  openItems?: MergeReadyOpenItem[];
  summary?: string;
};

export type MergeReadyBadgeContext = Pick<MergeReadyStatus, 'pr' | 'openItems'>;
