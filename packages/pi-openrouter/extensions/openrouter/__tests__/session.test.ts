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

// Helper to create mock event
function createEvent(
  payload: Record<string, unknown>,
  url?: string,
  provider?: Record<string, unknown>,
) {
  const event: any = { payload };
  if (url) event.url = url;
  if (provider) event.provider = provider;
  return event;
}

// Helper to create mock context
function createContext(model: string | Record<string, unknown>) {
  return { model } as any;
}

describe('isOpenRouterRequest', () => {
  // Method 1: Check model string (e.g., "openrouter/anthropic/claude-3.5-sonnet")
  it('detects OpenRouter by model prefix', () => {
    const event = createEvent({ model: 'openrouter/anthropic/claude-sonnet-4' });
    expect(isOpenRouterRequest(event, {})).toBe(true);
  });

  it('does not detect non-OpenRouter by model prefix', () => {
    const event = createEvent({ model: 'anthropic/claude-sonnet-4' });
    expect(isOpenRouterRequest(event, {})).toBe(false);
  });

  // Method 2: Check baseUrl from context.model
  it('detects OpenRouter by baseUrl', () => {
    const event = createEvent({ model: 'qwen/qwen3-coder-next' });
    const ctx = createContext({ baseUrl: 'https://openrouter.ai/api/v1' });
    expect(isOpenRouterRequest(event, ctx)).toBe(true);
  });

  it('does not detect non-OpenRouter by baseUrl', () => {
    const event = createEvent({ model: 'qwen/qwen3-coder-next' });
    const ctx = createContext({ baseUrl: 'https://api.anthropic.com' });
    expect(isOpenRouterRequest(event, ctx)).toBe(false);
  });

  // Method 3: Check for ZDR provider (Shopify routes to OpenRouter via ZDR)
  it('detects OpenRouter by ZDR provider', () => {
    const event = createEvent({ model: 'qwen/qwen3-coder-next' }, undefined, { zdr: true });
    expect(isOpenRouterRequest(event, {})).toBe(true);
  });

  it('does not detect non-ZDR provider', () => {
    // Use provider name that won't match Method 5 (not "openrouter")
    const event = createEvent({ model: 'qwen/qwen3-coder-next', provider: 'anthropic' });
    expect(isOpenRouterRequest(event, {})).toBe(false);
  });

  // Method 4: Check URL
  it('detects OpenRouter by URL', () => {
    const event = createEvent(
      { model: 'anthropic/claude-sonnet_4', messages: [] },
      'https://openrouter.ai/api/v1/chat/completions',
    );
    expect(isOpenRouterRequest(event, {})).toBe(true);
  });

  it('does not detect non-OpenRouter by URL', () => {
    const event = createEvent(
      { model: 'anthropic/claude-sonnet_4', messages: [] },
      'https://api.anthropic.com/v1/messages',
    );
    expect(isOpenRouterRequest(event, {})).toBe(false);
  });

  // Combined methods
  it('detects by multiple methods simultaneously', () => {
    const event = createEvent(
      { model: 'openrouter/anthropic/claude-sonnet-4' },
      'https://openrouter.ai/api/v1/chat/completions',
    );
    const ctx = createContext({ baseUrl: 'https://openrouter.ai/api/v1' });
    expect(isOpenRouterRequest(event, ctx)).toBe(true);
  });

  // =============================================================================
  // Parameterized Tests - All Detection Methods
  // =============================================================================

  const detectionCases: DetectionTestCase[] = [
    // Method 1: Model string prefix
    {
      name: 'method1: openrouter/ prefix',
      event: { payload: { model: 'openrouter/anthropic/claude-3' } },
      ctx: {},
      expected: true,
      description: 'Model with openrouter/ prefix should be detected',
    },
    {
      name: 'method1: no prefix - should fail',
      event: { payload: { model: 'anthropic/claude-3' } },
      ctx: {},
      expected: false,
      description: 'Model without openrouter/ prefix should not be detected by method 1',
    },
    {
      name: 'method1: similar but not prefix',
      event: { payload: { model: 'my-openrouter-model' } },
      ctx: {},
      expected: false,
      description: 'Model containing openrouter but not as prefix should not match',
    },

    // Method 2: baseUrl in context.model
    {
      name: 'method2: baseUrl contains openrouter.ai',
      event: { payload: { model: 'qwen/coder' } },
      ctx: { model: { baseUrl: 'https://openrouter.ai/api/v1' } },
      expected: true,
      description: 'Context with openrouter.ai baseUrl should be detected',
    },
    {
      name: 'method2: different baseUrl',
      event: { payload: { model: 'claude-3' } },
      ctx: { model: { baseUrl: 'https://api.anthropic.com' } },
      expected: false,
      description: 'Non-OpenRouter baseUrl should not be detected',
    },
    {
      name: 'method2: missing baseUrl',
      event: { payload: { model: 'claude-3' } },
      ctx: { model: {} },
      expected: false,
      description: 'Missing baseUrl should not be detected by method 2',
    },
    {
      name: 'method2: no model in context',
      event: { payload: { model: 'claude-3' } },
      ctx: {},
      expected: false,
      description: 'Empty context should not crash method 2',
    },

    // Method 3: ZDR provider
    {
      name: 'method3: ZDR provider flag',
      event: { payload: { model: 'qwen/coder' }, provider: { zdr: true } },
      ctx: {},
      expected: true,
      description: 'Provider with zdr: true should be detected',
    },
    {
      name: 'method3: non-ZDR provider',
      event: { payload: { model: 'qwen/coder' }, provider: { zdr: false } },
      ctx: {},
      expected: false,
      description: 'Provider with zdr: false should not be detected',
    },
    {
      name: 'method3: no provider object',
      event: { payload: { model: 'qwen/coder' } },
      ctx: {},
      expected: false,
      description: 'Missing provider should not be detected by method 3',
    },

    // Method 4: URL check
    {
      name: 'method4: url contains openrouter.ai',
      event: { payload: { model: 'qwen/coder' }, url: 'https://openrouter.ai/api/v1/chat' },
      ctx: {},
      expected: true,
      description: 'URL containing openrouter.ai should be detected',
    },
    {
      name: 'method4: endpoint property (alternative to url)',
      event: { payload: { model: 'qwen/coder' }, endpoint: 'https://openrouter.ai/api/v1/chat' },
      ctx: {},
      expected: true,
      description: 'Endpoint property should also be checked (fallback to url)',
    },
    {
      name: 'method4: non-OpenRouter url',
      event: { payload: { model: 'qwen/coder' }, url: 'https://api.anthropic.com/v1/messages' },
      ctx: {},
      expected: false,
      description: 'Non-OpenRouter URL should not be detected',
    },
    {
      name: 'method4: url with openrouter.ai in path (not just domain)',
      event: {
        payload: { model: 'qwen/coder' },
        url: 'https://proxy.example.com/v1/openrouter.ai/endpoint',
      },
      ctx: {},
      expected: true,
      description: 'URL containing openrouter.ai anywhere in string should match',
    },
    {
      name: 'method4: url without openrouter.ai string',
      event: { payload: { model: 'qwen/coder' }, url: 'https://example.com/api' },
      ctx: {},
      expected: false,
      description: 'URL without openrouter.ai should not be detected',
    },

    // Method 5: Provider name check (Pi coding agent uses "openrouter" provider)
    {
      name: 'method5: provider as string "openrouter" at event level',
      event: { payload: { model: 'claude-3' }, provider: 'openrouter' },
      ctx: {},
      expected: true,
      description: 'Provider name "openrouter" as string should be detected',
    },
    {
      name: 'method5: provider as string "openrouter" in payload',
      event: { payload: { model: 'claude-3', provider: 'openrouter' } },
      ctx: {},
      expected: true,
      description: 'Provider name "openrouter" in payload should be detected',
    },
    {
      name: 'method5: provider object with name "openrouter"',
      event: { payload: { model: 'claude-3' }, provider: { name: 'openrouter' } },
      ctx: {},
      expected: true,
      description: 'Provider object with name "openrouter" should be detected',
    },
    {
      name: 'method5: provider in payload with object name',
      event: { payload: { model: 'claude-3', provider: { name: 'openrouter' } } },
      ctx: {},
      expected: true,
      description: 'Provider object in payload with name "openrouter" should be detected',
    },
    {
      name: 'method5: different provider name',
      event: { payload: { model: 'claude-3', provider: 'anthropic' } },
      ctx: {},
      expected: false,
      description: 'Different provider name should not be detected',
    },
    {
      name: 'method5: similar but not exact provider name',
      event: { payload: { model: 'claude-3', provider: 'openrouter-proxy' } },
      ctx: {},
      expected: false,
      description: 'Provider name containing but not exactly "openrouter" should not match',
    },
    {
      name: 'method4: url with openrouter.ai in path (not just domain)',
      event: {
        payload: { model: 'qwen/coder' },
        url: 'https://proxy.example.com/v1/openrouter.ai/endpoint',
      },
      ctx: {},
      expected: true,
      description: 'URL containing openrouter.ai anywhere in string should match',
    },
    {
      name: 'method4: url without openrouter.ai string',
      event: { payload: { model: 'qwen/coder' }, url: 'https://example.com/api' },
      ctx: {},
      expected: false,
      description: 'URL without openrouter.ai should not be detected',
    },

    // Edge cases - missing all detection methods
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

    // Multiple methods at once
    {
      name: 'multi: all methods satisfied',
      event: {
        payload: { model: 'openrouter/anthropic/claude-3' },
        url: 'https://openrouter.ai/api/v1/chat',
        provider: { zdr: true },
      },
      ctx: { model: { baseUrl: 'https://openrouter.ai/api/v1' } },
      expected: true,
      description: 'All detection methods satisfied should return true',
    },
    {
      name: 'multi: only method 4 (url) satisfied',
      event: {
        payload: { model: 'any-model-name' },
        url: 'https://openrouter.ai/api/v1',
      },
      ctx: {},
      expected: true,
      description: 'Only URL method satisfied should be sufficient',
    },
    {
      name: 'multi: only method 2 (baseUrl) satisfied',
      event: { payload: { model: 'any-model' } },
      ctx: { model: { baseUrl: 'https://openrouter.ai/api/v1' } },
      expected: true,
      description: 'Only baseUrl method satisfied should be sufficient',
    },
    {
      name: 'multi: only method 3 (zdr) satisfied',
      event: {
        payload: { model: 'any-model' },
        provider: { zdr: true },
      },
      ctx: {},
      expected: true,
      description: 'Only ZDR method satisfied should be sufficient',
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
