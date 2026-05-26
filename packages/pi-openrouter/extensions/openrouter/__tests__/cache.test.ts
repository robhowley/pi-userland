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
import type { LocalUsageEvent } from '../types.js';
import type { ActivityItem } from '@openrouter/sdk/models/index.js';
import { createActivityItem, createLocalEvents, createUsageSummary } from './fixtures.js';

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

  it.each([
    {
      label: 'Activity API returns null',
      officialResponse: null as null | ActivityItem[],
      expectedHasActivityData: false,
      model: 'anthropic/claude-sonnet-4',
      provider: 'anthropic',
      cost: 0.05,
    },
    {
      label: 'Activity API returns empty array',
      officialResponse: [] as ActivityItem[],
      expectedHasActivityData: true,
      model: 'openai/gpt-4',
      provider: 'openai',
      cost: 0.1,
    },
  ])(
    'should include local cost when $label and local events exist',
    async ({ officialResponse, expectedHasActivityData, model, provider, cost }) => {
      // Setup: credits available, Activity API absent/empty, local events exist
      mockGetCredits.mockResolvedValue({
        totalUsage: 5.0,
        totalCredits: 10.0,
      });
      mockGetActivity.mockResolvedValue(officialResponse);

      const localEvents = createLocalEvents([{ daysAgo: 0, cost, model, provider }]);
      mockReadLocalUsage.mockResolvedValue(localEvents);

      const summary = await fetchAndAggregate();

      expect(summary).toBeDefined();
      expect(summary!.hasActivityData).toBe(expectedHasActivityData);
      expect(summary!.local.cost).toBeGreaterThan(0);
      expect(summary!.local.cost).toBe(cost);
      expect(summary!.combined.cost).toBe(cost);
      expect(summary!.today).toBe(cost);
      expect(summary!.topModels[0]).toMatchObject({
        name: model,
        spend7d: cost,
        spend30d: cost,
        requests7d: 1,
        requests30d: 1,
      });
      expect(summary!.byProvider[0]).toMatchObject({
        name: provider,
        spend: cost,
        requests: 1,
      });
      expect(summary!.byDay['2026-05-22']).toBe(cost);
      // Verify bounded read range: today - 29 days through today
      expect(mockReadLocalUsage).toHaveBeenCalledWith({
        fromDateUtc: '2026-04-23', // 29 days before 2026-05-22
        toDateUtc: '2026-05-22',
      });
    },
  );

  it('should request only local rows after officialThroughDate', async () => {
    // Setup: Activity API has data through 2026-05-20
    mockGetCredits.mockResolvedValue({
      totalUsage: 3.0,
      totalCredits: 10.0,
    });

    const officialData = [
      createActivityItem({
        date: '2026-05-20',
        model: 'anthropic/claude-sonnet-4',
        providerName: 'anthropic',
        requests: 2,
        promptTokens: 1000,
        completionTokens: 200,
        reasoningTokens: 0,
        usage: 0.03,
      }),
    ];
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

  it.each([
    {
      label: 'official data is much older than the 30-day window',
      officialThroughDate: '2026-02-11',
      expectedFromDateUtc: '2026-04-23',
    },
    {
      label: 'official data is exactly at the boundary',
      officialThroughDate: '2026-04-22',
      expectedFromDateUtc: '2026-04-23',
    },
    {
      label: 'official data is recent',
      officialThroughDate: '2026-05-20',
      expectedFromDateUtc: '2026-05-21',
    },
  ])(
    'caps local read range only when $label',
    async ({ officialThroughDate, expectedFromDateUtc }) => {
      mockGetCredits.mockResolvedValue({
        totalUsage: 5.0,
        totalCredits: 10.0,
      });
      mockGetActivity.mockResolvedValue([
        createActivityItem({
          date: officialThroughDate,
          model: 'anthropic/claude-sonnet-4',
          providerName: 'anthropic',
          requests: 1,
          usage: 0.1,
        }),
      ]);
      mockReadLocalUsage.mockResolvedValue([]);

      const summary = await fetchAndAggregate();

      expect(summary!.officialThroughDate).toBe(officialThroughDate);
      expect(mockReadLocalUsage).toHaveBeenCalledWith({
        fromDateUtc: expectedFromDateUtc,
        toDateUtc: '2026-05-22',
      });
    },
  );

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
      createActivityItem({
        date: '2026-05-21',
        model: 'openai/gpt-4',
        providerName: 'openai',
        requests: 3,
        promptTokens: 3000,
        completionTokens: 600,
        reasoningTokens: 0,
        usage: 0.15,
      }),
    ];
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
      createActivityItem({
        date: '2026-05-21',
        model: 'openai/gpt-4',
        providerName: 'openai',
        requests: 2,
        promptTokens: 120,
        completionTokens: 30,
        reasoningTokens: 7,
        usage: 0.02,
      }),
    ]);
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

