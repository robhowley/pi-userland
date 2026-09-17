import { describe, expect, it, vi } from 'vitest';
import { normalizeProducerView } from '../../../pi-cmux-junction/extensions/cmux-junction/producer-view.js';
import {
  createMergeReadyJunctionUnknownUpdate,
  createMergeReadyJunctionUpdate,
  createMergeReadyJunctionWithdrawal,
  emitMergeReadyJunctionUpdate,
  MERGE_READY_JUNCTION_UPDATE_EVENT,
  type MergeReadyJunctionEventEmitter,
} from '../../extensions/merge-ready/junction.js';
import { renderMergeReadyStatusBar } from '../../extensions/merge-ready/status-bar.js';
import { createMergeReadyStatus } from '../../extensions/merge-ready/status.js';
import type {
  MergeReadyOpenItem,
  MergeReadyPullRequest,
  MergeReadySignalsInput,
  MergeReadyTarget,
} from '../../extensions/merge-ready/types.js';

const GENERATED_AT = '2026-08-28T00:00:00.000Z';

function createPullRequest(
  options: { url?: string; lifecycle?: MergeReadyPullRequest['lifecycle'] } = {},
) {
  return {
    lifecycle: options.lifecycle ?? 'open',
    number: 42,
    title: 'Publish merge-ready status',
    url: options.url ?? 'https://github.com/robhowley/pi-userland/pull/42',
    headRefName: 'feat/merge-ready',
    baseRefName: 'main',
  } satisfies MergeReadyPullRequest;
}

function createCurrentBranchStatus(
  options: {
    pr?: MergeReadyPullRequest | null;
    signals?: MergeReadySignalsInput;
    openItems?: MergeReadyOpenItem[];
  } = {},
) {
  return createMergeReadyStatus({
    generatedAt: GENERATED_AT,
    pr: options.pr === undefined ? createPullRequest() : options.pr,
    signals: options.signals ?? {
      mergeability: 'mergeable',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: false,
      unresolvedConversationRequirement: 'optional',
    },
    ...(options.openItems === undefined ? {} : { openItems: options.openItems }),
  });
}

function createUrlStatus(): ReturnType<typeof createMergeReadyStatus> {
  const target: MergeReadyTarget = {
    mode: 'url',
    url: 'https://github.com/robhowley/pi-userland/pull/42',
    owner: 'robhowley',
    repo: 'pi-userland',
    prNumber: 42,
  };

  return createMergeReadyStatus({
    generatedAt: GENERATED_AT,
    target,
    pr: createPullRequest(),
    signals: {
      mergeability: 'mergeable',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: false,
      unresolvedConversationRequirement: 'optional',
    },
  });
}

