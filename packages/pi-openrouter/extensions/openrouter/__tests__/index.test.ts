import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionCtx, createOpenRouterRequest, THROW_SESSION_ID } from './fixtures.js';

describe('addSessionIdToOpenRouterRequest', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('should add session_id to OpenRouter requests', async () => {
    const { addSessionIdToOpenRouterRequest } = await import('../index.js');

    const mockCtx = createSessionCtx('stable-session-123');
    const mockEvent = createOpenRouterRequest();

    const result = addSessionIdToOpenRouterRequest(mockEvent, mockCtx);

    expect(result).toBeDefined();
    expect(result?.['session_id']).toBe('pi:stable-session-123');
    expect(result?.['model']).toBe('openrouter/anthropic/claude-sonnet-4');
  });

  it('should return same session_id for multiple OpenRouter requests in same session', async () => {
    const { addSessionIdToOpenRouterRequest } = await import('../index.js');

    const mockCtx = createSessionCtx('stable-session-123');
    const mockEvent1 = createOpenRouterRequest({
      payload: { model: 'openrouter/model-1', messages: [] },
    });
    const mockEvent2 = createOpenRouterRequest({
      payload: { model: 'openrouter/model-2', messages: [] },
    });

    const result1 = addSessionIdToOpenRouterRequest(mockEvent1, mockCtx);
    const result2 = addSessionIdToOpenRouterRequest(mockEvent2, mockCtx);

    expect(result1?.['session_id']).toBe('pi:stable-session-123');
    expect(result2?.['session_id']).toBe('pi:stable-session-123');
    expect(result1?.['session_id']).toBe(result2?.['session_id']);
  });

  it('should not overwrite existing session_id in payload', async () => {
    const { addSessionIdToOpenRouterRequest } = await import('../index.js');

    const mockCtx = createSessionCtx('new-session');
    const mockEvent = createOpenRouterRequest({
      payload: {
        model: 'openrouter/anthropic/claude-sonnet-4',
        messages: [],
        session_id: 'existing-session-id',
      },
    });

    const result = addSessionIdToOpenRouterRequest(mockEvent, mockCtx);

    expect(result).toBeUndefined();
    expect(mockEvent['payload']?.['session_id']).toBe('existing-session-id');
  });

  it('should not tag non-OpenRouter requests', async () => {
    const { addSessionIdToOpenRouterRequest } = await import('../index.js');

    const mockCtx = createSessionCtx('my-session');
    const mockEvent = createOpenRouterRequest({
      provider: 'anthropic',
      payload: {
        model: 'claude-sonnet-4',
        messages: [],
      },
    });

    const result = addSessionIdToOpenRouterRequest(mockEvent, mockCtx);

    expect(result).toBeUndefined();
  });

  it('should fail open when payload is missing', async () => {
    const { addSessionIdToOpenRouterRequest } = await import('../index.js');

    const mockCtx = createSessionCtx('my-session');
    const mockEvent = createOpenRouterRequest();
    delete mockEvent['payload'];

    const result = addSessionIdToOpenRouterRequest(mockEvent, mockCtx);

    expect(result).toBeUndefined();
  });

  it('should generate fallback UUID when session manager throws', async () => {
    const { addSessionIdToOpenRouterRequest } = await import('../index.js');

    const mockCtx = createSessionCtx(THROW_SESSION_ID);
    const mockEvent = createOpenRouterRequest({
      payload: {
        model: 'openrouter/model',
        messages: [],
      },
    });

    const result = addSessionIdToOpenRouterRequest(mockEvent, mockCtx);

    expect(result).toBeDefined();
    expect(result?.['session_id']).toMatch(
      /^pi:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('should fail open when payload getter throws', async () => {
    const { addSessionIdToOpenRouterRequest } = await import('../index.js');

    const mockCtx = createSessionCtx('my-session');
    const mockEvent = {
      provider: 'openrouter',
      get payload() {
        throw new Error('Payload getter error');
      },
    };

    const result = addSessionIdToOpenRouterRequest(mockEvent, mockCtx);
    expect(result).toBeUndefined();
  });
});

describe('default extension export', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('composes startup cache loading, hook installation, and command registration', async () => {
    const initializeSessionState = vi.fn();
    const loadStartupCacheState = vi
      .fn()
      .mockResolvedValue({ info: { count: 3, age: '1 minute' } });
    const installOpenRouterHooks = vi.fn();
    const registerOpenRouterCommands = vi.fn();

    vi.doMock('../hooks.js', () => ({
      addSessionIdToOpenRouterRequest: vi.fn(),
      getCurrentSessionId: vi.fn(),
      initializeSessionState,
      loadStartupCacheState,
      installOpenRouterHooks,
    }));
    vi.doMock('../commands.js', () => ({
      registerOpenRouterCommands,
    }));

    const { default: openRouterExtension } = await import('../index.js');
    const pi = {
      on: vi.fn(),
      registerCommand: vi.fn(),
      registerProvider: vi.fn(),
    } as any;

    await openRouterExtension(pi);

    expect(initializeSessionState).toHaveBeenCalledTimes(1);
    expect(loadStartupCacheState).toHaveBeenCalledWith(pi);
    expect(installOpenRouterHooks).toHaveBeenCalledWith(pi, {
      info: { count: 3, age: '1 minute' },
    });
    expect(registerOpenRouterCommands).toHaveBeenCalledWith(pi);
  });
});
