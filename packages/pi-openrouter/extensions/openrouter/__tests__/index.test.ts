import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('openrouter index entrypoint', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('re-exports named helpers from hooks.js', async () => {
    const addSessionIdToOpenRouterRequest = vi.fn();
    const getCurrentSessionId = vi.fn();

    vi.doMock('../hooks.js', () => ({
      addSessionIdToOpenRouterRequest,
      getCurrentSessionId,
      initializeSessionState: vi.fn(),
      loadStartupCacheState: vi.fn(),
      installOpenRouterHooks: vi.fn(),
    }));
    vi.doMock('../commands.js', () => ({
      registerOpenRouterCommands: vi.fn(),
    }));

    const index = await import('../index.js');

    expect(index.addSessionIdToOpenRouterRequest).toBe(addSessionIdToOpenRouterRequest);
    expect(index.getCurrentSessionId).toBe(getCurrentSessionId);
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
