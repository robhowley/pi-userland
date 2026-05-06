import { describe, it, expect } from 'vitest';
import { isOpenRouterRequest, formatSessionId } from '../session.js';

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
    const event = createEvent({ model: 'qwen/qwen3-coder-next', provider: 'openrouter' });
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
});
