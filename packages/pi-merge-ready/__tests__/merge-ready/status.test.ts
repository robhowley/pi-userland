import { describe, expect, it } from 'vitest';
import {
  createMergeReadyStatus,
  normalizeMergeReadySignals,
  selectMergeReadyBadgeId,
  type MergeReadyBadgeId,
  type MergeReadyOpenItemId,
  type MergeReadyPullRequest,
  type MergeReadySignals,
  type MergeReadySignalsInput,
  type MergeReadyState,
} from '../../extensions/merge-ready/index.js';

const GENERATED_AT = '2026-05-26T12:00:00.000Z';

const OPEN_PR: MergeReadyPullRequest = {
  number: 42,
  title: 'Normalize merge-ready status',
  url: 'https://example.com/pull/42',
};

const READY_SIGNALS: MergeReadySignalsInput = {
  draft: false,
  mergeability: 'mergeable',
  checks: 'passing',
  review: 'approved',
  unresolvedConversations: false,
};

function buildStatus(
  options: {
    pr?: MergeReadyPullRequest | null;
    signals?: MergeReadySignalsInput;
  } = {},
) {
  return createMergeReadyStatus({
    generatedAt: GENERATED_AT,
    pr: options.pr === undefined ? OPEN_PR : options.pr,
    signals: { ...READY_SIGNALS, ...options.signals },
  });
}

function openItemIds(status: ReturnType<typeof buildStatus>): MergeReadyOpenItemId[] {
  return status.openItems.map((openItem) => openItem.id);
}

type BadgeFixture = {
  name: string;
  status: ReturnType<typeof buildStatus>;
  badge: MergeReadyBadgeId;
  state: MergeReadyState;
  summary: string;
  openItemIds: MergeReadyOpenItemId[];
  signals: MergeReadySignals;
};

const badgeFixtures: BadgeFixture[] = [
  {
    name: 'status_ambiguous',
    status: buildStatus({ signals: { mergeability: 'unknown' } }),
    badge: 'unknown',
    state: 'unknown',
    summary: 'Merge readiness is ambiguous',
    openItemIds: ['status_ambiguous'],
    signals: {
      draft: false,
      mergeability: 'unknown',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: false,
    },
  },
  {
    name: 'merge_conflicts',
    status: buildStatus({ signals: { mergeability: 'conflicting' } }),
    badge: 'merge_conflicts',
    state: 'blocked',
    summary: 'Merge conflicts detected',
    openItemIds: ['merge_conflicts'],
    signals: {
      draft: false,
      mergeability: 'conflicting',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: false,
    },
  },
  {
    name: 'branch_out_of_date',
    status: buildStatus({ signals: { mergeability: 'behind' } }),
    badge: 'branch_out_of_date',
    state: 'blocked',
    summary: 'Branch is out of date with base',
    openItemIds: ['branch_out_of_date'],
    signals: {
      draft: false,
      mergeability: 'behind',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: false,
    },
  },
  {
    name: 'merge_blocked',
    status: buildStatus({ signals: { mergeability: 'blocked' } }),
    badge: 'merge_blocked',
    state: 'blocked',
    summary: 'GitHub reports merge is blocked',
    openItemIds: ['merge_blocked'],
    signals: {
      draft: false,
      mergeability: 'blocked',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: false,
    },
  },
  {
    name: 'draft',
    status: buildStatus({ signals: { draft: true } }),
    badge: 'draft',
    state: 'blocked',
    summary: 'Pull request is still a draft',
    openItemIds: ['draft'],
    signals: {
      draft: true,
      mergeability: 'mergeable',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: false,
    },
  },
  {
    name: 'ci_failing',
    status: buildStatus({ signals: { checks: 'failing' } }),
    badge: 'ci_failing',
    state: 'blocked',
    summary: 'Required checks are failing',
    openItemIds: ['ci_failing'],
    signals: {
      draft: false,
      mergeability: 'mergeable',
      checks: 'failing',
      review: 'approved',
      unresolvedConversations: false,
    },
  },
  {
    name: 'changes_requested',
    status: buildStatus({ signals: { review: 'changes_requested' } }),
    badge: 'changes_requested',
    state: 'blocked',
    summary: 'Changes requested by reviewers',
    openItemIds: ['changes_requested'],
    signals: {
      draft: false,
      mergeability: 'mergeable',
      checks: 'passing',
      review: 'changes_requested',
      unresolvedConversations: false,
    },
  },
  {
    name: 'unresolved_conversations',
    status: buildStatus({ signals: { unresolvedConversations: true } }),
    badge: 'unresolved_conversations',
    state: 'blocked',
    summary: 'Unresolved review conversations remain',
    openItemIds: ['unresolved_conversations'],
    signals: {
      draft: false,
      mergeability: 'mergeable',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: true,
    },
  },
  {
    name: 'ci_running',
    status: buildStatus({ signals: { checks: 'running' } }),
    badge: 'ci_running',
    state: 'pending',
    summary: 'Checks are still running',
    openItemIds: ['ci_running'],
    signals: {
      draft: false,
      mergeability: 'mergeable',
      checks: 'running',
      review: 'approved',
      unresolvedConversations: false,
    },
  },
  {
    name: 'review_pending',
    status: buildStatus({ signals: { review: 'pending' } }),
    badge: 'review_pending',
    state: 'pending',
    summary: 'Waiting for review',
    openItemIds: ['review_pending'],
    signals: {
      draft: false,
      mergeability: 'mergeable',
      checks: 'passing',
      review: 'pending',
      unresolvedConversations: false,
    },
  },
  {
    name: 'ready',
    status: buildStatus(),
    badge: 'ready',
    state: 'ready',
    summary: 'Ready to merge',
    openItemIds: [],
    signals: {
      draft: false,
      mergeability: 'mergeable',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: false,
    },
  },
  {
    name: 'unknown_no_pr',
    status: buildStatus({ pr: null }),
    badge: 'unknown',
    state: 'unknown',
    summary: 'No pull request found',
    openItemIds: ['no_pull_request'],
    signals: {
      draft: false,
      mergeability: 'unknown',
      checks: 'unknown',
      review: 'unknown',
      unresolvedConversations: false,
    },
  },
];

