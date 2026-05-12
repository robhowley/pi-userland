import { describe, it, expect } from 'vitest';
import { aggregateUsage } from '../format.js';
import { renderSpendSparkline } from '../chart.js';
import type { ActivityItem } from '@openrouter/sdk/models/index.js';

describe('aggregateUsage', () => {
  it('should correctly aggregate today spend using UTC date', () => {
    const credits = {
      totalUsage: 10,
      totalCredits: 100,
    };

    // Get today's date in YYYY-MM-DD format using UTC date
    // This matches how the API returns dates (YYYY-MM-DD without timezone)
    // and how the implementation calculates 'today' (using UTC)
    const now = new Date();
    const todayStr = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;

    const analytics: ActivityItem[] = [
      {
        date: todayStr,
        model: 'gpt-4',
        modelPermaslug: 'gpt-4-perma',
        endpointId: 'ep-1',
        usage: 6.55,
        byokUsageInference: 0,
        requests: 10,
        promptTokens: 1000,
        completionTokens: 100,
        reasoningTokens: 0,
        providerName: 'openai',
      },
    ];

    const result = aggregateUsage(credits, analytics);

    expect(result.today).toBe(6.55);
  });

  it('should calculate from analytics', () => {
    const credits = {
      totalUsage: 38.42,
      totalCredits: 100,
    };
    // Use a date that's within the last 7 days of when the test runs.
    // Get today's date in UTC and subtract a few days to ensure it's in the week window.
    const now = new Date();
    const testDate = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000); // 3 days ago
    const date = `${testDate.getUTCFullYear()}-${String(testDate.getUTCMonth() + 1).padStart(2, '0')}-${String(testDate.getUTCDate()).padStart(2, '0')}`;
    const analytics: ActivityItem[] = [
      {
        date: date,
        model: 'model-1',
        modelPermaslug: 'model-1-perma',
        endpointId: 'ep-1',
        usage: 5.42,
        byokUsageInference: 0,
        requests: 10,
        promptTokens: 1000,
        completionTokens: 100,
        reasoningTokens: 0,
        providerName: 'provider-1',
      },
      {
        date: date,
        model: 'model-2',
        modelPermaslug: 'model-2-perma',
        endpointId: 'ep-2',
        usage: 3.11,
        byokUsageInference: 0,
        requests: 5,
        promptTokens: 500,
        completionTokens: 50,
        reasoningTokens: 0,
        providerName: 'provider-2',
      },
    ];

    const result = aggregateUsage(credits, analytics);

    expect(result.month).toBe(38.42);
    // Data from the test date should be in the week (7 days ago window)
    expect(result.week).toBeGreaterThan(0);
    // Today's data might not be from the test date due to timezone, so just check month
  });

  it('should calculate burn rate correctly', () => {
    const credits = {
      totalUsage: 38.42,
      totalCredits: 100,
    };
    const analytics: ActivityItem[] = [];

    const result = aggregateUsage(credits, analytics);

    expect(result.burnRate).toBe(0);
    expect(result.week).toBe(0);
    expect(result.today).toBe(0);
  });

  it('should handle empty analytics', () => {
    const credits = {
      totalUsage: 18.21,
      totalCredits: 30,
    };

    const result = aggregateUsage(credits, []);

    expect(result.month).toBe(18.21);
    expect(result.week).toBe(0);
    expect(result.today).toBe(0);
    expect(result.topModels).toEqual([]);
    expect(result.byProvider).toEqual([]);
    expect(result.byDay).toEqual({});
  });

  it('should aggregate by model', () => {
    const credits = {
      totalUsage: 10,
      totalCredits: 100,
    };
    // Use a dynamic date that's within the last 7 days
    const now = new Date();
    const testDate = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000); // 3 days ago
    const date = `${testDate.getUTCFullYear()}-${String(testDate.getUTCMonth() + 1).padStart(2, '0')}-${String(testDate.getUTCDate()).padStart(2, '0')}`;
    const analytics: ActivityItem[] = [
      {
        date: date,
        model: 'gpt-4',
        modelPermaslug: 'gpt-4-perma',
        endpointId: 'ep-1',
        usage: 5.0,
        byokUsageInference: 0,
        requests: 5,
        promptTokens: 100,
        completionTokens: 50,
        reasoningTokens: 0,
        providerName: 'openai',
      },
      {
        date: date,
        model: 'claude-3',
        modelPermaslug: 'claude-3-perma',
        endpointId: 'ep-2',
        usage: 3.0,
        byokUsageInference: 0,
        requests: 3,
        promptTokens: 60,
        completionTokens: 30,
        reasoningTokens: 0,
        providerName: 'anthropic',
      },
    ];

    const result = aggregateUsage(credits, analytics);

    // topModels should be populated with model stats
    expect(result.topModels).toHaveLength(2);
    expect(result.topModels[0]?.name).toBe('gpt-4');
    expect(result.topModels[0]?.spend30d).toBe(5.0);
    expect(result.topModels[0]?.tokens7d.total).toBe(150); // 100 + 50
    expect(result.topModels[0]?.tokens30d.total).toBe(150);
    expect(result.topModels[0]?.requests7d).toBe(5);
    expect(result.topModels[0]?.requests30d).toBe(5);
    expect(result.topModels[1]?.name).toBe('claude-3');
    expect(result.topModels[1]?.spend30d).toBe(3.0);
    expect(result.topModels[1]?.tokens7d.total).toBe(90); // 60 + 30
    expect(result.topModels[1]?.tokens30d.total).toBe(90);
  });

  it('should include 30d model data', () => {
    const credits = {
      totalUsage: 100,
      totalCredits: 200,
    };
    // Data from recent dates for 30d
    const analytics: ActivityItem[] = [
      {
        date: '2026-04-15',
        model: 'gpt-4',
        modelPermaslug: 'gpt-4-perma',
        endpointId: 'ep-1',
        usage: 50.0,
        byokUsageInference: 0,
        requests: 10,
        promptTokens: 1000,
        completionTokens: 100,
        reasoningTokens: 0,
        providerName: 'openai',
      },
      {
        date: '2026-04-20',
        model: 'claude-3',
        modelPermaslug: 'claude-3-perma',
        endpointId: 'ep-2',
        usage: 30.0,
        byokUsageInference: 0,
        requests: 5,
        promptTokens: 500,
        completionTokens: 50,
        reasoningTokens: 0,
        providerName: 'anthropic',
      },
    ];

    const result = aggregateUsage(credits, analytics);

    // topModels should be populated with 30d data
    expect(result.topModels).toHaveLength(2);
    expect(result.topModels[0]?.name).toBe('gpt-4');
    expect(result.topModels[0]?.spend30d).toBe(50.0);
    expect(result.topModels[1]?.name).toBe('claude-3');
    expect(result.topModels[1]?.spend30d).toBe(30.0);
  });

  it('should aggregate provider stats with tokens', () => {
    const credits = {
      totalUsage: 10,
      totalCredits: 100,
    };
    const date = '2026-05-01';
    const analytics: ActivityItem[] = [
      {
        date: date,
        model: 'gpt-4',
        modelPermaslug: 'gpt-4-perma',
        endpointId: 'ep-1',
        usage: 5.0,
        byokUsageInference: 0,
        requests: 5,
        promptTokens: 100,
        completionTokens: 50,
        reasoningTokens: 0,
        providerName: 'openai',
      },
      {
        date: date,
        model: 'claude-3',
        modelPermaslug: 'claude-3-perma',
        endpointId: 'ep-2',
        usage: 3.0,
        byokUsageInference: 0,
        requests: 3,
        promptTokens: 60,
        completionTokens: 30,
        reasoningTokens: 0,
        providerName: 'openai', // Same provider, different endpoint
      },
    ];

    const result = aggregateUsage(credits, analytics);

    // byProvider should use providerName, aggregated correctly
    expect(result.byProvider).toHaveLength(1);
    expect(result.byProvider[0]?.name).toBe('openai');
    expect(result.byProvider[0]?.spend).toBe(8.0);
    // Token counts should be aggregated
    expect(result.byProvider[0]?.tokens.total).toBe(240); // 100 + 50 + 60 + 30
    expect(result.byProvider[0]?.tokens.input).toBe(160); // 100 + 60
    expect(result.byProvider[0]?.tokens.output).toBe(80); // 50 + 30
    expect(result.byProvider[0]?.requests).toBe(8); // 5 + 3
  });
});

