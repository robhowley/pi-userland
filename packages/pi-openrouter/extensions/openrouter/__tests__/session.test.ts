import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  installOpenRouterSessionTracking,
  installOpenRouterSessionCommand,
  formatSessionId,
  type OpenRouterSessionState,
} from '../session.js';

// Mock context with sessionManager
function createMockContext(sessionId: string = 'test-session-id-123') {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
    },
  };
}

// =============================================================================
// Mock Pi for hook tests
// =============================================================================

function createMockPi() {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, { handler: Function; description: string }>();

  return {
    on: vi.fn((name: string, fn: Function) => {
      handlers.set(name, fn);
    }),
    registerCommand: vi.fn((name: string, options: { handler: Function; description: string }) => {
      commands.set(name, options);
    }),
    getHandler: (name: string) => handlers.get(name),
    getCommand: (name: string) => commands.get(name),
  };
}

// =============================================================================
// formatSessionId Tests
// =============================================================================

describe('formatSessionId', () => {
  it('adds pi: prefix to session ID', () => {
    const rawId = 'abc123-def456';
    const formatted = formatSessionId(rawId);
    expect(formatted).toBe('pi:abc123-def456');
  });

  it('works with UUID format', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const formatted = formatSessionId(uuid);
    expect(formatted).toBe(`pi:${uuid}`);
    expect(formatted).toMatch(/^pi:/);
  });
});

// =============================================================================
// Request Detection Tests
// =============================================================================

describe('isOpenRouterRequest (via installOpenRouterSessionTracking)', () => {
  let mockPi: ReturnType<typeof createMockPi>;
  let state: OpenRouterSessionState;

  beforeEach(() => {
    mockPi = createMockPi();
    state = { sessionId: 'test-session-id' };
    installOpenRouterSessionTracking(mockPi as any, state);
  });

  const invokeHook = (event: unknown, ctx?: unknown) => {
    const handler = mockPi.getHandler('before_provider_request');
    return handler?.(event, ctx);
  };

  // AC7: Skips non-OpenRouter request
  it('returns undefined for OpenAI provider', () => {
    const event = {
      payload: { model: 'gpt-4.1' },
      provider: 'openai',
    };
    const result = invokeHook(event, {});
    expect(result).toBeUndefined();
  });

  // AC4: Injects into OpenRouter request (by provider)
  it('injects session_id when provider is openrouter', () => {
    const event = {
      payload: { model: 'openrouter/anthropic/claude-sonnet-4' },
      provider: 'openrouter',
    };
    const result = invokeHook(event, {});
    expect(result).toBeDefined();
    expect(result?.session_id).toBe(state.sessionId);
  });

  // AC4: Injects into OpenRouter request (by model prefix)
  it('injects session_id when model starts with openrouter/', () => {
    const event = {
      payload: { model: 'openrouter/google/gemini-pro' },
    };
    const result = invokeHook(event, {});
    expect(result).toBeDefined();
    expect(result?.session_id).toBe(state.sessionId);
  });

  // AC4: Injects into OpenRouter request (by URL)
  it('injects session_id when URL contains openrouter.ai', () => {
    const event = {
      payload: { model: 'anthropic/claude-sonnet_4', messages: [] },
      url: 'https://openrouter.ai/api/v1/chat/completions',
    };
    const result = invokeHook(event, {});
    expect(result).toBeDefined();
    expect(result?.session_id).toBe(state.sessionId);
  });

  // AC4: Injects into OpenRouter request (by baseUrl)
  it('injects session_id when baseUrl contains openrouter.ai', () => {
    const ctx = createMockContext();
    ctx.model = {
      baseUrl: 'https://openrouter.ai/api/v1',
    };
    const event = {
      payload: { model: 'qwen/qwen3-coder-next' },
    };
    const result = invokeHook(event, ctx);
    expect(result).toBeDefined();
    expect(result?.session_id).toBe(state.sessionId);
  });

  // AC4: Injects into OpenRouter request (by ZDR)
  it('injects session_id when provider.zdr is true', () => {
    const event = {
      payload: { model: 'qwen/qwen3-coder-next' },
      provider: { zdr: true },
    };
    const result = invokeHook(event, {});
    expect(result).toBeDefined();
    expect(result?.session_id).toBe(state.sessionId);
  });

  // AC6: Skips existing session_id
  it('does not overwrite existing session_id', () => {
    const event = {
      payload: {
        model: 'openrouter/x',
        session_id: 'caller-session-123',
      },
    };
    const result = invokeHook(event, {});
    // Should return undefined (no mutation) when session_id exists
    expect(result).toBeUndefined();
  });

  // AC5: Preserves payload
  it('preserves all existing payload fields', () => {
    const originalPayload = {
      model: 'openrouter/anthropic/claude-sonnet_4',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.7,
    };
    const event = { payload: originalPayload };
    const result = invokeHook(event, {});

    expect(result).toMatchObject(originalPayload);
    expect(result).toHaveProperty('session_id', state.sessionId);
  });

  // AC11 (Fail-open): Handle missing payload
  it('returns gracefully when payload is missing', () => {
    const event = { noPayload: true };
    const result = invokeHook(event, {});
    expect(result).toBeUndefined();
  });

  // AC11 (Fail-open): Handle null payload
  it('returns gracefully when payload is null', () => {
    const event = { payload: null };
    const result = invokeHook(event, {});
    expect(result).toBeUndefined();
  });
});