describe('merge-ready Junction producer', () => {
  it.each([
    {
      name: 'ready',
      status: createCurrentBranchStatus(),
    },
    {
      name: 'pending',
      status: createCurrentBranchStatus({
        signals: {
          mergeability: 'mergeable',
          checks: 'running',
          review: 'pending',
          unresolvedConversations: false,
          unresolvedConversationRequirement: 'optional',
        },
      }),
    },
    {
      name: 'blocked',
      status: createCurrentBranchStatus({
        signals: {
          mergeability: 'conflicting',
          checks: 'passing',
          review: 'approved',
          unresolvedConversations: false,
          unresolvedConversationRequirement: 'optional',
        },
      }),
    },
    {
      name: 'unknown',
      status: createCurrentBranchStatus({
        signals: {
          mergeability: 'unknown',
          checks: 'unknown',
          review: 'unknown',
          unresolvedConversations: false,
          unresolvedConversationRequirement: 'optional',
        },
      }),
    },
    {
      name: 'no PR',
      status: createCurrentBranchStatus({ pr: null }),
    },
    {
      name: 'merged',
      status: createCurrentBranchStatus({ pr: createPullRequest({ lifecycle: 'merged' }) }),
    },
    {
      name: 'closed',
      status: createCurrentBranchStatus({ pr: createPullRequest({ lifecycle: 'closed' }) }),
    },
  ])('creates a valid complete view for $name status', ({ status }) => {
    const update = createMergeReadyJunctionUpdate(status, renderMergeReadyStatusBar(status));

    expect(update).not.toBeNull();
    if (update === null) return;
    expect(normalizeProducerView(update).ok).toBe(true);
  });

  it('uses only openItems for the summary count', () => {
    const status = createCurrentBranchStatus({
      signals: {
        mergeability: 'mergeable',
        checks: 'passing',
        review: 'approved',
        unresolvedConversations: true,
        unresolvedConversationCount: 2,
        unresolvedConversationRequirement: 'optional',
      },
    });
    const update = createMergeReadyJunctionUpdate(status, renderMergeReadyStatusBar(status));

    expect(update?.items[0]?.summary).toBe('0 open items');
  });

  it('maps an accepted current-branch status to the shipped ProducerView shape', () => {
    const update = createMergeReadyJunctionUpdate(createCurrentBranchStatus(), '✅ #42 Ready');

    expect(update).toEqual({
      producer: { key: 'pi-merge-ready', label: 'Merge Ready' },
      items: [
        {
          key: 'current-branch',
          title: 'Current branch PR #42',
          status: '✅ #42 Ready',
          summary: '0 open items',
          href: 'https://github.com/robhowley/pi-userland/pull/42',
        },
      ],
    });
    expect(update === null ? null : normalizeProducerView(update).ok).toBe(true);
  });

  it('maps no PR without inventing a link', () => {
    const update = createMergeReadyJunctionUpdate(
      createCurrentBranchStatus({ pr: null }),
      '❔ No PR',
    );

    expect(update).toEqual({
      producer: { key: 'pi-merge-ready', label: 'Merge Ready' },
      items: [
        {
          key: 'current-branch',
          title: 'Current branch',
          status: '❔ No PR',
          summary: '1 open item',
        },
      ],
    });
  });

  it.each([
    'http://github.com/robhowley/pi-userland/pull/42',
    'https://user:password@github.com/robhowley/pi-userland/pull/42',
    'https://github.com/robhowley/pi-userland/pull/42 with-space',
  ])('omits an href that Junction would reject: %s', (url) => {
    const update = createMergeReadyJunctionUpdate(
      createCurrentBranchStatus({ pr: createPullRequest({ url }) }),
      '❌ #42 Checks failing',
    );

    expect(update?.items[0]).toEqual({
      key: 'current-branch',
      title: 'Current branch PR #42',
      status: '❌ #42 Checks failing',
      summary: '0 open items',
    });
    expect(update === null ? null : normalizeProducerView(update).ok).toBe(true);
  });

  it('does not publish a URL-targeted status', () => {
    expect(createMergeReadyJunctionUpdate(createUrlStatus(), '✅ #42 Ready')).toBeNull();
  });

  it('provides an unknown view for a failed ambient load', () => {
    const update = createMergeReadyJunctionUnknownUpdate('❔ Unknown');

    expect(update).toEqual({
      producer: { key: 'pi-merge-ready', label: 'Merge Ready' },
      items: [
        {
          key: 'current-branch',
          title: 'Current branch',
          status: '❔ Unknown',
          summary: 'Status unavailable',
        },
      ],
    });
  });

  it('withdraws the producer with an empty item list', () => {
    const update = createMergeReadyJunctionWithdrawal();

    expect(update).toEqual({
      producer: { key: 'pi-merge-ready', label: 'Merge Ready' },
      items: [],
    });
    expect(normalizeProducerView(update).ok).toBe(true);
  });

  it('treats the optional emitter as best effort', () => {
    const update = createMergeReadyJunctionUnknownUpdate('❔ Unknown');
    const throwingEmitter = {
      emit: vi.fn(() => {
        throw new Error('listener failed');
      }),
    };

    expect(() => emitMergeReadyJunctionUpdate(undefined, update)).not.toThrow();
    expect(() => emitMergeReadyJunctionUpdate(throwingEmitter, update)).not.toThrow();
    expect(throwingEmitter.emit).toHaveBeenCalledWith(MERGE_READY_JUNCTION_UPDATE_EVENT, update);

    const throwingEmitterProperty: MergeReadyJunctionEventEmitter = {
      get emit(): (channel: string, data: unknown) => void {
        throw new Error('event bus unavailable');
      },
    };
    expect(() => emitMergeReadyJunctionUpdate(throwingEmitterProperty, update)).not.toThrow();
  });
});