describe('renderSpendSparkline', () => {
  it('should generate chart with < 30 days (should pad with zeros)', () => {
    const byDay = {
      '2026-05-01': 10.5,
      '2026-05-02': 15.25,
      '2026-05-03': 8.0,
    };
    const chartLines = renderSpendSparkline(byDay, 60);

    // 9 bar + 1 separator + 2 label lines = 12
    expect(chartLines).toHaveLength(12);
    // First line should have bars (Unicode block characters)
    expect(chartLines[0]).toMatch(/[█]/);
  });

  it('should generate chart with exactly 30 days', () => {
    const byDay: Record<string, number> = {};
    for (let i = 1; i <= 30; i++) {
      const day = i < 10 ? `0${i}` : `${i}`;
      byDay[`2026-05-${day}`] = i * 2.5;
    }

    const chartLines = renderSpendSparkline(byDay, 60);
    // 9 bar + 1 separator + 2 label lines = 12
    expect(chartLines).toHaveLength(12);
    // First line should have bars
    expect(chartLines[0]).toMatch(/[█]/);
  });

  it('should respect width constraints', () => {
    const byDay = { '2026-05-01': 10 };
    const narrowChart = renderSpendSparkline(byDay, 30);
    const wideChart = renderSpendSparkline(byDay, 80);

    // 9 bar + 1 separator + 2 label lines = 12
    expect(narrowChart).toHaveLength(12);
    expect(wideChart).toHaveLength(12);
    // Bar width should be constrained
    expect(narrowChart[0]!.length).toBeLessThanOrEqual(67);
    expect(wideChart[0]!.length).toBeGreaterThanOrEqual(narrowChart[0]!.length);
  });

  it('should produce valid x-axis labels', () => {
    const byDay: Record<string, number> = {};
    for (let i = 1; i <= 30; i++) {
      const day = i < 10 ? `0${i}` : `${i}`;
      byDay[`2026-05-${day}`] = i * 2.5;
    }

    const chartLines = renderSpendSparkline(byDay, 80);
    const dayNumbersLine = chartLines[11]; // day numbers are at line 11

    expect(dayNumbersLine).toBeDefined();
    // Should contain day numbers for positions 0, 5, 10, 15, 20, 25, 29 (30 bars total)
    // Each day number is 2 chars, so day 1=col4, day 6=col12, day 11=col20, etc
    expect(dayNumbersLine).toContain('01'); // Day 0 (29 days ago from 05-30)
    expect(dayNumbersLine).toContain('06'); // Day 5
    expect(dayNumbersLine).toContain('11'); // Day 10
    expect(dayNumbersLine).toContain('16'); // Day 15
    expect(dayNumbersLine).toContain('21'); // Day 20
    expect(dayNumbersLine).toContain('26'); // Day 25
    expect(dayNumbersLine).toContain('30'); // Day 29 (today)
  });
});
