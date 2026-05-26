import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  stopBackgroundRefresh: vi.fn(),
  isOpenRouterRequest: vi.fn(),
  writeLocalUsage: vi.fn(),
  loadCache: vi.fn(),
  getCacheAgeMs: vi.fn(),
  formatDuration: vi.fn(),
  mapOpenRouterModels: vi.fn(),
  includeBuiltinRouterModels: vi.fn(),
  isSyncEnabled: vi.fn(),
}));

vi.mock('../cache.js', () => ({
  stopBackgroundRefresh: mocks.stopBackgroundRefresh,
}));

vi.mock('../session.js', () => ({
  isOpenRouterRequest: mocks.isOpenRouterRequest,
  formatSessionId: (value: string) => `pi:${value}`,
}));

vi.mock('../local-usage.js', () => ({
  writeLocalUsage: mocks.writeLocalUsage,
}));

vi.mock('../models/cache.js', () => ({
  loadCache: mocks.loadCache,
  getCacheAgeMs: mocks.getCacheAgeMs,
  formatDuration: mocks.formatDuration,
}));

vi.mock('../models/mapper.js', () => ({
  mapOpenRouterModels: mocks.mapOpenRouterModels,
}));

vi.mock('../models/sync.js', () => ({
  includeBuiltinRouterModels: mocks.includeBuiltinRouterModels,
  isSyncEnabled: mocks.isSyncEnabled,
}));

function createMockPi() {
  const handlers = new Map<string, any>();
  return {
    handlers,
    pi: {
      on: vi.fn((event: string, handler: unknown) => {
        handlers.set(event, handler);
      }),
      registerProvider: vi.fn(),
    },
  };
}

function createMockContext(overrides: { hasUI?: boolean } = {}) {
  return {
    hasUI: overrides.hasUI ?? true,
    sessionManager: {
      getSessionId: vi.fn(() => 'session-123'),
    },
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      theme: {
        fg: vi.fn((_style: string, text: string) => `dim:${text}`),
      },
    },
  } as any;
}

async function loadHooksModule() {
  return import('../hooks.js');
}

