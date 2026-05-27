import { describe, expect, it } from 'vitest';
import {
  createMergeReadyStatus,
  normalizeMergeReadySignals,
  selectMergeReadyBadgeId,
  type MergeReadyBadgeId,
  type MergeReadyOpenItemActionability,
  type MergeReadyOpenItemId,
  type MergeReadyOpenItemOwner,
  type MergeReadyPullRequest,
  type MergeReadySignals,
  type MergeReadySignalsInput,
  type MergeReadyState,
} from '../../extensions/merge-ready/index.js';

const GENERATED_AT = '2026-05-26T12:00:00.000Z';

const OPEN_PR: MergeReadyPullRequest = {
  lifecycle: 'open',
  number: 42,
  title: 'Normalize merge-ready status',
  url: 'https://example.com/pull/42',
};

const READY_SIGNALS: MergeReadySignalsInput = {
  draft: false,
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
  owners: MergeReadyOpenItemOwner[];
  actionability: MergeReadyOpenItemActionability[];
  signals: MergeReadySignals;
};

type PriorityFixture = {
  name: string;
  status: ReturnType<typeof buildStatus>;
  badge: MergeReadyBadgeId;
  state: MergeReadyState;
  summary: string;
  openItemIds: MergeReadyOpenItemId[];
};

const badgeFixtures: BadgeFixture[] = [
  {
    name: 'draft',
    status: buildStatus({ signals: { draft: true } }),
    badge: 'draft',
    state: 'blocked',
    summary: 'Pull request is still a draft',
    openItemIds: ['draft'],
    owners: ['user'],
    actionability: ['actionable'],
    signals: {
      discovery: 'complete',
      pullRequest: 'present',
      draft: 'yes',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: 'no',
    },
  },
  {
    name: 'ci_failing',
    status: buildStatus({ signals: { checks: 'failing' } }),
    badge: 'ci_failing',
    state: 'blocked',
    summary: 'Required checks are failing',
    openItemIds: ['ci_failing'],
    owners: ['agent'],
    actionability: ['actionable'],
    signals: {
      discovery: 'complete',
      pullRequest: 'present',
      draft: 'no',
      checks: 'failing',
      review: 'approved',
      unresolvedConversations: 'no',
    },
  },
  {
    name: 'changes_requested',
    status: buildStatus({ signals: { review: 'changes_requested' } }),
    badge: 'changes_requested',
    state: 'blocked',
    summary: 'Changes requested by reviewers',
    openItemIds: ['changes_requested'],
    owners: ['agent'],
    actionability: ['actionable'],
    signals: {
      discovery: 'complete',
      pullRequest: 'present',
      draft: 'no',
      checks: 'passing',
      review: 'changes_requested',
      unresolvedConversations: 'no',
    },
  },
  {
    name: 'unresolved_conversations',
    status: buildStatus({ signals: { unresolvedConversations: true } }),
    badge: 'unresolved_conversations',
    state: 'blocked',
    summary: 'Unresolved review conversations remain',
    openItemIds: ['unresolved_conversations'],
    owners: ['agent'],
    actionability: ['actionable'],
    signals: {
      discovery: 'complete',
      pullRequest: 'present',
      draft: 'no',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: 'yes',
    },
  },
  {
    name: 'ci_running',
    status: buildStatus({ signals: { checks: 'running' } }),
    badge: 'ci_running',
    state: 'pending',
    summary: 'Checks are still running',
    openItemIds: ['ci_running'],
    owners: ['ci'],
    actionability: ['waiting'],
    signals: {
      discovery: 'complete',
      pullRequest: 'present',
      draft: 'no',
      checks: 'running',
      review: 'approved',
      unresolvedConversations: 'no',
    },
  },
  {
    name: 'review_pending',
    status: buildStatus({ signals: { review: 'pending' } }),
    badge: 'review_pending',
    state: 'pending',
    summary: 'Waiting for review',
    openItemIds: ['review_pending'],
    owners: ['reviewer'],
    actionability: ['waiting'],
    signals: {
      discovery: 'complete',
      pullRequest: 'present',
      draft: 'no',
      checks: 'passing',
      review: 'pending',
      unresolvedConversations: 'no',
    },
  },
  {
    name: 'ready',
    status: buildStatus(),
    badge: 'ready',
    state: 'ready',
    summary: 'Ready to merge',
    openItemIds: [],
    owners: [],
    actionability: [],
    signals: {
      discovery: 'complete',
      pullRequest: 'present',
      draft: 'no',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: 'no',
    },
  },
  {
    name: 'merged',
    status: buildStatus({
      pr: { ...OPEN_PR, lifecycle: 'merged' },
      signals: {
        draft: true,
        checks: 'failing',
        review: 'changes_requested',
        unresolvedConversations: true,
      },
    }),
    badge: 'merged',
    state: 'ready',
    summary: 'Pull request merged',
    openItemIds: [],
    owners: [],
    actionability: [],
    signals: {
      discovery: 'complete',
      pullRequest: 'present',
      draft: 'no',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: 'no',
    },
  },
  {
    name: 'closed',
    status: buildStatus({
      pr: { ...OPEN_PR, lifecycle: 'closed' },
      signals: {
        draft: true,
        checks: 'failing',
        review: 'changes_requested',
        unresolvedConversations: true,
      },
    }),
    badge: 'closed',
    state: 'ready',
    summary: 'Pull request closed',
    openItemIds: [],
    owners: [],
    actionability: [],
    signals: {
      discovery: 'complete',
      pullRequest: 'present',
      draft: 'no',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: 'no',
    },
  },
  {
    name: 'unknown',
    status: buildStatus({ pr: null, signals: { pullRequest: false } }),
    badge: 'unknown',
    state: 'unknown',
    summary: 'No pull request found',
    openItemIds: ['no_pull_request'],
    owners: ['user'],
    actionability: ['actionable'],
    signals: {
      discovery: 'complete',
      pullRequest: 'missing',
      draft: 'unknown',
      checks: 'unknown',
      review: 'unknown',
      unresolvedConversations: 'unknown',
    },
  },
];

