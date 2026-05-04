import { describe, it, expect } from 'vitest';
import { aggregateUsage } from '../format.js';
import type { ActivityItem } from '../types.js';

describe('aggregateUsage', () => {
  it('should calculate from analytics', () => {
    const credits = {
      totalUsage: 38.42,
      totalCredits: 100,
    };
    const today = new Date().toISOString().split('T')[0]!;
    const analytics: ActivityItem[] = [
      {
        date: today,
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
        date: today,
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
    expect(result.week).toBeGreaterThan(0);
    expect(result.today).toBeGreaterThan(0);
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
    const today = new Date().toISOString().split('T')[0]!;
    const analytics: ActivityItem[] = [
      {
        date: today,
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
        date: today,
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
});
