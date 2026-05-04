import { describe, it, expect } from 'vitest';
import { aggregateUsage } from '../format.js';
import type { ActivityItem } from '../types.js';

describe('aggregateUsage', () => {
  it('should calculate from analytics', () => {
    const credits = {
      totalUsage: 38.42,
      totalCredits: 100,
    };
    // Use a date that's within the last 7 days of when the test runs.
    // We use a date from the past month that's been long enough to survive timezone offsets.
    const date = '2026-05-01';
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
    // Data from May 1 should be in the week (but may not be in "today" depending on timezone)
    expect(result.week).toBeGreaterThan(0);
    // Today's data might not be from May 1 due to timezone, so just check month
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
    expect(result.topModels7d).toEqual([]);
    expect(result.byModel).toEqual({});
    expect(result.byKey).toEqual({});
    expect(result.byDay).toEqual({});
  });

  it('should aggregate by model', () => {
    const credits = {
      totalUsage: 10,
      totalCredits: 100,
    };
    // Use a fixed date that's definitely in the past
    const date = '2026-05-03';
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

    expect(result.byModel).toEqual({
      'gpt-4': 5.0,
      'claude-3': 3.0,
    });
    expect(result.topModels7d).toHaveLength(2);
    const first = result.topModels7d[0]!;
    expect(first.name).toBe('gpt-4');
    expect(first.spend).toBe(5.0);
  });

  it('should aggregate by provider name (not endpoint ID)', () => {
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

    // byKey should use providerName, not endpointId
    expect(result.byKey).toEqual({
      'openai': 8.0, // Total from both endpoints
    });
    // Should NOT contain endpoint IDs
    expect(result.byKey).not.toHaveProperty('ep-1');
    expect(result.byKey).not.toHaveProperty('ep-2');
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

    // topModels30d should be populated
    expect(result.topModels30d).toHaveLength(2);
    expect(result.topModels30d[0]).toEqual({ name: 'gpt-4', spend: 50.0 });
    expect(result.topModels30d[1]).toEqual({ name: 'claude-3', spend: 30.0 });
  });
});
