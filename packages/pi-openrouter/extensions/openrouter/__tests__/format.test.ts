import { describe, it, expect } from 'vitest';
import { aggregateUsage } from '../format.js';

describe('aggregateUsage', () => {
  it('should include cap from credits', () => {
    const credits = {
      total_usage: 38.42,
      total_credits: 100,
    };
    const analytics = {
      data: [
        {
          date: '2026-05-01 00:00:00',
          model_permaslug: 'model-1',
          endpoint_id: 'ep-1',
          usage: 5.42,
          byok_usage_inference: 0,
          requests: 10,
          prompt_tokens: 1000,
          completion_tokens: 100,
          reasoning_tokens: 0,
          byok_requests: 0,
          model: 'model-1',
          provider_name: 'provider-1',
        },
        {
          date: '2026-05-01 00:00:00',
          model_permaslug: 'model-2',
          endpoint_id: 'ep-2',
          usage: 3.11,
          byok_usage_inference: 0,
          requests: 5,
          prompt_tokens: 500,
          completion_tokens: 50,
          reasoning_tokens: 0,
          byok_requests: 0,
          model: 'model-2',
          provider_name: 'provider-2',
        },
      ],
    };

    const result = aggregateUsage(credits, analytics);

    expect(result.cap).toBe(100);
    expect(result.month).toBe(38.42);
    expect(result.week).toBe(8.53);
  });

  it('should calculate cap percentage correctly', () => {
    const credits = {
      total_usage: 38.42,
      total_credits: 100,
    };
    const analytics = {
      data: [],
    };

    const result = aggregateUsage(credits, analytics);

    // The overlay calculates percentage as Math.round((month / cap) * 100)
    const expectedPercent = Math.round((result.month / result.cap) * 100); // 38%
    expect(expectedPercent).toBe(38);
  });

  it('should handle missing analytics (regular API key)', () => {
    const credits = {
      total_usage: 18.21,
      total_credits: 30,
    };

    const result = aggregateUsage(credits, null);

    expect(result.cap).toBe(30);
    expect(result.month).toBe(18.21);
    expect(result.week).toBe(0); // No analytics data
    expect(result.topModels7d).toEqual([]); // No models without analytics
    expect(result.topModels30d).toEqual([]); // No models without analytics
  });
});
