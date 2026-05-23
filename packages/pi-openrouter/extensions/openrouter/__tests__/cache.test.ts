import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { fetchAndAggregate } from '../cache.js';
import { getCredits, getActivity } from '../client.js';
import { readLocalUsage } from '../local-usage.js';
import type { LocalUsageEvent } from '../types.js';
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

  it('should preserve Activity-only aggregation when no local events exist', async () => {
    // Setup: Activity data exists, no local events
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
    expect(summary!.official.cost).toBe(0.15);
    expect(summary!.local.cost).toBe(0);
    expect(summary!.combined.cost).toBe(0.15);
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
});
