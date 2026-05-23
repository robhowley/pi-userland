import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  BACKGROUND_REFRESH_INTERVAL_MS,
  fetchAndAggregate,
  getRefreshState,
  startBackgroundRefresh,
  stopBackgroundRefresh,
  usageCache,
} from '../cache.js';
import { getCredits, getActivity } from '../client.js';
import { readLocalUsage } from '../local-usage.js';
import type { LocalUsageEvent, UsageSummary } from '../types.js';
import type { ActivityItem } from '@openrouter/sdk/models/index.js';

// Mock dependencies
vi.mock('../client.js');
vi.mock('../local-usage.js', async () => {
  const actual = await vi.importActual<typeof import('../local-usage.js')>('../local-usage.js');
  return {
    ...actual,
    readLocalUsage: vi.fn(),
  };
});

const mockGetCredits = vi.mocked(getCredits);
const mockGetActivity = vi.mocked(getActivity);
const mockReadLocalUsage = vi.mocked(readLocalUsage);

const usageAggregateFields = [
  'requests',
  'promptTokens',
  'completionTokens',
  'reasoningTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'cost',
] as const;

describe('fetchAndAggregate - Phase 3: Local usage merge when Activity API absent/empty', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should include local cost when Activity API is null and local events exist today', async () => {
    // Setup: credits available, Activity API returns null, local events exist
    mockGetCredits.mockResolvedValue({
      totalUsage: 5.0,
      totalCredits: 10.0,
    });
    mockGetActivity.mockResolvedValue(null);

    const localEvents: LocalUsageEvent[] = [
      {
        id: 'local-1',
        generationId: 'gen-1',
        sessionId: 'session-1',
        completedAt: '2026-05-22T10:00:00Z',
        requests: 1,
        model: 'anthropic/claude-sonnet-4',
        provider: 'anthropic',
        cost: 0.05,
        promptTokens: 1000,
        completionTokens: 200,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ];
    mockReadLocalUsage.mockResolvedValue(localEvents);

    const summary = await fetchAndAggregate();

    expect(summary).toBeDefined();
    expect(summary!.hasActivityData).toBe(false);
    expect(summary!.local.cost).toBeGreaterThan(0);
    expect(summary!.local.cost).toBe(0.05);
    expect(summary!.combined.cost).toBe(0.05);
    expect(summary!.today).toBe(0.05);
    expect(summary!.topModels[0]).toMatchObject({
      name: 'anthropic/claude-sonnet-4',
      spend7d: 0.05,
      spend30d: 0.05,
      requests7d: 1,
      requests30d: 1,
    });
    expect(summary!.byProvider[0]).toMatchObject({
      name: 'anthropic',
      spend: 0.05,
      requests: 1,
    });
    expect(summary!.byDay['2026-05-22']).toBe(0.05);
    // Verify bounded read range: today - 29 days through today
    expect(mockReadLocalUsage).toHaveBeenCalledWith({
      fromDateUtc: '2026-04-23', // 29 days before 2026-05-22
      toDateUtc: '2026-05-22',
    });
  });

  it('should include local cost when Activity API returns empty array and local events exist', async () => {
    // Setup: credits available, Activity API returns empty array, local events exist
    mockGetCredits.mockResolvedValue({
      totalUsage: 5.0,
      totalCredits: 10.0,
    });
    mockGetActivity.mockResolvedValue([]);

    const localEvents: LocalUsageEvent[] = [
      {
        id: 'local-2',
        generationId: 'gen-2',
        sessionId: 'session-2',
        completedAt: '2026-05-22T11:00:00Z',
        requests: 1,
        model: 'openai/gpt-4',
        provider: 'openai',
        cost: 0.1,
        promptTokens: 2000,
        completionTokens: 400,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ];
    mockReadLocalUsage.mockResolvedValue(localEvents);

    const summary = await fetchAndAggregate();

    expect(summary).toBeDefined();
    expect(summary!.hasActivityData).toBe(true); // Activity was called but returned empty
    expect(summary!.local.cost).toBe(0.1);
    expect(summary!.combined.cost).toBe(0.1);
    expect(summary!.today).toBe(0.1);
    expect(summary!.topModels[0]).toMatchObject({
      name: 'openai/gpt-4',
      spend7d: 0.1,
      spend30d: 0.1,
      requests7d: 1,
      requests30d: 1,
    });
    expect(summary!.byProvider[0]).toMatchObject({
      name: 'openai',
      spend: 0.1,
      requests: 1,
    });
    expect(summary!.byDay['2026-05-22']).toBe(0.1);
    // Verify bounded read range when no official data
    expect(mockReadLocalUsage).toHaveBeenCalledWith({
      fromDateUtc: '2026-04-23',
      toDateUtc: '2026-05-22',
    });
  });

  it('should request only local rows after officialThroughDate', async () => {
    // Setup: Activity API has data through 2026-05-20
    mockGetCredits.mockResolvedValue({
      totalUsage: 3.0,
      totalCredits: 10.0,
    });

    const officialData = [
      {
        date: '2026-05-20',
        model: 'anthropic/claude-sonnet-4',
        providerName: 'anthropic',
        requests: 2,
        promptTokens: 1000,
        completionTokens: 200,
        reasoningTokens: 0,
        usage: 0.03,
      },
    ] as ActivityItem[];
    mockGetActivity.mockResolvedValue(officialData);

    // readLocalUsage should only return rows after officialThroughDate because
    // fetchAndAggregate requests a range starting at officialThroughDate + 1 day.
    const localEvents: LocalUsageEvent[] = [
      {
        id: 'local-after-official-date',
        generationId: 'gen-4',
        sessionId: 'session-4',
        completedAt: '2026-05-21T10:00:00Z',
        requests: 1,
        model: 'anthropic/claude-sonnet-4',
        provider: 'anthropic',
        cost: 0.04,
        promptTokens: 800,
        completionTokens: 150,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ];
    mockReadLocalUsage.mockResolvedValue(localEvents);

    const summary = await fetchAndAggregate();

    expect(summary).toBeDefined();
    // Official aggregate from Activity API
    expect(summary!.official.cost).toBe(0.03);
    // Local aggregate should only include rows after officialThroughDate
    expect(summary!.local.cost).toBe(0.04);
    expect(summary!.combined.cost).toBe(0.07);
    expect(summary!.byDay['2026-05-20']).toBe(0.03);
    expect(summary!.byDay['2026-05-21']).toBe(0.04);
    // Verify read range is from day after official through today
    expect(mockReadLocalUsage).toHaveBeenCalledWith({
      fromDateUtc: '2026-05-21', // Day after 2026-05-20
      toDateUtc: '2026-05-22',
    });
  });

  it('should read at most 30 UTC days when no official data exists', async () => {
    // Setup: No Activity data, verify bounded read
    mockGetCredits.mockResolvedValue({
      totalUsage: 2.0,
      totalCredits: 10.0,
    });
    mockGetActivity.mockResolvedValue([]);
    mockReadLocalUsage.mockResolvedValue([]);

    await fetchAndAggregate();

    // Verify the read range is bounded to 30 days (today - 29 through today = 30 days inclusive)
    expect(mockReadLocalUsage).toHaveBeenCalledWith({
      fromDateUtc: '2026-04-23', // 29 days before 2026-05-22
      toDateUtc: '2026-05-22',
    });
  });

  it('should keep official-only summary behavior unchanged when no local events exist', async () => {
    mockGetCredits.mockResolvedValue({
      totalUsage: 4.0,
      totalCredits: 10.0,
    });

    const officialData = [
      {
        date: '2026-05-21',
        model: 'openai/gpt-4',
        providerName: 'openai',
        requests: 3,
        promptTokens: 3000,
        completionTokens: 600,
        reasoningTokens: 0,
        usage: 0.15,
      },
    ] as ActivityItem[];
    mockGetActivity.mockResolvedValue(officialData);
    mockReadLocalUsage.mockResolvedValue([]);

    const summary = await fetchAndAggregate();

    expect(summary).toBeDefined();
    expect(summary).toMatchObject({
      today: 0,
      week: 0.15,
      month: 4.0,
      hasActivityData: true,
      officialThroughDate: '2026-05-21',
    });
    expect(summary!.topModels[0]).toMatchObject({
      name: 'openai/gpt-4',
      spend7d: 0.15,
      spend30d: 0.15,
      requests7d: 3,
      requests30d: 3,
    });
    expect(summary!.byProvider).toEqual([
      {
        name: 'openai',
        spend: 0.15,
        tokens: {
          input: 3000,
          output: 600,
          reasoning: 0,
          total: 3600,
        },
        requests: 3,
      },
    ]);
    expect(summary!.byDay).toEqual({ '2026-05-21': 0.15 });
    expect(summary!.official).toEqual({
      requests: 3,
      promptTokens: 3000,
      completionTokens: 600,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0.15,
    });
    expect(summary!.local).toEqual({
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
    });
    expect(summary!.combined).toEqual(summary!.official);
  });

  it('should fail open when local read throws error', async () => {
    // Setup: Activity API unavailable, local read fails
    mockGetCredits.mockResolvedValue({
      totalUsage: 1.0,
      totalCredits: 10.0,
    });
    mockGetActivity.mockResolvedValue(null);
    mockReadLocalUsage.mockRejectedValue(new Error('Filesystem error'));

    const summary = await fetchAndAggregate();

    // Should not throw, should continue with empty local
    expect(summary).toBeDefined();
    expect(summary!.local.cost).toBe(0);
    expect(summary!.combined.cost).toBe(0);
  });

  it('should keep combined aggregate equal to official plus local for every numeric field', async () => {
    mockGetCredits.mockResolvedValue({
      totalUsage: 9.0,
      totalCredits: 10.0,
    });
    mockGetActivity.mockResolvedValue([
      {
        date: '2026-05-21',
        model: 'openai/gpt-4',
        providerName: 'openai',
        requests: 2,
        promptTokens: 120,
        completionTokens: 30,
        reasoningTokens: 7,
        usage: 0.02,
      },
    ] as ActivityItem[]);
    mockReadLocalUsage.mockResolvedValue([
      {
        id: 'local-aggregate-invariant',
        generationId: 'gen-aggregate-invariant',
        sessionId: 'session-aggregate-invariant',
        completedAt: '2026-05-22T10:00:00Z',
        requests: 3,
        model: 'anthropic/claude-sonnet-4',
        provider: 'anthropic',
        promptTokens: 200,
        completionTokens: 40,
        reasoningTokens: 9,
        cacheReadTokens: 11,
        cacheWriteTokens: 13,
        cost: 0.05,
      },
    ]);

    const summary = await fetchAndAggregate();

    expect(summary).toBeDefined();
    for (const field of usageAggregateFields) {
      expect(summary!.combined[field]).toBe(summary!.official[field] + summary!.local[field]);
    }
  });
});