describe('fetchAndAggregate - Today/local cutover data contract', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Activity API absent: bounded 30-day local fallback', () => {
    it.each([
      {
        label: 'multi-day local with today event',
        apiResponse: null as null | ActivityItem[],
        localEvents: [
          { daysAgo: 3, cost: 1.0, model: 'gpt-4', provider: 'openai' },
          { daysAgo: 1, cost: 2.0, model: 'claude-3', provider: 'anthropic' },
          { daysAgo: 0, cost: 0.5, model: 'gpt-4', provider: 'openai' },
        ],
        expectedLocalCost: 3.5,
        expectedLocalRequests: 3,
        expectedToday: 0.5,
        expectedCombinedCost: 3.5,
      },
      {
        label: 'empty Activity API with multi-day local',
        apiResponse: [] as ActivityItem[],
        localEvents: [
          { daysAgo: 3, cost: 1.0, model: 'gpt-4', provider: 'openai' },
          { daysAgo: 1, cost: 2.0, model: 'claude-3', provider: 'anthropic' },
          { daysAgo: 0, cost: 0.5, model: 'gpt-4', provider: 'openai' },
        ],
        expectedLocalCost: 3.5,
        expectedLocalRequests: 3,
        expectedToday: 0.5,
        expectedCombinedCost: 3.5,
      },
      {
        label: 'local has only older events, no today',
        apiResponse: [] as ActivityItem[],
        localEvents: [
          { daysAgo: 5, cost: 1.5, model: 'gpt-4', provider: 'openai' },
          { daysAgo: 2, cost: 0.8, model: 'claude-3', provider: 'anthropic' },
        ],
        expectedLocalCost: 2.3,
        expectedLocalRequests: 2,
        expectedToday: 0,
        expectedCombinedCost: 2.3,
      },
    ])(
      'sets summary.local to multi-day but summary.today to UTC-today only: $label',
      async ({
        apiResponse,
        localEvents,
        expectedLocalCost,
        expectedLocalRequests,
        expectedToday,
        expectedCombinedCost,
      }) => {
        mockGetCredits.mockResolvedValue({
          totalUsage: 5.0,
          totalCredits: 10.0,
        });
        mockGetActivity.mockResolvedValue(apiResponse);

        const events = createLocalEvents(localEvents);
        mockReadLocalUsage.mockResolvedValue(events);

        const summary = await fetchAndAggregate();

        expect(summary).toBeDefined();
        expect(summary!.local.cost).toBe(expectedLocalCost);
        expect(summary!.local.requests).toBe(expectedLocalRequests);
        expect(summary!.today).toBe(expectedToday);
        expect(summary!.combined.cost).toBe(expectedCombinedCost);
        // Verify bounded 30-day read range
        expect(mockReadLocalUsage).toHaveBeenCalledWith({
          fromDateUtc: '2026-04-23', // 29 days before 2026-05-22
          toDateUtc: '2026-05-22',
        });
      },
    );
  });

  describe('Activity API behind: local spans multiple post-official days', () => {
    it('sets summary.local to multi-day post-official aggregate but summary.today to UTC-today only', async () => {
      // Scenario: Activity API through 2 days ago (2026-05-20).
      // Local JSONL has events from yesterday (2026-05-21) and today (2026-05-22).
      // summary.local should include both post-official days.
      // summary.today should include only UTC-today (2026-05-22).
      mockGetCredits.mockResolvedValue({
        totalUsage: 10.0,
        totalCredits: 20.0,
      });

      const officialData = [
        createActivityItem({
          date: '2026-05-20',
          model: 'gpt-4',
          providerName: 'openai',
          requests: 5,
          usage: 2.0,
        }),
      ];
      mockGetActivity.mockResolvedValue(officialData);

      // Create all events in a single call to avoid ID collision from spreading
      const localEvents = createLocalEvents([
        // Yesterday (2026-05-21)
        { daysAgo: 1, cost: 3.0, model: 'claude-3', provider: 'anthropic' },
        // Today (2026-05-22)
        { daysAgo: 0, cost: 1.5, model: 'gpt-4', provider: 'openai' },
      ]);
      mockReadLocalUsage.mockResolvedValue(localEvents);

      const summary = await fetchAndAggregate();

      expect(summary).toBeDefined();
      // official aggregate from API
      expect(summary!.official.cost).toBe(2.0);
      // local includes yesterday + today
      expect(summary!.local.cost).toBe(4.5);
      expect(summary!.local.requests).toBe(2);
      // today includes only UTC-today event
      expect(summary!.today).toBe(1.5);
      // combined = official + local
      expect(summary!.combined.cost).toBe(6.5);
      // Verify read range starts day after officialThroughDate
      expect(mockReadLocalUsage).toHaveBeenCalledWith({
        fromDateUtc: '2026-05-21', // day after 2026-05-20
        toDateUtc: '2026-05-22',
      });
    });

    it('sets summary.today correctly when local has multiple post-official days but no today events', async () => {
      // Edge case: Activity API through 5 days ago. Local has events from 3-4 days ago, but none today.
      mockGetCredits.mockResolvedValue({
        totalUsage: 15.0,
        totalCredits: 20.0,
      });

      const officialData = [
        createActivityItem({
          date: '2026-05-17', // 5 days ago
          model: 'gpt-4',
          providerName: 'openai',
          requests: 10,
          usage: 5.0,
        }),
      ];
      mockGetActivity.mockResolvedValue(officialData);

      // Create all events in a single call to avoid ID collision from spreading
      const localEvents = createLocalEvents([
        { daysAgo: 4, cost: 2.0, model: 'claude-3', provider: 'anthropic' },
        { daysAgo: 3, cost: 1.0, model: 'gpt-4', provider: 'openai' },
      ]);
      mockReadLocalUsage.mockResolvedValue(localEvents);

      const summary = await fetchAndAggregate();

      expect(summary).toBeDefined();
      // local includes both post-official events
      expect(summary!.local.cost).toBe(3.0);
      // today should be 0 because no events from today
      expect(summary!.today).toBe(0);
    });
  });

  describe('Activity API includes today: local should be empty or minimal', () => {
    it('sets summary.today from official when officialThroughDate is today and local is empty', async () => {
      // Scenario: Activity API data through today (2026-05-22).
      // Local read range starts tomorrow, so local should be empty.
      mockGetCredits.mockResolvedValue({
        totalUsage: 8.0,
        totalCredits: 20.0,
      });

      const officialData = [
        createActivityItem({
          date: '2026-05-22', // today
          model: 'gpt-4',
          providerName: 'openai',
          requests: 8,
          usage: 3.0,
        }),
      ];
      mockGetActivity.mockResolvedValue(officialData);

      // When officialThroughDate is today, local read range is tomorrow through today,
      // which is an empty range.
      mockReadLocalUsage.mockResolvedValue([]);

      const summary = await fetchAndAggregate();

      expect(summary).toBeDefined();
      expect(summary!.officialThroughDate).toBe('2026-05-22');
      // official includes today's data
      expect(summary!.official.cost).toBe(3.0);
      // local is empty because read range starts tomorrow
      expect(summary!.local.cost).toBe(0);
      // today comes from official data
      expect(summary!.today).toBe(3.0);
      // combined = official only
      expect(summary!.combined.cost).toBe(3.0);
      // Verify read range: tomorrow through today = empty range
      expect(mockReadLocalUsage).toHaveBeenCalledWith({
        fromDateUtc: '2026-05-23', // day after 2026-05-22 (today)
        toDateUtc: '2026-05-22', // today
      });
    });

    it('sets summary.today from official when API includes today', async () => {
      // Scenario: Activity API includes today (2026-05-22) among other days.
      // officialThroughDate will be today, so local read range is empty.
      mockGetCredits.mockResolvedValue({
        totalUsage: 12.0,
        totalCredits: 20.0,
      });

      const officialData = [
        createActivityItem({
          date: '2026-05-21', // yesterday
          model: 'gpt-4',
          providerName: 'openai',
          requests: 5,
          usage: 4.0,
        }),
        createActivityItem({
          date: '2026-05-22', // today
          model: 'claude-3',
          providerName: 'anthropic',
          requests: 3,
          usage: 2.5,
        }),
      ];
      mockGetActivity.mockResolvedValue(officialData);

      // Local read range starts tomorrow when official includes today
      mockReadLocalUsage.mockResolvedValue([]);

      const summary = await fetchAndAggregate();

      expect(summary).toBeDefined();
      expect(summary!.officialThroughDate).toBe('2026-05-22');
      // official includes both days
      expect(summary!.official.cost).toBe(6.5);
      // local is empty
      expect(summary!.local.cost).toBe(0);
      // today comes from official data (2026-05-22 row)
      expect(summary!.today).toBe(2.5);
    });
  });
});

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