describe('merge-ready status', () => {
  it.each(badgeFixtures)(
    'maps $name into expected state, summary, openItems, and signals',
    (fixture) => {
      expect(fixture.status.state).toBe(fixture.state);
      expect(fixture.status.summary).toBe(fixture.summary);
      expect(openItemIds(fixture.status)).toEqual(fixture.openItemIds);
      expect(fixture.status.signals).toEqual(fixture.signals);
    },
  );

  it.each(badgeFixtures)('selects $name badge "$badge"', (fixture) => {
    expect(selectMergeReadyBadgeId(fixture.status)).toBe(fixture.badge);
  });

  it('includes merge blockers even when other blockers are present', () => {
    const status = buildStatus({
      signals: {
        mergeability: 'conflicting',
        checks: 'failing',
        unresolvedConversations: true,
      },
    });

    expect(openItemIds(status)).toEqual([
      'merge_conflicts',
      'ci_failing',
      'unresolved_conversations',
    ]);
  });

  it('includes unresolved conversation count when it is known', () => {
    const status = buildStatus({
      signals: {
        unresolvedConversationCount: 2,
      },
    });

    expect(status.state).toBe('blocked');
    expect(status.summary).toBe('2 unresolved review conversations remain');
    expect(status.openItems).toEqual([
      {
        id: 'unresolved_conversations',
        summary: '2 unresolved review conversations remain',
      },
    ]);
    expect(status.signals.unresolvedConversations).toBe(true);
    expect(status.signals.unresolvedConversationCount).toBe(2);
  });
});

describe('normalizeMergeReadySignals', () => {
  it('returns unknown signals when no PR', () => {
    const signals = normalizeMergeReadySignals({}, false);
    expect(signals).toEqual({
      draft: false,
      mergeability: 'unknown',
      checks: 'unknown',
      review: 'unknown',
      unresolvedConversations: false,
    });
  });

  it('returns provided signals when PR exists', () => {
    const signals = normalizeMergeReadySignals(
      {
        draft: true,
        mergeability: 'behind',
        checks: 'failing',
        review: 'changes_requested',
        unresolvedConversations: true,
        unresolvedConversationCount: 2,
      },
      true,
    );
    expect(signals).toEqual({
      draft: true,
      mergeability: 'behind',
      checks: 'failing',
      review: 'changes_requested',
      unresolvedConversations: true,
      unresolvedConversationCount: 2,
    });
  });

  it('uses defaults when PR exists but signals not provided', () => {
    const signals = normalizeMergeReadySignals({}, true);
    expect(signals).toEqual({
      draft: false,
      mergeability: 'unknown',
      checks: 'unknown',
      review: 'unknown',
      unresolvedConversations: false,
    });
  });
});