const priorityFixtures: PriorityFixture[] = [
  {
    name: 'merged beats open blockers',
    status: buildStatus({
      pr: { ...OPEN_PR, lifecycle: 'merged' },
      signals: {
        draft: true,
        checks: 'failing',
        review: 'changes_requested',
        unresolvedConversations: true,
      },
    }),
    badge: 'merged',
    state: 'ready',
    summary: 'Pull request merged',
    openItemIds: [],
  },
  {
    name: 'closed beats open blockers',
    status: buildStatus({
      pr: { ...OPEN_PR, lifecycle: 'closed' },
      signals: {
        draft: true,
        checks: 'failing',
        review: 'changes_requested',
        unresolvedConversations: true,
      },
    }),
    badge: 'closed',
    state: 'ready',
    summary: 'Pull request closed',
    openItemIds: [],
  },
  {
    name: 'missing PR beats draft and checks',
    status: buildStatus({
      pr: null,
      signals: {
        pullRequest: false,
        draft: true,
        checks: 'failing',
        review: 'changes_requested',
        unresolvedConversations: true,
      },
    }),
    badge: 'unknown',
    state: 'unknown',
    summary: 'No pull request found',
    openItemIds: ['no_pull_request'],
  },
  {
    name: 'ambiguous discovery beats draft and checks',
    status: buildStatus({
      signals: {
        discovery: 'ambiguous',
        draft: true,
        checks: 'failing',
        review: 'changes_requested',
        unresolvedConversations: true,
      },
    }),
    badge: 'unknown',
    state: 'unknown',
    summary: 'Merge readiness is ambiguous',
    openItemIds: ['status_ambiguous'],
  },
  {
    name: 'draft beats failed checks',
    status: buildStatus({
      signals: {
        draft: true,
        checks: 'failing',
        review: 'changes_requested',
        unresolvedConversations: true,
      },
    }),
    badge: 'draft',
    state: 'blocked',
    summary: 'Pull request is still a draft',
    openItemIds: ['draft', 'ci_failing', 'changes_requested', 'unresolved_conversations'],
  },
  {
    name: 'failed checks beat changes requested',
    status: buildStatus({
      signals: {
        checks: 'failing',
        review: 'changes_requested',
        unresolvedConversations: true,
      },
    }),
    badge: 'ci_failing',
    state: 'blocked',
    summary: 'Required checks are failing',
    openItemIds: ['ci_failing', 'changes_requested', 'unresolved_conversations'],
  },
  {
    name: 'changes requested beat unresolved conversations',
    status: buildStatus({
      signals: {
        review: 'changes_requested',
        unresolvedConversations: true,
      },
    }),
    badge: 'changes_requested',
    state: 'blocked',
    summary: 'Changes requested by reviewers',
    openItemIds: ['changes_requested', 'unresolved_conversations'],
  },
  {
    name: 'unresolved conversations beat pending checks',
    status: buildStatus({
      signals: {
        checks: 'running',
        unresolvedConversations: true,
      },
    }),
    badge: 'unresolved_conversations',
    state: 'blocked',
    summary: 'Unresolved review conversations remain',
    openItemIds: ['unresolved_conversations', 'ci_running'],
  },
  {
    name: 'pending checks beat review pending',
    status: buildStatus({
      signals: {
        checks: 'running',
        review: 'pending',
      },
    }),
    badge: 'ci_running',
    state: 'pending',
    summary: 'Checks are still running',
    openItemIds: ['ci_running', 'review_pending'],
  },
  {
    name: 'review pending beats ready',
    status: buildStatus({
      signals: {
        review: 'pending',
      },
    }),
    badge: 'review_pending',
    state: 'pending',
    summary: 'Waiting for review',
    openItemIds: ['review_pending'],
  },
  {
    name: 'ready is used when nothing is open',
    status: buildStatus(),
    badge: 'ready',
    state: 'ready',
    summary: 'Ready to merge',
    openItemIds: [],
  },
];

