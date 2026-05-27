import type {
  CreateMergeReadyStatusOptions,
  MergeReadyBadgeContext,
  MergeReadyBadgeId,
  MergeReadyBooleanSignal,
  MergeReadyOpenItem,
  MergeReadyOpenItemActionability,
  MergeReadyOpenItemId,
  MergeReadyOpenItemOwner,
  MergeReadyPresence,
  MergeReadyPullRequest,
  MergeReadySignals,
  MergeReadySignalsInput,
  MergeReadyState,
  MergeReadyStatus,
} from './types.js';

const OPEN_ITEM_PRIORITY = {
  no_pull_request: 0,
  status_ambiguous: 1,
  draft: 2,
  ci_failing: 3,
  changes_requested: 4,
  unresolved_conversations: 5,
  ci_running: 6,
  review_pending: 7,
} as const satisfies Record<MergeReadyOpenItemId, number>;

const OPEN_ITEM_STATE = {
  no_pull_request: 'unknown',
  status_ambiguous: 'unknown',
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
  draft: 'draft',
  ci_failing: 'ci_failing',
  changes_requested: 'changes_requested',
  unresolved_conversations: 'unresolved_conversations',
  ci_running: 'ci_running',
  review_pending: 'review_pending',
} as const satisfies Record<MergeReadyOpenItemId, MergeReadyBadgeId>;

const OPEN_ITEM_OWNER = {
  no_pull_request: 'user',
  status_ambiguous: 'github',
  draft: 'user',
  ci_failing: 'agent',
  changes_requested: 'agent',
  unresolved_conversations: 'agent',
  ci_running: 'ci',
  review_pending: 'reviewer',
} as const satisfies Record<MergeReadyOpenItemId, MergeReadyOpenItemOwner>;

const OPEN_ITEM_ACTIONABILITY = {
  no_pull_request: 'actionable',
  status_ambiguous: 'actionable',
  draft: 'actionable',
  ci_failing: 'actionable',
  changes_requested: 'actionable',
  unresolved_conversations: 'actionable',
  ci_running: 'waiting',
  review_pending: 'waiting',
} as const satisfies Record<MergeReadyOpenItemId, MergeReadyOpenItemActionability>;

const OPEN_ITEM_SUMMARY = {
  no_pull_request: 'No pull request found',
  status_ambiguous: 'Merge readiness is ambiguous',
  draft: 'Pull request is still a draft',
  ci_failing: 'Required checks are failing',
  changes_requested: 'Changes requested by reviewers',
  unresolved_conversations: 'Unresolved review conversations remain',
  ci_running: 'Checks are still running',
  review_pending: 'Waiting for review',
} as const satisfies Record<MergeReadyOpenItemId, string>;

export function normalizeMergeReadySignals(
  input: MergeReadySignalsInput = {},
  pr: MergeReadyPullRequest | null = null,
): MergeReadySignals {
  const pullRequest = pr ? 'present' : normalizePresence(input.pullRequest);
  const draft = normalizeBooleanSignal(input.draft);
  const checks = input.checks ?? 'unknown';
  const review = input.review ?? 'unknown';
  const unresolvedConversations = normalizeBooleanSignal(input.unresolvedConversations);

  if (pr?.lifecycle === 'merged' || pr?.lifecycle === 'closed') {
    return {
      discovery: 'complete',
      pullRequest: 'present',
      draft: 'no',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: 'no',
    };
  }

  if (pullRequest === 'missing') {
    return {
      discovery: 'complete',
      pullRequest: 'missing',
      draft: 'unknown',
      checks: 'unknown',
      review: 'unknown',
      unresolvedConversations: 'unknown',
    };
  }

  if (input.discovery === 'ambiguous' || pullRequest !== 'present') {
    return {
      discovery: 'ambiguous',
      pullRequest,
      draft: 'unknown',
      checks: 'unknown',
      review: 'unknown',
      unresolvedConversations: 'unknown',
    };
  }

  if (
    draft === 'unknown' ||
    checks === 'unknown' ||
    review === 'unknown' ||
    unresolvedConversations === 'unknown'
  ) {
    return {
      discovery: 'ambiguous',
      pullRequest: 'present',
      draft: 'unknown',
      checks: 'unknown',
      review: 'unknown',
      unresolvedConversations: 'unknown',
    };
  }

  return {
    discovery: 'complete',
    pullRequest: 'present',
    draft,
    checks,
    review,
    unresolvedConversations,
  };
}

export function deriveMergeReadyOpenItems(signals: MergeReadySignals): MergeReadyOpenItem[] {
  const openItems: MergeReadyOpenItem[] = [];

  if (signals.pullRequest === 'missing') {
    openItems.push(createOpenItem('no_pull_request'));
  }

  if (signals.discovery === 'ambiguous' || signals.pullRequest === 'unknown') {
    openItems.push(createOpenItem('status_ambiguous'));
  }

  if (signals.draft === 'yes') {
    openItems.push(createOpenItem('draft'));
  }

  if (signals.checks === 'failing') {
    openItems.push(createOpenItem('ci_failing'));
  }

  if (signals.review === 'changes_requested') {
    openItems.push(createOpenItem('changes_requested'));
  }

  if (signals.unresolvedConversations === 'yes') {
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
  if (context.pr?.lifecycle === 'merged') {
    return 'Pull request merged';
  }

  if (context.pr?.lifecycle === 'closed') {
    return 'Pull request closed';
  }

  const topOpenItem = selectTopOpenItem(context.openItems);
  if (topOpenItem) {
    return topOpenItem.summary;
  }

  if (context.pr?.lifecycle === 'open') {
    return 'Ready to merge';
  }

  return 'Merge readiness is ambiguous';
}

export function selectMergeReadyBadgeId(context: MergeReadyBadgeContext): MergeReadyBadgeId {
  if (context.pr?.lifecycle === 'merged') {
    return 'merged';
  }

  if (context.pr?.lifecycle === 'closed') {
    return 'closed';
  }

  const topOpenItem = selectTopOpenItem(context.openItems);
  if (topOpenItem) {
    return OPEN_ITEM_BADGE[topOpenItem.id];
  }

  if (context.pr?.lifecycle === 'open') {
    return 'ready';
  }

  return 'unknown';
}

export function createMergeReadyStatus(options: CreateMergeReadyStatusOptions): MergeReadyStatus {
  const pr = options.pr ?? null;
  const signals = normalizeMergeReadySignals(options.signals, pr);
  const openItems = deriveMergeReadyOpenItems(signals);

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

function normalizePresence(value: boolean | MergeReadyPresence | undefined): MergeReadyPresence {
  if (value === true) {
    return 'present';
  }

  if (value === false) {
    return 'missing';
  }

  return value ?? 'unknown';
}

function normalizeBooleanSignal(
  value: boolean | MergeReadyBooleanSignal | undefined,
): MergeReadyBooleanSignal {
  if (value === true) {
    return 'yes';
  }

  if (value === false) {
    return 'no';
  }

  return value ?? 'unknown';
}

function createOpenItem(id: MergeReadyOpenItemId): MergeReadyOpenItem {
  return {
    id,
    owner: OPEN_ITEM_OWNER[id],
    actionability: OPEN_ITEM_ACTIONABILITY[id],
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
