import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  stopBackgroundRefresh: vi.fn(),
  isOpenRouterRequest: vi.fn(),
  writeLocalUsage: vi.fn(),
  loadCache: vi.fn(),
  getCacheAgeMs: vi.fn(),
  formatDuration: vi.fn(),
  mapOpenRouterModels: vi.fn(),
  filterModelsForCatalogMode: vi.fn(),
  includeBuiltinRouterModels: vi.fn(),
  isSyncEnabled: vi.fn(),
  setActiveCatalogState: vi.fn(),
  loadOpenRouterStatusBar: vi.fn(),
  isStatusEnabled: vi.fn(),
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
  filterModelsForCatalogMode: mocks.filterModelsForCatalogMode,
  includeBuiltinRouterModels: mocks.includeBuiltinRouterModels,
  isSyncEnabled: mocks.isSyncEnabled,
  setActiveCatalogState: mocks.setActiveCatalogState,
}));

vi.mock('../status-bar.js', () => ({
  loadOpenRouterStatusBar: mocks.loadOpenRouterStatusBar,
}));

vi.mock('../config.js', () => ({
  isStatusEnabled: mocks.isStatusEnabled,
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

function createMockContext(
  overrides: { cwd?: string; hasUI?: boolean; projectTrusted?: boolean } = {},
) {
  const ctx = {
    cwd: overrides.cwd ?? '/repo',
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

  if (overrides.projectTrusted !== undefined) {
    ctx.isProjectTrusted = vi.fn(() => overrides.projectTrusted);
  }

  return ctx;
}

function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function loadHooksModule() {
  return import('../hooks.js');
}

describe('openrouter hooks', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.useRealTimers();

    mocks.isOpenRouterRequest.mockReturnValue(true);
    mocks.writeLocalUsage.mockResolvedValue(undefined);
    mocks.loadCache.mockResolvedValue(null);
    mocks.getCacheAgeMs.mockReturnValue(60000);
    mocks.formatDuration.mockReturnValue('1 minute');
    mocks.mapOpenRouterModels.mockResolvedValue({
      configs: [{ id: 'model-a' }],
      skipped: 0,
      skippedDetails: [],
    });
    mocks.filterModelsForCatalogMode.mockImplementation((models: Array<{ id: string }>) => models);
    mocks.includeBuiltinRouterModels.mockReturnValue([{ id: 'model-a' }, { id: 'router' }]);
    mocks.isSyncEnabled.mockReturnValue(true);
    mocks.loadOpenRouterStatusBar.mockResolvedValue({ kind: 'empty' });
    mocks.isStatusEnabled.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads cached startup models, respects cached mode, and seeds active catalog state', async () => {
    const { pi } = createMockPi();
    const { loadStartupCacheState } = await loadHooksModule();

    mocks.loadCache.mockResolvedValue({
      catalogMode: 'full',
      models: [{ id: 'cached/model-a' }],
      skippedDetails: [],
      timestamp: Date.now() - 60000,
    });

    const startupState = await loadStartupCacheState(pi as any);

    expect(mocks.filterModelsForCatalogMode).toHaveBeenCalledWith(
      [{ id: 'cached/model-a' }],
      'full',
    );
    expect(mocks.includeBuiltinRouterModels).toHaveBeenCalledWith([{ id: 'model-a' }], 'full');
    expect(pi.registerProvider).toHaveBeenCalledWith('openrouter', {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'OPENROUTER_API_KEY',
      api: 'openai-completions',
      models: [{ id: 'model-a' }, { id: 'router' }],
      authHeader: true,
    });
    expect(mocks.setActiveCatalogState).toHaveBeenCalledWith({
      mode: 'full',
      registeredModelIds: ['model-a', 'router'],
      registeredCount: 2,
      skippedCount: 0,
      skippedDetails: [],
      source: 'cache',
      cacheAgeMs: 60000,
    });
    expect(startupState).toEqual({
      info: {
        count: 2,
        age: '1 minute',
      },
    });
  });

  it('loads cached free-only startup models with free-only router injection only', async () => {
    const { pi } = createMockPi();
    const { loadStartupCacheState } = await loadHooksModule();

    mocks.loadCache.mockResolvedValue({
      catalogMode: 'free-only',
      models: [{ id: 'cached/model-a:free' }],
      skippedDetails: [{ id: 'bad/model:free', reason: 'missing context window' }],
      timestamp: Date.now() - 60000,
    });
    mocks.mapOpenRouterModels.mockResolvedValue({
      configs: [{ id: 'cached/model-a:free' }],
      skipped: 1,
      skippedDetails: [{ id: 'bad/model:free', reason: 'missing context window' }],
    });
    mocks.includeBuiltinRouterModels.mockReturnValue([
      { id: 'cached/model-a:free' },
      { id: 'openrouter/free' },
    ]);

    const startupState = await loadStartupCacheState(pi as any);

    expect(mocks.filterModelsForCatalogMode).toHaveBeenCalledWith(
      [{ id: 'cached/model-a:free' }],
      'free-only',
    );
    expect(mocks.includeBuiltinRouterModels).toHaveBeenCalledWith(
      [{ id: 'cached/model-a:free' }],
      'free-only',
    );
    expect(mocks.setActiveCatalogState).toHaveBeenCalledWith({
      mode: 'free-only',
      registeredModelIds: ['cached/model-a:free', 'openrouter/free'],
      registeredCount: 2,
      skippedCount: 1,
      skippedDetails: [{ id: 'bad/model:free', reason: 'missing context window' }],
      source: 'cache',
      cacheAgeMs: 60000,
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
      catalogMode: 'free-only',
      models: [{ id: 'cached/model-a:free' }],
      skippedDetails: [],
      timestamp: Date.now() - 60000,
    });
    mocks.mapOpenRouterModels.mockRejectedValue(new Error('mapper failed'));

    const startupState = await loadStartupCacheState(pi as any);

    expect(mocks.filterModelsForCatalogMode).toHaveBeenCalledWith(
      [{ id: 'cached/model-a:free' }],
      'free-only',
    );
    expect(pi.registerProvider).not.toHaveBeenCalled();
    expect(mocks.setActiveCatalogState).not.toHaveBeenCalled();
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

  it('sets startup usage status from the local burn-rate helper and keeps cache notifications', async () => {
    const { handlers, pi } = createMockPi();
    const ctx = createMockContext();
    const { initializeSessionState, installOpenRouterHooks } = await loadHooksModule();

    mocks.loadOpenRouterStatusBar.mockResolvedValue({
      kind: 'ready',
      text: 'OR $2.14 today · 1.3x 30d avg',
    });

    initializeSessionState();
    installOpenRouterHooks(pi as any, {
      info: { count: 5, age: '3 minutes' },
    });

    await handlers.get('session_start')({ reason: 'startup' }, ctx);

    expect(mocks.loadOpenRouterStatusBar).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        'openrouter',
        'dim:OR $2.14 today · 1.3x 30d avg',
      );
    });
    expect(String(ctx.ui.setStatus.mock.calls[0]?.[1] ?? '')).not.toContain('models');
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      'OpenRouter: 5 models loaded from cache (3 minutes old). Run /openrouter models-sync to refresh.',
      'info',
    );
  });

  it('clears the footer status without loading local spend when status is disabled', async () => {
    const { handlers, pi } = createMockPi();
    const ctx = createMockContext({ projectTrusted: false });
    const { initializeSessionState, installOpenRouterHooks } = await loadHooksModule();

    mocks.isStatusEnabled.mockReturnValue(false);
    mocks.loadOpenRouterStatusBar.mockResolvedValue({
      kind: 'ready',
      text: 'OR $2.14 today · 1.3x 30d avg',
    });

    initializeSessionState();
    installOpenRouterHooks(pi as any, {});

    await handlers.get('session_start')({ reason: 'startup' }, ctx);

    expect(mocks.isStatusEnabled).toHaveBeenCalledWith('/repo', false);
    expect(mocks.loadOpenRouterStatusBar).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).toHaveBeenCalledWith('openrouter', undefined);
  });

  it('clears stale startup status asynchronously when cached models exist but local spend is empty', async () => {
    const { handlers, pi } = createMockPi();
    const ctx = createMockContext();
    const { initializeSessionState, installOpenRouterHooks } = await loadHooksModule();
    const statusLoad = createDeferredPromise<{ kind: 'ready'; text: string } | { kind: 'empty' }>();

    mocks.loadOpenRouterStatusBar.mockReturnValue(statusLoad.promise);

    initializeSessionState();
    installOpenRouterHooks(pi as any, {
      info: { count: 5, age: '3 minutes' },
    });

    await handlers.get('session_start')({ reason: 'startup' }, ctx);

    expect(mocks.loadOpenRouterStatusBar).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      'OpenRouter: 5 models loaded from cache (3 minutes old). Run /openrouter models-sync to refresh.',
      'info',
    );
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();

    statusLoad.resolve({ kind: 'empty' });

    await vi.waitFor(() => {
      expect(ctx.ui.setStatus).toHaveBeenCalledWith('openrouter', undefined);
    });
    expect(ctx.ui.theme.fg).not.toHaveBeenCalled();
  });

  it('preserves the existing startup status when the usage helper fails open', async () => {
    const { handlers, pi } = createMockPi();
    const ctx = createMockContext();
    const { initializeSessionState, installOpenRouterHooks } = await loadHooksModule();

    mocks.loadOpenRouterStatusBar.mockResolvedValue({ kind: 'failed' });

    initializeSessionState();
    installOpenRouterHooks(pi as any, {
      warning: 'OpenRouter: cached models found but failed to register: mapper failed',
    });

    await handlers.get('session_start')({ reason: 'startup' }, ctx);

    expect(mocks.loadOpenRouterStatusBar).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      'OpenRouter: cached models found but failed to register: mapper failed',
      'warning',
    );
    await Promise.resolve();
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(ctx.ui.theme.fg).not.toHaveBeenCalled();
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

  it('refreshes the usage status after a successful OpenRouter turn_end local write without blocking the hook', async () => {
    const { handlers, pi } = createMockPi();
    const ctx = createMockContext();
    const { initializeSessionState, installOpenRouterHooks } = await loadHooksModule();
    const randomUuidSpy = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue('11111111-1111-4111-8111-111111111111');
    const writeLocalUsageDeferred = createDeferredPromise<void>();

    mocks.writeLocalUsage.mockReturnValue(writeLocalUsageDeferred.promise);
    mocks.loadOpenRouterStatusBar.mockResolvedValue({
      kind: 'ready',
      text: 'OR $1.25 today · 30.0x 30d avg',
    });

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
    expect(mocks.loadOpenRouterStatusBar).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();

    writeLocalUsageDeferred.resolve();

    await vi.waitFor(() => {
      expect(mocks.loadOpenRouterStatusBar).toHaveBeenCalledTimes(1);
    });
    const writeCallOrder = mocks.writeLocalUsage.mock.invocationCallOrder[0] ?? 0;
    const refreshCallOrder = mocks.loadOpenRouterStatusBar.mock.invocationCallOrder[0] ?? 0;
    expect(writeCallOrder).toBeLessThan(refreshCallOrder);
    await vi.waitFor(() => {
      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        'openrouter',
        'dim:OR $1.25 today · 30.0x 30d avg',
      );
    });
    expect(String(ctx.ui.setStatus.mock.calls[0]?.[1] ?? '')).not.toContain('models');

    randomUuidSpy.mockRestore();
  });

  it('still writes local usage after a turn when status is disabled', async () => {
    const { handlers, pi } = createMockPi();
    const ctx = createMockContext();
    const { initializeSessionState, installOpenRouterHooks } = await loadHooksModule();
    const randomUuidSpy = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue('22222222-2222-4222-8222-222222222222');

    mocks.isStatusEnabled.mockReturnValue(false);
    mocks.loadOpenRouterStatusBar.mockResolvedValue({
      kind: 'ready',
      text: 'OR $9.99 today · 9.9x 30d avg',
    });

    initializeSessionState();
    installOpenRouterHooks(pi as any, {});

    await handlers.get('turn_end')(
      {
        url: 'https://openrouter.ai/api/v1/chat/completions',
        message: {
          model: 'openrouter/anthropic/claude-sonnet-4',
          responseId: 'resp-disabled',
          usage: {
            input: 4,
            output: 2,
            cost: { total: 0.42 },
          },
        },
      },
      ctx,
    );

    expect(mocks.writeLocalUsage).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(ctx.ui.setStatus).toHaveBeenCalledWith('openrouter', undefined);
    });
    expect(mocks.loadOpenRouterStatusBar).not.toHaveBeenCalled();

    randomUuidSpy.mockRestore();
  });

  it('does not write local usage or update status for non-OpenRouter turns', async () => {
    const { handlers, pi } = createMockPi();
    const ctx = createMockContext();
    const { initializeSessionState, installOpenRouterHooks } = await loadHooksModule();

    mocks.isOpenRouterRequest.mockReturnValue(false);
    mocks.loadOpenRouterStatusBar.mockResolvedValue({
      kind: 'ready',
      text: 'OR $9.99 today · 9.9x 30d avg',
    });

    initializeSessionState();
    installOpenRouterHooks(pi as any, {});

    await handlers.get('turn_end')(
      {
        url: 'https://api.anthropic.com/v1/messages',
        message: {
          model: 'claude-sonnet-4',
          responseId: 'resp-2',
          usage: {
            input: 4,
            output: 2,
            cost: { total: 0.42 },
          },
        },
      },
      ctx,
    );

    expect(mocks.writeLocalUsage).not.toHaveBeenCalled();
    expect(mocks.loadOpenRouterStatusBar).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it('clears stale status after a turn when the usage helper reports empty local spend', async () => {
    const { handlers, pi } = createMockPi();
    const ctx = createMockContext();
    const { initializeSessionState, installOpenRouterHooks } = await loadHooksModule();

    mocks.loadOpenRouterStatusBar.mockResolvedValue({ kind: 'empty' });

    initializeSessionState();
    installOpenRouterHooks(pi as any, {});

    await handlers.get('turn_end')(
      {
        url: 'https://openrouter.ai/api/v1/chat/completions',
        message: {
          model: 'openrouter/anthropic/claude-sonnet-4',
          responseId: 'resp-3',
          usage: {
            input: 1,
            output: 1,
            cost: { total: 0.01 },
          },
        },
      },
      ctx,
    );

    await vi.waitFor(() => {
      expect(ctx.ui.setStatus).toHaveBeenCalledWith('openrouter', undefined);
    });
  });

  it('preserves the existing status after a turn when the usage helper fails open', async () => {
    const { handlers, pi } = createMockPi();
    const ctx = createMockContext();
    const { initializeSessionState, installOpenRouterHooks } = await loadHooksModule();

    mocks.loadOpenRouterStatusBar.mockResolvedValue({ kind: 'failed' });

    initializeSessionState();
    installOpenRouterHooks(pi as any, {});

    await handlers.get('turn_end')(
      {
        url: 'https://openrouter.ai/api/v1/chat/completions',
        message: {
          model: 'openrouter/anthropic/claude-sonnet-4',
          responseId: 'resp-4',
          usage: {
            input: 1,
            output: 1,
            cost: { total: 0.01 },
          },
        },
      },
      ctx,
    );

    await Promise.resolve();
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(ctx.ui.theme.fg).not.toHaveBeenCalled();
  });

  it('does not schedule the UTC-midnight rollover when status is disabled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T23:59:50.000Z'));

    const { handlers, pi } = createMockPi();
    const ctx = createMockContext();
    const { initializeSessionState, installOpenRouterHooks } = await loadHooksModule();

    mocks.isStatusEnabled.mockReturnValue(false);
    mocks.loadOpenRouterStatusBar.mockResolvedValue({
      kind: 'ready',
      text: 'OR $4.50 today · 2.0x 30d avg',
    });

    initializeSessionState();
    installOpenRouterHooks(pi as any, {});

    await handlers.get('session_start')({ reason: 'startup' }, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith('openrouter', undefined);
    expect(mocks.loadOpenRouterStatusBar).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

    expect(ctx.ui.setStatus).toHaveBeenCalledTimes(1);
    expect(mocks.loadOpenRouterStatusBar).not.toHaveBeenCalled();
  });

  it('refreshes the status at UTC midnight and reschedules while the session stays active', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T23:59:50.000Z'));

    const { handlers, pi } = createMockPi();
    const ctx = createMockContext();
    const { initializeSessionState, installOpenRouterHooks } = await loadHooksModule();

    mocks.loadOpenRouterStatusBar
      .mockResolvedValueOnce({ kind: 'ready', text: 'OR $4.50 today · 2.0x 30d avg' })
      .mockResolvedValueOnce({ kind: 'ready', text: 'OR $0.25 today · 0.2x 30d avg' })
      .mockResolvedValueOnce({ kind: 'ready', text: 'OR $0.30 today · 0.2x 30d avg' });

    initializeSessionState();
    installOpenRouterHooks(pi as any, {});

    await handlers.get('session_start')({ reason: 'startup' }, ctx);

    await vi.waitFor(() => {
      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        'openrouter',
        'dim:OR $4.50 today · 2.0x 30d avg',
      );
    });
    expect(mocks.loadOpenRouterStatusBar).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);

    await vi.waitFor(() => {
      expect(mocks.loadOpenRouterStatusBar).toHaveBeenCalledTimes(2);
    });
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
      'openrouter',
      'dim:OR $0.25 today · 0.2x 30d avg',
    );

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

    await vi.waitFor(() => {
      expect(mocks.loadOpenRouterStatusBar).toHaveBeenCalledTimes(3);
    });
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
      'openrouter',
      'dim:OR $0.30 today · 0.2x 30d avg',
    );
  });

  it('clears the UTC-midnight rollover timer on session shutdown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T23:59:50.000Z'));

    const { handlers, pi } = createMockPi();
    const ctx = createMockContext();
    const { initializeSessionState, installOpenRouterHooks } = await loadHooksModule();

    mocks.loadOpenRouterStatusBar.mockResolvedValue({
      kind: 'ready',
      text: 'OR $1.00 today · 1.0x 30d avg',
    });

    initializeSessionState();
    installOpenRouterHooks(pi as any, {});

    await handlers.get('session_start')({ reason: 'startup' }, ctx);
    await vi.waitFor(() => {
      expect(mocks.loadOpenRouterStatusBar).toHaveBeenCalledTimes(1);
    });

    handlers.get('session_shutdown')();

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

    expect(mocks.loadOpenRouterStatusBar).toHaveBeenCalledTimes(1);
    expect(mocks.stopBackgroundRefresh).toHaveBeenCalledTimes(1);
  });
});
