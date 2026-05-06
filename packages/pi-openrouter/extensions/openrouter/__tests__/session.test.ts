import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createOpenRouterSessionState,
  installOpenRouterSessionTracking,
  installOpenRouterSessionCommand,
  type OpenRouterSessionState,
} from '../session.js';

// =============================================================================
// AC1: Generates valid ID
// =============================================================================

describe('createOpenRouterSessionState', () => {
  it('generates ID starting with pi:', () => {
    const state = createOpenRouterSessionState();
    expect(state.sessionId).toMatch(/^pi:/);
  });

  it('generates ID with valid UUID shape after prefix', () => {
    const state = createOpenRouterSessionState();
    const uuidPart = state.sessionId.slice(3); // Remove 'pi:' prefix

    // UUID format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    expect(uuidPart).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('generates different IDs on each call', () => {
    const state1 = createOpenRouterSessionState();
    const state2 = createOpenRouterSessionState();
    expect(state1.sessionId).not.toBe(state2.sessionId);
  });
});

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
// Request Detection Tests
// =============================================================================

describe('isOpenRouterRequest (via installOpenRouterSessionTracking)', () => {
  let mockPi: ReturnType<typeof createMockPi>;
  let state: OpenRouterSessionState;

  beforeEach(() => {
    mockPi = createMockPi();
    state = createOpenRouterSessionState();
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
    const state = createOpenRouterSessionState();
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
  it('generates different IDs for separate state instances', () => {
    const mockPi1 = createMockPi();
    const mockPi2 = createMockPi();

    const state1 = createOpenRouterSessionState();
    const state2 = createOpenRouterSessionState();

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
    const state = createOpenRouterSessionState();
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
    const state = createOpenRouterSessionState();
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