describe('merge-ready status derivation', () => {
  it.each(badgeFixtures)('derives the $name badge row', (fixture) => {
    expect(fixture.status.generatedAt).toBe(GENERATED_AT);
    expect(fixture.status.state).toBe(fixture.state);
    expect(fixture.status.summary).toBe(fixture.summary);
    expect(fixture.status.signals).toEqual(fixture.signals);
    expect(openItemIds(fixture.status)).toEqual(fixture.openItemIds);
    expect(fixture.status.openItems.map((openItem) => openItem.owner)).toEqual(fixture.owners);
    expect(fixture.status.openItems.map((openItem) => openItem.actionability)).toEqual(
      fixture.actionability,
    );
    expect(selectMergeReadyBadgeId(fixture.status)).toBe(fixture.badge);
  });

  it.each(priorityFixtures)('applies priority order when $name', (fixture) => {
    expect(fixture.status.state).toBe(fixture.state);
    expect(fixture.status.summary).toBe(fixture.summary);
    expect(openItemIds(fixture.status)).toEqual(fixture.openItemIds);
    expect(selectMergeReadyBadgeId(fixture.status)).toBe(fixture.badge);
  });

  it('treats incomplete open PR facts as ambiguous instead of ready', () => {
    const signals = normalizeMergeReadySignals(
      {
        draft: false,
        checks: 'passing',
        review: 'approved',
      },
      OPEN_PR,
    );

    expect(signals).toEqual({
      discovery: 'ambiguous',
      pullRequest: 'present',
      draft: 'unknown',
      checks: 'unknown',
      review: 'unknown',
      unresolvedConversations: 'unknown',
    });

    const status = createMergeReadyStatus({
      generatedAt: GENERATED_AT,
      pr: OPEN_PR,
      signals: {
        draft: false,
        checks: 'passing',
        review: 'approved',
      },
    });

    expect(status.state).toBe('unknown');
    expect(status.summary).toBe('Merge readiness is ambiguous');
    expect(openItemIds(status)).toEqual(['status_ambiguous']);
    expect(selectMergeReadyBadgeId(status)).toBe('unknown');
  });
});