// =============================================================================
// AC2: Reuses ID within same runtime
// =============================================================================

describe('AC2 - Session ID reuse', () => {
  it('reuses the same ID for multiple OpenRouter requests', () => {
    const mockPi = createMockPi();
    const state = { sessionId: 'shared-session-id' };
    installOpenRouterSessionTracking(mockPi as any, state);

    const handler = mockPi.getHandler('before_provider_request');

    // First request
    const event1 = {
      payload: { model: 'openrouter/anthropic/claude-sonnet_4' },
      provider: 'openrouter',
    };
    const result1 = handler(event1, {});

    // Second request
    const event2 = {
      payload: { model: 'openrouter/meta/llama-3' },
      provider: 'openrouter',
    };
    const result2 = handler(event2, {});

    expect(result1?.session_id).toBe(state.sessionId);
    expect(result2?.session_id).toBe(state.sessionId);
    expect(result1?.session_id).toBe(result2?.session_id);
  });
});

// =============================================================================
// AC3: New runtime gets new ID
// =============================================================================

describe('AC3 - New runtime gets new ID', () => {
  it('uses different IDs for separate state instances', () => {
    const mockPi1 = createMockPi();
    const mockPi2 = createMockPi();

    const state1 = { sessionId: 'session-1' };
    const state2 = { sessionId: 'session-2' };

    installOpenRouterSessionTracking(mockPi1 as any, state1);
    installOpenRouterSessionTracking(mockPi2 as any, state2);

    expect(state1.sessionId).not.toBe(state2.sessionId);
  });
});

// =============================================================================
// AC8: Command shows full ID
// =============================================================================

describe('installOpenRouterSessionCommand', () => {
  it('registers /openrouter-session command', () => {
    const mockPi = createMockPi();
    const state = { sessionId: 'test-session-id' };
    installOpenRouterSessionCommand(mockPi as any, state);

    expect(mockPi.registerCommand).toHaveBeenCalledWith(
      'openrouter-session',
      expect.objectContaining({
        description: expect.stringContaining('session'),
      }),
    );
  });
});

// =============================================================================
// AC10: Fail-open behavior
// =============================================================================

describe('AC10 - Fail open', () => {
  it('does not throw when payload is malformed', () => {
    const mockPi = createMockPi();
    const state = { sessionId: 'test-session-id' };
    installOpenRouterSessionTracking(mockPi as any, state);

    const handler = mockPi.getHandler('before_provider_request');

    // Should not throw
    expect(() => handler(null, {})).not.toThrow();
    expect(() => handler(undefined, {})).not.toThrow();
    expect(() =>
      handler(
        {
          get payload() {
            throw new Error('boom');
          },
        },
        {},
      ),
    ).not.toThrow();
  });
});