function createUsageSummary(overrides: Partial<UsageSummary> = {}): UsageSummary {
  return {
    today: 0,
    week: 0,
    month: 0,
    cap: 10,
    burnRate: 0,
    topModels: [],
    byProvider: [],
    byDay: {},
    timestamp: Date.now(),
    hasActivityData: true,
    official: {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
    },
    local: {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
    },
    combined: {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
    },
    ...overrides,
  };
}

describe('background refresh lifecycle', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    usageCache.clear();
    stopBackgroundRefresh();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T12:00:00Z'));
  });

  afterEach(() => {
    stopBackgroundRefresh();
    usageCache.clear();
    vi.useRealTimers();
  });

  function mockSuccessfulRefresh() {
    mockGetCredits.mockResolvedValue({ totalUsage: 2, totalCredits: 10 });
    mockGetActivity.mockResolvedValue([]);
    mockReadLocalUsage.mockResolvedValue([]);
  }

  it('caches usage after an initial successful refresh and schedules the normal interval', async () => {
    mockSuccessfulRefresh();

    startBackgroundRefresh();
    await vi.advanceTimersByTimeAsync(BACKGROUND_REFRESH_INTERVAL_MS);

    expect(usageCache.get('usage')).toBeDefined();
    expect(getRefreshState()).toMatchObject({
      status: 'healthy',
      consecutiveFailures: 0,
      nextDelayMs: BACKGROUND_REFRESH_INTERVAL_MS,
    });
    expect(mockGetCredits).toHaveBeenCalledTimes(1);
  });

  it('keeps last-good stale data available after one refresh failure', async () => {
    const staleSummary = createUsageSummary({ today: 1.23 });
    usageCache.set('usage', staleSummary);
    vi.setSystemTime(new Date('2026-05-22T12:01:00Z'));
    mockGetCredits.mockRejectedValue(new Error('network down'));

    startBackgroundRefresh();
    await vi.advanceTimersByTimeAsync(BACKGROUND_REFRESH_INTERVAL_MS);

    expect(usageCache.get('usage')).toBeUndefined();
    expect(usageCache.get('usage', { allowStale: true })).toEqual(staleSummary);
    expect(getRefreshState()).toMatchObject({
      status: 'stale',
      consecutiveFailures: 1,
      lastError: 'network down',
      nextDelayMs: BACKGROUND_REFRESH_INTERVAL_MS * 2,
    });
  });

  it('continues refreshing after repeated failures instead of stopping permanently', async () => {
    mockGetCredits.mockRejectedValue(new Error('still down'));

    startBackgroundRefresh();

    for (const expectedFailures of [1, 2, 3, 4, 5]) {
      await vi.advanceTimersByTimeAsync(
        getRefreshState().nextDelayMs ?? BACKGROUND_REFRESH_INTERVAL_MS,
      );
      expect(getRefreshState().consecutiveFailures).toBe(expectedFailures);
      expect(getRefreshState().nextDelayMs).toBeLessThanOrEqual(
        BACKGROUND_REFRESH_INTERVAL_MS * 32,
      );
    }

    const callsAfterFiveFailures = mockGetCredits.mock.calls.length;
    await vi.advanceTimersByTimeAsync(
      getRefreshState().nextDelayMs ?? BACKGROUND_REFRESH_INTERVAL_MS,
    );

    expect(mockGetCredits.mock.calls.length).toBeGreaterThan(callsAfterFiveFailures);
    expect(getRefreshState().status).toBe('failed');
  });

  it('uses a longer capped backoff for rate-limit failures', async () => {
    mockGetCredits.mockRejectedValue(new Error('429 rate limit exceeded'));

    startBackgroundRefresh();
    await vi.advanceTimersByTimeAsync(BACKGROUND_REFRESH_INTERVAL_MS);

    expect(getRefreshState()).toMatchObject({
      status: 'failed',
      consecutiveFailures: 1,
      nextDelayMs: BACKGROUND_REFRESH_INTERVAL_MS * 8,
    });
  });

  it('resets failure state and returns to the normal interval after recovery', async () => {
    mockGetCredits.mockRejectedValueOnce(new Error('temporary outage'));
    mockGetCredits.mockResolvedValue({ totalUsage: 3, totalCredits: 10 });
    mockGetActivity.mockResolvedValue([]);
    mockReadLocalUsage.mockResolvedValue([]);

    startBackgroundRefresh();
    await vi.advanceTimersByTimeAsync(BACKGROUND_REFRESH_INTERVAL_MS);
    expect(getRefreshState()).toMatchObject({
      status: 'failed',
      consecutiveFailures: 1,
      nextDelayMs: BACKGROUND_REFRESH_INTERVAL_MS * 2,
    });

    await vi.advanceTimersByTimeAsync(BACKGROUND_REFRESH_INTERVAL_MS * 2);

    expect(getRefreshState()).toMatchObject({
      status: 'healthy',
      consecutiveFailures: 0,
      lastError: null,
      nextDelayMs: BACKGROUND_REFRESH_INTERVAL_MS,
    });
    expect(usageCache.get('usage')).toBeDefined();
  });

  it('clears the timer on stop and prevents further refreshes', async () => {
    mockSuccessfulRefresh();

    startBackgroundRefresh();
    stopBackgroundRefresh();
    await vi.advanceTimersByTimeAsync(BACKGROUND_REFRESH_INTERVAL_MS * 4);

    expect(mockGetCredits).not.toHaveBeenCalled();
    expect(getRefreshState()).toMatchObject({
      status: 'idle',
      consecutiveFailures: 0,
      nextDelayMs: null,
    });
  });

  it('notifies via callback when refresh failures occur', async () => {
    const onFailure = vi.fn();
    mockGetCredits.mockRejectedValue(new Error('persistent failure'));

    startBackgroundRefresh({ onFailure });
    await vi.advanceTimersByTimeAsync(BACKGROUND_REFRESH_INTERVAL_MS);

    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        consecutiveFailures: 1,
        lastError: 'persistent failure',
      }),
    );
  });
});
