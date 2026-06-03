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
  unresolvedConversationRequirement: 'optional',
};

function buildStatus(
  options: {
    pr?: MergeReadyPullRequest | null;
    hasPr?: boolean;
    forceStatusAmbiguous?: boolean;
    signals?: MergeReadySignalsInput;
  } = {},
) {
  return createMergeReadyStatus({
    generatedAt: GENERATED_AT,
    pr: options.pr === undefined ? OPEN_PR : options.pr,
    ...(options.hasPr === undefined ? {} : { hasPr: options.hasPr }),
    ...(options.forceStatusAmbiguous === undefined
      ? {}
      : { forceStatusAmbiguous: options.forceStatusAmbiguous }),
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
      unresolvedConversationRequirement: 'optional',
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
      unresolvedConversationRequirement: 'optional',
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
      unresolvedConversationRequirement: 'optional',
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
      unresolvedConversationRequirement: 'optional',
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
      unresolvedConversationRequirement: 'optional',
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
      unresolvedConversationRequirement: 'optional',
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
      unresolvedConversationRequirement: 'optional',
    },
  },
  {
    name: 'unresolved_conversations (required)',
    status: buildStatus({
      signals: { unresolvedConversations: true, unresolvedConversationRequirement: 'required' },
    }),
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
      unresolvedConversationRequirement: 'required',
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
      unresolvedConversationRequirement: 'optional',
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
      unresolvedConversationRequirement: 'optional',
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
      unresolvedConversationRequirement: 'optional',
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
      unresolvedConversationRequirement: 'unknown',
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
        unresolvedConversationRequirement: 'required',
      },
    });

    expect(openItemIds(status)).toEqual([
      'merge_conflicts',
      'ci_failing',
      'unresolved_conversations',
    ]);
  });

  it('includes unresolved conversation count when it is known and required', () => {
    const status = buildStatus({
      signals: {
        unresolvedConversationCount: 2,
        unresolvedConversationRequirement: 'required',
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

  it('does not block when unresolved conversations are optional', () => {
    const status = buildStatus({
      signals: {
        unresolvedConversations: true,
        unresolvedConversationCount: 3,
        unresolvedConversationRequirement: 'optional',
      },
    });

    expect(status.state).toBe('ready');
    expect(status.summary).toBe('Ready to merge');
    expect(openItemIds(status)).toEqual([]);
    // Signals still reflect the unresolved count for informational purposes
    expect(status.signals.unresolvedConversations).toBe(true);
    expect(status.signals.unresolvedConversationCount).toBe(3);
    expect(status.signals.unresolvedConversationRequirement).toBe('optional');
  });

  it('emits status_ambiguous when unresolved conversations requirement is unknown', () => {
    const status = buildStatus({
      signals: {
        unresolvedConversations: true,
        unresolvedConversationCount: 1,
        unresolvedConversationRequirement: 'unknown',
      },
    });

    expect(status.state).toBe('unknown');
    expect(status.summary).toBe('Merge readiness is ambiguous');
    expect(openItemIds(status)).toEqual(['status_ambiguous']);
    // Signals still reflect the unresolved count
    expect(status.signals.unresolvedConversations).toBe(true);
    expect(status.signals.unresolvedConversationCount).toBe(1);
    expect(status.signals.unresolvedConversationRequirement).toBe('unknown');
  });

  it('suppresses generic merge_blocked when required unresolved conversations explain the block', () => {
    const status = buildStatus({
      signals: {
        mergeability: 'blocked',
        unresolvedConversations: true,
        unresolvedConversationCount: 2,
        unresolvedConversationRequirement: 'required',
      },
    });

    // Should show specific unresolved_conversations blocker, not generic merge_blocked
    expect(openItemIds(status)).toEqual(['unresolved_conversations']);
    expect(status.state).toBe('blocked');
    expect(status.summary).toBe('2 unresolved review conversations remain');
  });

  it('shows merge_blocked when unresolved conversations are optional', () => {
    const status = buildStatus({
      signals: {
        mergeability: 'blocked',
        unresolvedConversations: true,
        unresolvedConversationCount: 2,
        unresolvedConversationRequirement: 'optional',
      },
    });

    // merge_blocked should show when conversations are optional (not causing the block)
    expect(openItemIds(status)).toEqual(['merge_blocked']);
    expect(status.state).toBe('blocked');
    expect(status.summary).toBe('GitHub reports merge is blocked');
  });

  it.each<{
    name: string;
    signals: MergeReadySignalsInput;
    expectedOpenItemIds: MergeReadyOpenItemId[];
  }>([
    {
      name: 'draft state',
      signals: { mergeability: 'blocked', draft: true },
      expectedOpenItemIds: ['draft'],
    },
    {
      name: 'changes requested',
      signals: { mergeability: 'blocked', review: 'changes_requested' },
      expectedOpenItemIds: ['changes_requested'],
    },
    {
      name: 'running checks',
      signals: { mergeability: 'blocked', checks: 'running' },
      expectedOpenItemIds: ['ci_running'],
    },
    {
      name: 'pending review',
      signals: { mergeability: 'blocked', review: 'pending' },
      expectedOpenItemIds: ['review_pending'],
    },
  ])('suppresses generic merge_blocked when $name explain the block', (fixture) => {
    const status = buildStatus({ signals: fixture.signals });

    expect(openItemIds(status)).toEqual(fixture.expectedOpenItemIds);
    expect(status.openItems.some((openItem) => openItem.id === 'merge_blocked')).toBe(false);
  });

  it('suppresses generic merge_blocked when failing checks explain the block', () => {
    const status = buildStatus({
      signals: {
        mergeability: 'blocked',
        checks: 'failing',
        checkDetails: {
          failing: [{ label: 'linting', status: 'failing' }],
          running: [],
          unknown: [],
        },
      },
    });

    expect(openItemIds(status)).toEqual(['ci_failing']);
    expect(status.state).toBe('blocked');
    expect(status.summary).toBe('Required checks are failing');
    expect(status.openItems).toEqual([
      {
        id: 'ci_failing',
        summary: 'Required checks are failing',
        details: [{ label: 'linting', status: 'failing' }],
      },
    ]);
  });

  it('keeps merge_blocked when no specific blocker explains GitHub blocked state', () => {
    const status = buildStatus({ signals: { mergeability: 'blocked' } });

    expect(openItemIds(status)).toEqual(['merge_blocked']);
    expect(status.state).toBe('blocked');
    expect(status.summary).toBe('GitHub reports merge is blocked');
  });

  it('treats passing checks as authoritative over non-green detail rows', () => {
    const status = buildStatus({
      signals: {
        mergeability: 'blocked',
        checks: 'passing',
        checkDetails: {
          failing: [{ label: 'linting', status: 'failing' }],
          running: [{ label: 'tests', status: 'running' }],
          unknown: [{ label: 'mystery', status: 'unknown' }],
        },
      },
    });

    expect(status.signals.checkDetails).toBeUndefined();
    expect(openItemIds(status)).toEqual(['merge_blocked']);
  });

  it('attaches running check details without promoting green rows', () => {
    const status = buildStatus({
      signals: {
        checks: 'running',
        checkDetails: {
          failing: [],
          running: [
            {
              label: 'tests',
              status: 'running',
              url: 'https://github.example/checks/tests',
            },
          ],
          unknown: [],
        },
      },
    });

    expect(openItemIds(status)).toEqual(['ci_running']);
    expect(status.openItems).toEqual([
      {
        id: 'ci_running',
        summary: 'Checks are still running',
        details: [
          {
            label: 'tests',
            status: 'running',
            url: 'https://github.example/checks/tests',
          },
        ],
      },
    ]);
  });

  it('surfaces unknown check rows through status_ambiguous details', () => {
    const status = buildStatus({
      signals: {
        checks: 'unknown',
        checkDetails: {
          failing: [],
          running: [],
          unknown: [{ label: 'mystery check', status: 'unknown' }],
        },
      },
    });

    expect(openItemIds(status)).toEqual(['status_ambiguous']);
    expect(status.state).toBe('unknown');
    expect(status.openItems).toEqual([
      {
        id: 'status_ambiguous',
        summary: 'Merge readiness is ambiguous',
        details: [{ label: 'mystery check', status: 'unknown' }],
      },
    ]);
  });

  it('does not duplicate status_ambiguous when mergeability is unknown and conversations requirement is unknown', () => {
    const status = buildStatus({
      signals: {
        mergeability: 'unknown',
        unresolvedConversations: true,
        unresolvedConversationCount: 1,
        unresolvedConversationRequirement: 'unknown',
      },
    });

    // Should have exactly one status_ambiguous, not two
    expect(openItemIds(status)).toEqual(['status_ambiguous']);
    expect(status.state).toBe('unknown');
  });

  it('can force status_ambiguous for partial discovery without mutating known signals', () => {
    const status = buildStatus({ forceStatusAmbiguous: true });

    expect(status.state).toBe('unknown');
    expect(status.summary).toBe('Merge readiness is ambiguous');
    expect(openItemIds(status)).toEqual(['status_ambiguous']);
    expect(status.signals).toEqual({
      draft: false,
      mergeability: 'mergeable',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: false,
      unresolvedConversationRequirement: 'optional',
    });
  });

  it('can represent ambiguous PR discovery without degrading to no_pull_request', () => {
    const status = createMergeReadyStatus({
      generatedAt: GENERATED_AT,
      pr: null,
      hasPr: true,
      forceStatusAmbiguous: true,
    });

    expect(status.state).toBe('unknown');
    expect(status.pr).toBeNull();
    expect(status.summary).toBe('Merge readiness is ambiguous');
    expect(openItemIds(status)).toEqual(['status_ambiguous']);
    expect(status.signals).toEqual({
      draft: false,
      mergeability: 'unknown',
      checks: 'unknown',
      review: 'unknown',
      unresolvedConversations: false,
      unresolvedConversationRequirement: 'unknown',
    });
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
      unresolvedConversationRequirement: 'unknown',
    });
  });

  it('returns provided signals when PR exists', () => {
    const signals = normalizeMergeReadySignals(
      {
        draft: true,
        mergeability: 'behind',
        checks: 'failing',
        checkDetails: {
          failing: [
            { label: ' linting ', status: 'failing', url: ' https://github.example/lint ' },
          ],
          running: [],
          unknown: [],
        },
        review: 'changes_requested',
        unresolvedConversations: true,
        unresolvedConversationCount: 2,
        unresolvedConversationRequirement: 'required',
      },
      true,
    );
    expect(signals).toEqual({
      draft: true,
      mergeability: 'behind',
      checks: 'failing',
      checkDetails: {
        failing: [{ label: 'linting', status: 'failing', url: 'https://github.example/lint' }],
        running: [],
        unknown: [],
      },
      review: 'changes_requested',
      unresolvedConversations: true,
      unresolvedConversationCount: 2,
      unresolvedConversationRequirement: 'required',
    });
  });

  it('keeps only the detail bucket implied by checks', () => {
    const signals = normalizeMergeReadySignals(
      {
        checks: 'running',
        checkDetails: {
          failing: [{ label: 'linting', status: 'failing' }],
          running: [{ label: ' tests ', status: 'running' }],
          unknown: [{ label: 'mystery', status: 'unknown' }],
        },
      },
      true,
    );

    expect(signals.checkDetails).toEqual({
      failing: [],
      running: [{ label: 'tests', status: 'running' }],
      unknown: [],
    });
  });

  it('drops all check details when checks are passing', () => {
    const signals = normalizeMergeReadySignals(
      {
        checks: 'passing',
        checkDetails: {
          failing: [{ label: 'linting', status: 'failing' }],
          running: [{ label: 'tests', status: 'running' }],
          unknown: [{ label: 'mystery', status: 'unknown' }],
        },
      },
      true,
    );

    expect(signals.checkDetails).toBeUndefined();
  });

  it('tolerates partial and malformed runtime checkDetails', () => {
    const signals = normalizeMergeReadySignals(
      {
        checks: 'failing',
        checkDetails: {
          failing: [
            null,
            { label: '   ' },
            { label: ' linting ' },
            { label: 'tests', url: ' https://github.example/checks/tests ' },
            { label: 'mystery', url: 42 },
          ],
        },
      } as unknown as MergeReadySignalsInput,
      true,
    );

    expect(signals.checkDetails).toEqual({
      failing: [
        { label: 'linting', status: 'failing' },
        {
          label: 'tests',
          status: 'failing',
          url: 'https://github.example/checks/tests',
        },
        { label: 'mystery', status: 'failing' },
      ],
      running: [],
      unknown: [],
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
      unresolvedConversationRequirement: 'unknown',
    });
  });
});
