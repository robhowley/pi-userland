import type {
  CreateMergeReadyStatusOptions,
  MergeReadyBadgeContext,
  MergeReadyBadgeId,
  MergeReadyOpenItem,
  MergeReadyOpenItemId,
  MergeReadySignals,
  MergeReadySignalsInput,
  MergeReadyState,
  MergeReadyStatus,
} from './types.js';

const OPEN_ITEM_PRIORITY = {
  no_pull_request: 0,
  status_ambiguous: 1,
  merge_conflicts: 2,
  branch_out_of_date: 3,
  merge_blocked: 4,
  draft: 5,
  ci_failing: 6,
  changes_requested: 7,
  unresolved_conversations: 8,
  ci_running: 9,
  review_pending: 10,
} as const satisfies Record<MergeReadyOpenItemId, number>;

const OPEN_ITEM_STATE = {
  no_pull_request: 'unknown',
  status_ambiguous: 'unknown',
  merge_conflicts: 'blocked',
  branch_out_of_date: 'blocked',
  merge_blocked: 'blocked',
  draft: 'blocked',
  ci_failing: 'blocked',
  changes_requested: 'blocked',
  unresolved_conversations: 'blocked',
  ci_running: 'pending',
  review_pending: 'pending',
} as const satisfies Record<MergeReadyOpenItemId, MergeReadyState>;

const OPEN_ITEM_BADGE = {
  no_pull_request: 'unknown',
  status_ambiguous: 'unknown',
  merge_conflicts: 'merge_conflicts',
  branch_out_of_date: 'branch_out_of_date',
  merge_blocked: 'merge_blocked',
  draft: 'draft',
  ci_failing: 'ci_failing',
  changes_requested: 'changes_requested',
  unresolved_conversations: 'unresolved_conversations',
  ci_running: 'ci_running',
  review_pending: 'review_pending',
} as const satisfies Record<MergeReadyOpenItemId, MergeReadyBadgeId>;

const OPEN_ITEM_SUMMARY = {
  no_pull_request: 'No pull request found',
  status_ambiguous: 'Merge readiness is ambiguous',
  merge_conflicts: 'Merge conflicts detected',
  branch_out_of_date: 'Branch is out of date with base',
  merge_blocked: 'GitHub reports merge is blocked',
  draft: 'Pull request is still a draft',
  ci_failing: 'Required checks are failing',
  changes_requested: 'Changes requested by reviewers',
  unresolved_conversations: 'Unresolved review conversations remain',
  ci_running: 'Checks are still running',
  review_pending: 'Waiting for review',
} as const satisfies Record<MergeReadyOpenItemId, string>;

export function normalizeMergeReadySignals(
  input: MergeReadySignalsInput = {},
  hasPr: boolean = false,
): MergeReadySignals {
  const draft = input.draft ?? false;
  const mergeability = input.mergeability ?? 'unknown';
  const checks = input.checks ?? 'unknown';
  const review = input.review ?? 'unknown';
  const unresolvedConversations = input.unresolvedConversations ?? false;

  if (!hasPr) {
    return {
      draft: false,
      mergeability: 'unknown',
      checks: 'unknown',
      review: 'unknown',
      unresolvedConversations: false,
    };
  }

  return {
    draft,
    mergeability,
    checks,
    review,
    unresolvedConversations,
  };
}

export function deriveMergeReadyOpenItems(
  signals: MergeReadySignals,
  hasPr: boolean,
): MergeReadyOpenItem[] {
  const openItems: MergeReadyOpenItem[] = [];

  if (!hasPr) {
    openItems.push(createOpenItem('no_pull_request'));
    return openItems;
  }

  if (signals.mergeability === 'unknown') {
    openItems.push(createOpenItem('status_ambiguous'));
  }

  if (signals.mergeability === 'conflicting') {
    openItems.push(createOpenItem('merge_conflicts'));
  }

  if (signals.mergeability === 'behind') {
    openItems.push(createOpenItem('branch_out_of_date'));
  }

  if (signals.mergeability === 'blocked' && !signals.draft) {
    openItems.push(createOpenItem('merge_blocked'));
  }

  if (signals.draft) {
    openItems.push(createOpenItem('draft'));
  }

  if (signals.checks === 'failing') {
    openItems.push(createOpenItem('ci_failing'));
  }

  if (signals.review === 'changes_requested') {
    openItems.push(createOpenItem('changes_requested'));
  }

  if (signals.unresolvedConversations) {
    openItems.push(createOpenItem('unresolved_conversations'));
  }

  if (signals.checks === 'running') {
    openItems.push(createOpenItem('ci_running'));
  }

  if (signals.review === 'pending') {
    openItems.push(createOpenItem('review_pending'));
  }

  return openItems.sort(
    (left, right) => OPEN_ITEM_PRIORITY[left.id] - OPEN_ITEM_PRIORITY[right.id],
  );
}

export function deriveMergeReadyState(openItems: MergeReadyOpenItem[]): MergeReadyState {
  const topOpenItem = selectTopOpenItem(openItems);
  return topOpenItem ? OPEN_ITEM_STATE[topOpenItem.id] : 'ready';
}

export function deriveMergeReadySummary(context: MergeReadyBadgeContext): string {
  const topOpenItem = selectTopOpenItem(context.openItems);
  if (topOpenItem) {
    return topOpenItem.summary;
  }

  if (context.pr) {
    return 'Ready to merge';
  }

  return 'No pull request';
}

export function selectMergeReadyBadgeId(context: MergeReadyBadgeContext): MergeReadyBadgeId {
  const topOpenItem = selectTopOpenItem(context.openItems);
  if (topOpenItem) {
    return OPEN_ITEM_BADGE[topOpenItem.id];
  }

  if (context.pr) {
    return 'ready';
  }

  return 'unknown';
}

export function createMergeReadyStatus(options: CreateMergeReadyStatusOptions): MergeReadyStatus {
  const pr = options.pr ?? null;
  const hasPr = pr !== null;
  const signals = normalizeMergeReadySignals(options.signals, hasPr);
  const openItems = deriveMergeReadyOpenItems(signals, hasPr);

  return {
    state: deriveMergeReadyState(openItems),
    pr,
    summary: deriveMergeReadySummary({ pr, openItems }),
    openItems,
    signals,
    generatedAt: normalizeGeneratedAt(options.generatedAt),
  };
}

function normalizeGeneratedAt(value: string | Date): string {
  return typeof value === 'string' ? value : value.toISOString();
}

function createOpenItem(id: MergeReadyOpenItemId): MergeReadyOpenItem {
  return {
    id,
    summary: OPEN_ITEM_SUMMARY[id],
  };
}

function selectTopOpenItem(openItems: MergeReadyOpenItem[]): MergeReadyOpenItem | null {
  let topOpenItem: MergeReadyOpenItem | null = null;

  for (const openItem of openItems) {
    if (!topOpenItem || OPEN_ITEM_PRIORITY[openItem.id] < OPEN_ITEM_PRIORITY[topOpenItem.id]) {
      topOpenItem = openItem;
    }
  }

  return topOpenItem;
}
