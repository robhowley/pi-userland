import type {
  CreateMergeReadyStatusOptions,
  MergeReadyBadgeContext,
  MergeReadyBadgeId,
  MergeReadyCheckDetail,
  MergeReadyCheckDetails,
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
  const checkDetails = normalizeCheckDetails(input.checkDetails, checks);
  const review = input.review ?? 'unknown';
  const unresolvedConversationRequirement = input.unresolvedConversationRequirement ?? 'unknown';
  const unresolvedConversationCount = normalizeUnresolvedConversationCount(
    input.unresolvedConversationCount,
  );
  const unresolvedConversations =
    unresolvedConversationCount !== undefined
      ? unresolvedConversationCount > 0
      : (input.unresolvedConversations ?? false);

  if (!hasPr) {
    return {
      draft: false,
      mergeability: 'unknown',
      checks: 'unknown',
      review: 'unknown',
      unresolvedConversations: false,
      unresolvedConversationRequirement: 'unknown',
    };
  }

  return {
    draft,
    mergeability,
    checks,
    ...(checkDetails ? { checkDetails } : {}),
    review,
    unresolvedConversations,
    unresolvedConversationRequirement,
    ...(unresolvedConversationCount !== undefined && unresolvedConversationCount > 0
      ? { unresolvedConversationCount }
      : {}),
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
    openItems.push(createOpenItem('status_ambiguous', signals));
  }

  if (signals.mergeability === 'conflicting') {
    openItems.push(createOpenItem('merge_conflicts'));
  }

  if (signals.mergeability === 'behind') {
    openItems.push(createOpenItem('branch_out_of_date'));
  }

  if (signals.draft) {
    openItems.push(createOpenItem('draft'));
  }

  if (signals.checks === 'failing') {
    openItems.push(createOpenItem('ci_failing', signals));
  }

  if (signals.review === 'changes_requested') {
    openItems.push(createOpenItem('changes_requested'));
  }

  // unresolved conversations:
  // - required + count > 0 => blocker
  // - optional + count > 0 => not a blocker (just informational in signals)
  // - unknown + count > 0 => ambiguous (emit status_ambiguous, avoid false-ready)
  if (signals.unresolvedConversations) {
    if (signals.unresolvedConversationRequirement === 'required') {
      openItems.push(createOpenItem('unresolved_conversations', signals));
    } else if (signals.unresolvedConversationRequirement === 'unknown') {
      // Avoid false-ready: surface ambiguity when we can't determine if resolution is required.
      // Only add status_ambiguous if not already present from mergeability unknown.
      if (!openItems.some((item) => item.id === 'status_ambiguous')) {
        openItems.push(createOpenItem('status_ambiguous', signals));
      }
    }
    // requirement === 'optional' with count > 0 => no blocker emitted
  }

  if (signals.checks === 'running') {
    openItems.push(createOpenItem('ci_running', signals));
  }

  if (signals.checks === 'unknown' && !openItems.some((item) => item.id === 'status_ambiguous')) {
    openItems.push(createOpenItem('status_ambiguous', signals));
  }

  if (signals.review === 'pending') {
    openItems.push(createOpenItem('review_pending'));
  }

  // Suppress generic merge_blocked when a concrete open item explains the block.
  // GitHub's aggregate blocked state is often a symptom of draft state, checks,
  // reviews, or required conversation resolution. Keep merge_blocked only for
  // hook/ruleset/server-side blockers that no specific open item explains.
  if (signals.mergeability === 'blocked' && !openItems.some(openItemExplainsBlockedMergeability)) {
    openItems.push(createOpenItem('merge_blocked', signals));
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
  const hasPr = options.hasPr ?? pr !== null;
  const signals = normalizeMergeReadySignals(options.signals, hasPr);
  let openItems = deriveMergeReadyOpenItems(signals, hasPr);

  if (
    options.forceStatusAmbiguous &&
    hasPr &&
    !openItems.some((openItem) => openItem.id === 'status_ambiguous')
  ) {
    openItems = [...openItems, createOpenItem('status_ambiguous', signals)].sort(
      (left, right) => OPEN_ITEM_PRIORITY[left.id] - OPEN_ITEM_PRIORITY[right.id],
    );
  }

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

function normalizeCheckDetails(
  value: unknown,
  checks: MergeReadySignals['checks'],
): MergeReadyCheckDetails | undefined {
  if (checks === 'passing') {
    return undefined;
  }

  const checkDetails: MergeReadyCheckDetails = {
    failing:
      checks === 'failing'
        ? normalizeCheckDetailList(readCheckDetailBucket(value, 'failing'), 'failing')
        : [],
    running:
      checks === 'running'
        ? normalizeCheckDetailList(readCheckDetailBucket(value, 'running'), 'running')
        : [],
    unknown:
      checks === 'unknown'
        ? normalizeCheckDetailList(readCheckDetailBucket(value, 'unknown'), 'unknown')
        : [],
  };

  if (
    checkDetails.failing.length === 0 &&
    checkDetails.running.length === 0 &&
    checkDetails.unknown.length === 0
  ) {
    return undefined;
  }

  return checkDetails;
}

function readCheckDetailBucket(value: unknown, bucket: MergeReadyCheckDetail['status']): unknown {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  return (value as Partial<Record<MergeReadyCheckDetail['status'], unknown>>)[bucket];
}

function normalizeCheckDetailList(
  details: unknown,
  status: MergeReadyCheckDetail['status'],
): MergeReadyCheckDetail[] {
  if (!Array.isArray(details)) {
    return [];
  }

  return details.flatMap((detail) => normalizeCheckDetail(detail, status));
}

function normalizeCheckDetail(
  detail: unknown,
  status: MergeReadyCheckDetail['status'],
): MergeReadyCheckDetail[] {
  if (!detail || typeof detail !== 'object') {
    return [];
  }

  const candidate = detail as Partial<Record<'label' | 'url', unknown>>;
  const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
  if (!label) {
    return [];
  }

  const url = typeof candidate.url === 'string' ? candidate.url.trim() : '';

  return [
    {
      label,
      status,
      ...(url ? { url } : {}),
    },
  ];
}

function createOpenItem(id: MergeReadyOpenItemId, signals?: MergeReadySignals): MergeReadyOpenItem {
  const details = getOpenItemDetails(id, signals);

  return {
    id,
    summary: createOpenItemSummary(id, signals),
    ...(details.length > 0 ? { details } : {}),
  };
}

function getOpenItemDetails(
  id: MergeReadyOpenItemId,
  signals: MergeReadySignals | undefined,
): MergeReadyCheckDetail[] {
  if (!signals?.checkDetails) {
    return [];
  }

  if (id === 'ci_failing') {
    return signals.checkDetails.failing;
  }

  if (id === 'ci_running') {
    return signals.checkDetails.running;
  }

  if (id === 'status_ambiguous') {
    return signals.checkDetails.unknown;
  }

  return [];
}

function createOpenItemSummary(
  id: MergeReadyOpenItemId,
  signals: MergeReadySignals | undefined,
): string {
  if (id === 'unresolved_conversations' && signals?.unresolvedConversationCount !== undefined) {
    const count = signals.unresolvedConversationCount;
    const noun = count === 1 ? 'conversation' : 'conversations';
    const verb = count === 1 ? 'remains' : 'remain';
    return `${String(count)} unresolved review ${noun} ${verb}`;
  }

  return OPEN_ITEM_SUMMARY[id];
}

function normalizeUnresolvedConversationCount(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return Math.floor(value);
}

function openItemExplainsBlockedMergeability(openItem: MergeReadyOpenItem): boolean {
  return (
    openItem.id === 'draft' ||
    openItem.id === 'ci_failing' ||
    openItem.id === 'changes_requested' ||
    openItem.id === 'unresolved_conversations' ||
    openItem.id === 'ci_running' ||
    openItem.id === 'review_pending'
  );
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
