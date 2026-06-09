import { describe, expect, it, vi } from 'vitest';
import {
  MERGE_READY_WATCH_STATUS_CUSTOM_TYPE,
  MERGE_READY_WATCH_STATUS_EVENT,
  createMergeReadyStatus,
  createMergeReadyWatchStatusRecord,
  publishMergeReadyWatchStatus,
} from '../../extensions/merge-ready/index.js';

const GENERATED_AT = '2026-06-08T12:00:00.000Z';
const URL = 'https://github.com/shopify/pi/pull/64';

function createUrlReadyStatus() {
  return createMergeReadyStatus({
    generatedAt: GENERATED_AT,
    target: {
      mode: 'url',
      url: URL,
      owner: 'shopify',
      repo: 'pi',
      prNumber: 64,
    },
    pr: {
      lifecycle: 'open',
      number: 64,
      title: 'Ship watch UI',
      url: URL,
      headRefName: 'feat/watch-ui',
      baseRefName: 'main',
      headRepository: {
        owner: 'shopify',
        repo: 'pi',
      },
    },
    signals: {
      draft: false,
      mergeability: 'mergeable',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: false,
      unresolvedConversationRequirement: 'optional',
    },
  });
}

describe('merge-ready watch status records', () => {
  it('builds a structured URL-targeted status record with canonical target identity', () => {
    const status = createUrlReadyStatus();

    expect(
      createMergeReadyWatchStatusRecord({
        lifecycle: 'watching',
        requestedUrl: URL,
        session: {
          sessionId: 'session-123',
          sessionFile: '/tmp/session.jsonl',
        },
        status,
        updatedAt: '2026-06-08T12:01:00.000Z',
      }),
    ).toEqual({
      schemaVersion: 1,
      lifecycle: 'watching',
      mergeReadyState: 'ready',
      summary: 'Ready to merge',
      updatedAt: '2026-06-08T12:01:00.000Z',
      generatedAt: GENERATED_AT,
      target: {
        mode: 'url',
        requestedUrl: URL,
        canonicalUrl: URL,
        repository: 'shopify/pi',
        pullRequestNumber: 64,
        pullRequestKey: 'shopify/pi#64',
      },
      session: {
        sessionId: 'session-123',
        sessionFile: '/tmp/session.jsonl',
      },
      pr: {
        lifecycle: 'open',
        number: 64,
        url: URL,
        title: 'Ship watch UI',
        headRefName: 'feat/watch-ui',
        baseRefName: 'main',
      },
    });
  });

  it('publishes the record to both custom entries and the live event bus', () => {
    const appendEntry = vi.fn();
    const emit = vi.fn();

    const status = createUrlReadyStatus();
    const published = publishMergeReadyWatchStatus({
      publisher: {
        appendEntry,
        events: { emit },
      },
      lifecycle: 'repairing',
      requestedUrl: URL,
      session: {
        sessionId: 'session-123',
        sessionFile: '/tmp/session.jsonl',
      },
      status,
      summary: 'ci_failing repair queued',
      updatedAt: '2026-06-08T12:02:00.000Z',
    });

    expect(appendEntry).toHaveBeenCalledWith(MERGE_READY_WATCH_STATUS_CUSTOM_TYPE, published);
    expect(emit).toHaveBeenCalledWith(MERGE_READY_WATCH_STATUS_EVENT, published);
    expect(published.lifecycle).toBe('repairing');
    expect(published.summary).toBe('ci_failing repair queued');
  });
});