describe('openrouter hooks', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();

    mocks.isOpenRouterRequest.mockReturnValue(true);
    mocks.writeLocalUsage.mockResolvedValue(undefined);
    mocks.loadCache.mockResolvedValue(null);
    mocks.getCacheAgeMs.mockReturnValue(60000);
    mocks.formatDuration.mockReturnValue('1 minute');
    mocks.mapOpenRouterModels.mockResolvedValue({ configs: [{ id: 'model-a' }] });
    mocks.includeBuiltinRouterModels.mockReturnValue([{ id: 'model-a' }, { id: 'router' }]);
    mocks.isSyncEnabled.mockReturnValue(true);
  });

  it('loads cached startup models and preserves startup status text', async () => {
    const { pi } = createMockPi();
    const { loadStartupCacheState } = await loadHooksModule();

    mocks.loadCache.mockResolvedValue({
      models: [{ id: 'cached/model-a' }],
      timestamp: Date.now() - 60000,
    });

    const startupState = await loadStartupCacheState(pi as any);

    expect(pi.registerProvider).toHaveBeenCalledWith('openrouter', {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'OPENROUTER_API_KEY',
      api: 'openai-completions',
      models: [{ id: 'model-a' }, { id: 'router' }],
      authHeader: true,
    });
    expect(startupState).toEqual({
      info: {
        count: 2,
        age: '1 minute',
      },
    });
  });

  it('keeps startup cache warning behavior unchanged when cached registration fails', async () => {
    const { pi } = createMockPi();
    const { loadStartupCacheState } = await loadHooksModule();

    mocks.loadCache.mockResolvedValue({
      models: [{ id: 'cached/model-a' }],
      timestamp: Date.now() - 60000,
    });
    mocks.mapOpenRouterModels.mockRejectedValue(new Error('mapper failed'));

    const startupState = await loadStartupCacheState(pi as any);

    expect(pi.registerProvider).not.toHaveBeenCalled();
    expect(startupState).toEqual({
      warning: 'OpenRouter: cached models found but failed to register: mapper failed',
    });
  });

  it('installs the session-tagging hook only once across repeated installs', async () => {
    const { pi } = createMockPi();
    const { initializeSessionState, installOpenRouterHooks } = await loadHooksModule();

    initializeSessionState();
    installOpenRouterHooks(pi as any, {});
    installOpenRouterHooks(pi as any, {});

    expect(pi.on.mock.calls.filter(([event]) => event === 'before_provider_request')).toHaveLength(
      1,
    );
    expect(pi.on.mock.calls.filter(([event]) => event === 'turn_end')).toHaveLength(2);
    expect(pi.on.mock.calls.filter(([event]) => event === 'session_start')).toHaveLength(2);
    expect(pi.on.mock.calls.filter(([event]) => event === 'session_shutdown')).toHaveLength(2);
  });

  it('keeps session_start status and startup notifications unchanged', async () => {
    const { handlers, pi } = createMockPi();
    const ctx = createMockContext();
    const { initializeSessionState, installOpenRouterHooks } = await loadHooksModule();

    initializeSessionState();
    installOpenRouterHooks(pi as any, {
      info: { count: 5, age: '3 minutes' },
    });

    handlers.get('session_start')({ reason: 'startup' }, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith('openrouter', 'dim:OpenRouter 5 models');
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      'OpenRouter: 5 models loaded from cache (3 minutes old). Run /openrouter models-sync to refresh.',
      'info',
    );
  });

  it('keeps startup warning notifications unchanged', async () => {
    const { handlers, pi } = createMockPi();
    const ctx = createMockContext();
    const { initializeSessionState, installOpenRouterHooks } = await loadHooksModule();

    initializeSessionState();
    installOpenRouterHooks(pi as any, {
      warning: 'OpenRouter: cached models found but failed to register: mapper failed',
    });

    handlers.get('session_start')({ reason: 'startup' }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      'OpenRouter: cached models found but failed to register: mapper failed',
      'warning',
    );
  });

  it('keeps before_provider_request session tagging behavior unchanged through the installed hook', async () => {
    const { handlers, pi } = createMockPi();
    const { initializeSessionState, installOpenRouterHooks } = await loadHooksModule();

    initializeSessionState();
    installOpenRouterHooks(pi as any, {});

    const result = handlers.get('before_provider_request')(
      {
        provider: 'openrouter',
        payload: {
          model: 'openrouter/anthropic/claude-sonnet-4',
          messages: [],
        },
      },
      {
        sessionManager: {
          getSessionId: () => 'session-abc',
        },
      },
    );

    expect(result).toEqual({
      model: 'openrouter/anthropic/claude-sonnet-4',
      messages: [],
      session_id: 'pi:session-abc',
    });
  });

  it('keeps turn_end local usage logging unchanged', async () => {
    const { handlers, pi } = createMockPi();
    const ctx = createMockContext();
    const { initializeSessionState, installOpenRouterHooks } = await loadHooksModule();
    const randomUuidSpy = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue('11111111-1111-4111-8111-111111111111');

    initializeSessionState();
    installOpenRouterHooks(pi as any, {});

    await handlers.get('turn_end')(
      {
        url: 'https://openrouter.ai/api/v1/chat/completions',
        message: {
          model: 'openrouter/anthropic/claude-sonnet-4',
          responseId: 'resp-1',
          usage: {
            input: 11,
            output: 7,
            cacheRead: 3,
            cacheWrite: 2,
            cost: { total: 1.25 },
          },
        },
      },
      ctx,
    );

    expect(mocks.writeLocalUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '11111111-1111-4111-8111-111111111111',
        generationId: 'resp-1',
        sessionId: 'pi:session-123',
        model: 'openrouter/anthropic/claude-sonnet-4',
        requests: 1,
        promptTokens: 11,
        completionTokens: 7,
        reasoningTokens: 0,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        cost: 1.25,
      }),
    );

    randomUuidSpy.mockRestore();
  });

  it('stops background refresh on session shutdown', async () => {
    const { handlers, pi } = createMockPi();
    const { initializeSessionState, installOpenRouterHooks } = await loadHooksModule();

    initializeSessionState();
    installOpenRouterHooks(pi as any, {});

    handlers.get('session_shutdown')();

    expect(mocks.stopBackgroundRefresh).toHaveBeenCalledTimes(1);
  });
});
