import { describe, it, expect } from 'vitest';
import { isOpenRouterRequest, formatSessionId } from '../session.js';

// =============================================================================
// Parameterized Test Types
// =============================================================================

interface DetectionTestCase {
  name: string;
  event: Record<string, unknown>;
  ctx?: Record<string, unknown>;
  expected: boolean;
  description: string;
}

// =============================================================================
// Session ID Formatting Tests
// =============================================================================

describe('formatSessionId', () => {
  it('adds pi: prefix if missing', () => {
    expect(formatSessionId('abc123')).toBe('pi:abc123');
  });

  it('does not add duplicate pi: prefix', () => {
    expect(formatSessionId('pi:abc123')).toBe('pi:abc123');
  });
});

// =============================================================================
// Request Detection Tests
// =============================================================================

describe('isOpenRouterRequest', () => {
  // =============================================================================
  // Parameterized tests - detection signals (single source of truth)
  // =============================================================================

  const detectionCases: DetectionTestCase[] = [
    // Model prefix signal
    {
      name: 'model prefix: openrouter/',
      event: { payload: { model: 'openrouter/anthropic/claude-3' } },
      ctx: {},
      expected: true,
      description: 'Model with openrouter/ prefix should be detected',
    },
    {
      name: 'model prefix: missing prefix',
      event: { payload: { model: 'anthropic/claude-3' } },
      ctx: {},
      expected: false,
      description:
        'Model without openrouter/ prefix should not be detected by the model-prefix signal',
    },
    {
      name: 'model prefix: similar but not prefix',
      event: { payload: { model: 'my-openrouter-model' } },
      ctx: {},
      expected: false,
      description: 'Model containing openrouter but not as prefix should not match',
    },

    // Context baseUrl signal
    {
      name: 'context baseUrl: contains openrouter.ai',
      event: { payload: { model: 'qwen/coder' } },
      ctx: { model: { baseUrl: 'https://openrouter.ai/api/v1' } },
      expected: true,
      description: 'Context with openrouter.ai baseUrl should be detected',
    },
    {
      name: 'context baseUrl: different baseUrl',
      event: { payload: { model: 'claude-3' } },
      ctx: { model: { baseUrl: 'https://api.anthropic.com' } },
      expected: false,
      description: 'Non-OpenRouter baseUrl should not be detected',
    },
    {
      name: 'context baseUrl: missing baseUrl',
      event: { payload: { model: 'claude-3' } },
      ctx: { model: {} },
      expected: false,
      description: 'Missing baseUrl should not be detected by the context baseUrl signal',
    },
    {
      name: 'context baseUrl: no model in context',
      event: { payload: { model: 'claude-3' } },
      ctx: {},
      expected: false,
      description: 'Empty context should not crash the context baseUrl signal',
    },

    // ZDR provider signal
    {
      name: 'zdr provider: flag set',
      event: { payload: { model: 'qwen/coder' }, provider: { zdr: true } },
      ctx: {},
      expected: true,
      description: 'Provider with zdr: true should be detected',
    },
    {
      name: 'zdr provider: flag not set',
      event: { payload: { model: 'qwen/coder' }, provider: { zdr: false } },
      ctx: {},
      expected: false,
      description: 'Provider with zdr: false should not be detected',
    },
    {
      name: 'zdr provider: no provider object',
      event: { payload: { model: 'qwen/coder' } },
      ctx: {},
      expected: false,
      description: 'Missing provider should not be detected by the ZDR provider signal',
    },

    // URL / endpoint signal
    {
      name: 'url: contains openrouter.ai',
      event: { payload: { model: 'qwen/coder' }, url: 'https://openrouter.ai/api/v1/chat' },
      ctx: {},
      expected: true,
      description: 'URL containing openrouter.ai should be detected',
    },
    {
      name: 'endpoint: alternative to url',
      event: { payload: { model: 'qwen/coder' }, endpoint: 'https://openrouter.ai/api/v1/chat' },
      ctx: {},
      expected: true,
      description: 'Endpoint property should also be checked (fallback to url)',
    },
    {
      name: 'url: non-OpenRouter url',
      event: { payload: { model: 'qwen/coder' }, url: 'https://api.anthropic.com/v1/messages' },
      ctx: {},
      expected: false,
      description: 'Non-OpenRouter URL should not be detected',
    },
    {
      name: 'url: contains openrouter.ai in path',
      event: {
        payload: { model: 'qwen/coder' },
        url: 'https://proxy.example.com/v1/openrouter.ai/endpoint',
      },
      ctx: {},
      expected: true,
      description: 'URL containing openrouter.ai anywhere in string should match',
    },
    {
      name: 'url: without openrouter.ai string',
      event: { payload: { model: 'qwen/coder' }, url: 'https://example.com/api' },
      ctx: {},
      expected: false,
      description: 'URL without openrouter.ai should not be detected',
    },

    // Provider name signal (Pi coding agent uses "openrouter" provider)
    {
      name: 'provider name: event-level string "openrouter"',
      event: { payload: { model: 'claude-3' }, provider: 'openrouter' },
      ctx: {},
      expected: true,
      description: 'Provider name "openrouter" as string should be detected',
    },
    {
      name: 'provider name: payload string "openrouter"',
      event: { payload: { model: 'claude-3', provider: 'openrouter' } },
      ctx: {},
      expected: true,
      description: 'Provider name "openrouter" in payload should be detected',
    },
    {
      name: 'provider name: event-level object name "openrouter"',
      event: { payload: { model: 'claude-3' }, provider: { name: 'openrouter' } },
      ctx: {},
      expected: true,
      description: 'Provider object with name "openrouter" should be detected',
    },
    {
      name: 'provider name: payload object name "openrouter"',
      event: { payload: { model: 'claude-3', provider: { name: 'openrouter' } } },
      ctx: {},
      expected: true,
      description: 'Provider object in payload with name "openrouter" should be detected',
    },
    {
      name: 'provider name: different provider name',
      event: { payload: { model: 'claude-3', provider: 'anthropic' } },
      ctx: {},
      expected: false,
      description: 'Different provider name should not be detected',
    },
    {
      name: 'provider name: similar but not exact',
      event: { payload: { model: 'claude-3', provider: 'openrouter-proxy' } },
      ctx: {},
      expected: false,
      description: 'Provider name containing but not exactly "openrouter" should not match',
    },
    {
      name: 'url: contains openrouter.ai in path (duplicate coverage)',
      event: {
        payload: { model: 'qwen/coder' },
        url: 'https://proxy.example.com/v1/openrouter.ai/endpoint',
      },
      ctx: {},
      expected: true,
      description: 'URL containing openrouter.ai anywhere in string should match',
    },
    {
      name: 'url: without openrouter.ai string (duplicate coverage)',
      event: { payload: { model: 'qwen/coder' }, url: 'https://example.com/api' },
      ctx: {},
      expected: false,
      description: 'URL without openrouter.ai should not be detected',
    },

    // Edge cases - missing all detection signals
    {
      name: 'edge: empty event',
      event: {},
      ctx: {},
      expected: false,
      description: 'Empty event should not be detected',
    },
    {
      name: 'edge: payload only with no model',
      event: { payload: { messages: [] } },
      ctx: {},
      expected: false,
      description: 'Event with payload but no model should not be detected',
    },
    {
      name: 'edge: null model',
      event: { payload: { model: null } },
      ctx: {},
      expected: false,
      description: 'Null model should be handled as string "null" and not match',
    },
    {
      name: 'edge: undefined model',
      event: { payload: {} },
      ctx: {},
      expected: false,
      description: 'Undefined model should not crash and not be detected',
    },

    // turn_end specific - simulating real turn_end event structure
    {
      name: 'turn_end style: url at event level with resolved model',
      event: {
        type: 'turn_end',
        payload: { model: 'qwen/qwen3-coder-next', responseId: 'gen-123' },
        url: 'https://openrouter.ai/api/v1/chat/completions',
        message: { model: 'qwen/qwen3-coder-next', usage: {} },
      },
      ctx: {},
      expected: true,
      description: 'turn_end event structure with URL should be detected',
    },
    {
      name: 'turn_end style: no url but endpoint',
      event: {
        type: 'turn_end',
        payload: { model: 'moonshotai/kimi-k2.5' },
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      },
      ctx: {},
      expected: true,
      description: 'turn_end with endpoint instead of url should be detected',
    },
    {
      name: 'turn_end style: no url or endpoint (would fail)',
      event: {
        type: 'turn_end',
        payload: { model: 'moonshotai/kimi-k2.5' },
      },
      ctx: {},
      expected: false,
      description: 'turn_end without URL/endpoint and without openrouter/ prefix would fail',
    },

    // Multiple signals at once
    {
      name: 'multi: all signals satisfied',
      event: {
        payload: { model: 'openrouter/anthropic/claude-3' },
        url: 'https://openrouter.ai/api/v1/chat',
        provider: { zdr: true },
      },
      ctx: { model: { baseUrl: 'https://openrouter.ai/api/v1' } },
      expected: true,
      description: 'All detection signals satisfied should return true',
    },
    {
      name: 'multi: only url signal satisfied',
      event: {
        payload: { model: 'any-model-name' },
        url: 'https://openrouter.ai/api/v1',
      },
      ctx: {},
      expected: true,
      description: 'Only URL signal satisfied should be sufficient',
    },
    {
      name: 'multi: only context baseUrl signal satisfied',
      event: { payload: { model: 'any-model' } },
      ctx: { model: { baseUrl: 'https://openrouter.ai/api/v1' } },
      expected: true,
      description: 'Only context baseUrl signal satisfied should be sufficient',
    },
    {
      name: 'multi: only ZDR provider signal satisfied',
      event: {
        payload: { model: 'any-model' },
        provider: { zdr: true },
      },
      ctx: {},
      expected: true,
      description: 'Only ZDR provider signal satisfied should be sufficient',
    },

    // Cache mismatch - model appears openrouter but URL doesn't (edge case)
    {
      name: 'edge: model says openrouter but URL says different',
      event: {
        payload: { model: 'openrouter/anthropic/claude-3' },
        url: 'https://api.anthropic.com/v1/messages',
      },
      expected: true,
      description: 'Model prefix takes precedence - should still detect as OpenRouter',
    },
  ];

  // Run all parameterized tests
  for (const testCase of detectionCases) {
    it(testCase.name, () => {
      const result = isOpenRouterRequest(testCase.event as any, testCase.ctx as any);
      expect(result).toBe(testCase.expected);
    });
  }
});
