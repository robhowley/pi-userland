import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks, overlayConstructorCalls, MockUsageOverlayComponent } = vi.hoisted(() => {
  const overlayConstructorCalls: Array<{
    summary: any;
    error: any;
    cachedMinutesAgo: any;
  }> = [];

  class MockUsageOverlayComponent {
    constructor(
      public summary: any,
      public error: any,
      public cachedMinutesAgo: any,
      public theme: any,
      public done: any,
      public requestRender: any,
    ) {
      overlayConstructorCalls.push({ summary, error, cachedMinutesAgo });
    }
    handleInput = vi.fn();
    render = vi.fn(() => '');
    invalidate = vi.fn();
    dispose = vi.fn();
  }

  return {
    overlayConstructorCalls,
    MockUsageOverlayComponent,
    mocks: {
      usageCacheGet: vi.fn(),
      usageCacheGetTimestamp: vi.fn(),
      usageCacheSet: vi.fn(),
      startBackgroundRefresh: vi.fn(),
      fetchAndAggregate: vi.fn(),
      isRateLimitError: vi.fn(),
      getCurrentSessionId: vi.fn(),
      getAllKeys: vi.fn(),
      getCurrentKey: vi.fn(),
      resolveCurrentKeyRelation: vi.fn(),
      getAccountCredits: vi.fn(),
      computeRollupStatus: vi.fn(),
      formatCurrency: vi.fn((amount: number) => `$${amount.toFixed(2)}`),
      formatRemaining: vi.fn((used: number, limit?: number) =>
        limit === undefined
          ? `$${used.toFixed(2)} / unlimited`
          : `$${used.toFixed(2)} / $${limit.toFixed(2)}`,
      ),
      sortKeys: vi.fn(),
      syncModels: vi.fn(),
      getSyncState: vi.fn(),
      getActiveCatalogState: vi.fn(),
      isSyncEnabled: vi.fn(),
      getSkipReasonsAsync: vi.fn(),
      groupSkipReasons: vi.fn(),
      loadCache: vi.fn(),
      getCacheAgeMs: vi.fn(),
      formatDuration: vi.fn(),
      loadModelOverrides: vi.fn(),
      handleModelOverrideSet: vi.fn(),
      handleModelOverrideClear: vi.fn(),
      handleModelOverrideList: vi.fn(),
      handleApiKeyCreate: vi.fn(),
      handleApiKeyDisable: vi.fn(),
      handleApiKeyEnable: vi.fn(),
    },
  };
});

vi.mock('../cache.js', () => ({
  usageCache: {
    get: mocks.usageCacheGet,
    getTimestamp: mocks.usageCacheGetTimestamp,
    set: mocks.usageCacheSet,
  },
  startBackgroundRefresh: mocks.startBackgroundRefresh,
  fetchAndAggregate: mocks.fetchAndAggregate,
  isRateLimitError: mocks.isRateLimitError,
}));

vi.mock('../client.js', () => ({
  AuthError: class AuthError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'AuthError';
    }
  },
}));

vi.mock('../hooks.js', () => ({
  getCurrentSessionId: mocks.getCurrentSessionId,
}));

vi.mock('../account-client.js', () => ({
  getAllKeys: mocks.getAllKeys,
  getCurrentKey: mocks.getCurrentKey,
  resolveCurrentKeyRelation: mocks.resolveCurrentKeyRelation,
  getAccountCredits: mocks.getAccountCredits,
}));

vi.mock('../account-format.js', () => ({
  computeRollupStatus: mocks.computeRollupStatus,
  formatCurrency: mocks.formatCurrency,
  formatRemaining: mocks.formatRemaining,
  sortKeys: mocks.sortKeys,
}));

vi.mock('../models/sync.js', () => ({
  syncModels: mocks.syncModels,
  getSyncState: mocks.getSyncState,
  getActiveCatalogState: mocks.getActiveCatalogState,
  isSyncEnabled: mocks.isSyncEnabled,
  getSkipReasonsAsync: mocks.getSkipReasonsAsync,
  groupSkipReasons: mocks.groupSkipReasons,
}));

vi.mock('../models/cache.js', () => ({
  loadCache: mocks.loadCache,
  getCacheAgeMs: mocks.getCacheAgeMs,
  formatDuration: mocks.formatDuration,
}));

vi.mock('../models/overrides.js', () => ({
  loadModelOverrides: mocks.loadModelOverrides,
}));

vi.mock('../models/override-commands.js', () => ({
  handleModelOverrideSet: mocks.handleModelOverrideSet,
  handleModelOverrideClear: mocks.handleModelOverrideClear,
  handleModelOverrideList: mocks.handleModelOverrideList,
}));

vi.mock('../api-key-commands.js', () => ({
  handleApiKeyCreate: mocks.handleApiKeyCreate,
  handleApiKeyDisable: mocks.handleApiKeyDisable,
  handleApiKeyEnable: mocks.handleApiKeyEnable,
}));

vi.mock('../overlay.js', () => ({
  UsageOverlayComponent: MockUsageOverlayComponent,
}));

import { OPENROUTER_SUBCOMMANDS, registerOpenRouterCommands } from '../commands.js';

function createMockPi() {
  const commands = new Map<string, any>();
  return {
    commands,
    pi: {
      registerCommand: vi.fn((name: string, spec: unknown) => {
        commands.set(name, spec);
      }),
    },
  };
}

function createMockContext() {
  return {
    hasUI: true,
    model: { id: 'active-model' },
    sessionManager: {
      getSessionId: vi.fn(() => 'session-123'),
    },
    ui: {
      notify: vi.fn(),
      custom: vi.fn().mockImplementation(async (callback) => {
        // Call the callback to instantiate the component for overlay tests
        try {
          const mockTui = { requestRender: vi.fn() };
          const mockTheme = {
            bold: vi.fn((text: string) => text),
            fg: vi.fn((_style: string, text: string) => text),
          };
          const mockKeybindings = {};
          const mockDone = vi.fn();
          callback(mockTui, mockTheme, mockKeybindings, mockDone);
        } catch {
          // Ignore errors in component instantiation for non-overlay tests
        }
      }),
      setStatus: vi.fn(),
      theme: {
        fg: vi.fn((_style: string, text: string) => text),
      },
    },
  } as any;
}

const keyInfo = {
  name: 'Primary',
  label: 'sk-or-v1-123',
  status: 'healthy',
  used: 10,
  remaining: 90,
  limit: 100,
  resetCadence: 'monthly',
  byok: 'incl',
  hash: 'hash-1',
  disabled: false,
  workspaceName: 'Workspace',
  spend: 10,
} as const;

function createKeyInventory(
  keys: any[] = [keyInfo],
  options: { canManageKeys?: boolean; degradedReason?: string } = {},
) {
  return {
    keys,
    canManageKeys: options.canManageKeys ?? true,
    ...(options.degradedReason ? { degradedReason: options.degradedReason } : {}),
  };
}

function createActiveCatalogState(overrides: Record<string, unknown> = {}) {
  const registeredModelIds = ['openrouter/free', 'provider/model-a:free', 'provider/model-b'];
  return {
    mode: 'full',
    registeredModelIds,
    registeredCount: registeredModelIds.length,
    skippedDetails: [],
    skippedCount: 0,
    source: 'api',
    cacheAgeMs: 0,
    ...overrides,
  };
}

describe('registerOpenRouterCommands', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    overlayConstructorCalls.length = 0;

    mocks.getCurrentSessionId.mockReturnValue('pi:session-123');
    mocks.usageCacheGet.mockReturnValue(null);
    mocks.usageCacheGetTimestamp.mockReturnValue(null);
    mocks.fetchAndAggregate.mockResolvedValue({});
    mocks.isRateLimitError.mockImplementation((error: unknown) => {
      const message = String(error).toLowerCase();
      return (
        message.includes('429') || message.includes('rate limit') || message.includes('rate-limit')
      );
    });
    mocks.getAllKeys.mockResolvedValue(createKeyInventory());
    mocks.getCurrentKey.mockResolvedValue(keyInfo);
    mocks.resolveCurrentKeyRelation.mockResolvedValue({
      kind: 'inventory-match',
      hash: keyInfo.hash,
      label: keyInfo.label,
    });
    mocks.getAccountCredits.mockResolvedValue(25);
    mocks.computeRollupStatus.mockReturnValue({ status: 'healthy', message: 'healthy' });
    mocks.sortKeys.mockImplementation((keys) => keys);
    mocks.syncModels.mockResolvedValue({ success: true, registeredCount: 3, skippedCount: 0 });
    mocks.getSyncState.mockReturnValue(null);
    mocks.getActiveCatalogState.mockReturnValue(null);
    mocks.isSyncEnabled.mockReturnValue(true);
    mocks.getSkipReasonsAsync.mockResolvedValue([]);
    mocks.groupSkipReasons.mockImplementation((reasons: Array<{ reason: string }>) =>
      reasons.reduce<Record<string, number>>((counts, reason) => {
        counts[reason.reason] = (counts[reason.reason] || 0) + 1;
        return counts;
      }, {}),
    );
    mocks.loadCache.mockResolvedValue(null);
    mocks.getCacheAgeMs.mockReturnValue(60000);
    mocks.formatDuration.mockReturnValue('1 minute');
    mocks.loadModelOverrides.mockResolvedValue({});
    mocks.handleModelOverrideSet.mockResolvedValue({ success: true, message: 'override set' });
    mocks.handleModelOverrideClear.mockResolvedValue({
      success: true,
      message: 'override cleared',
    });
    mocks.handleModelOverrideList.mockResolvedValue('override list');
    mocks.handleApiKeyCreate.mockResolvedValue({
      success: true,
      message: 'api key created\nSecret shown in secure overlay; store it now.',
      secret: 'sk-or-v1-created-secret',
    });
    mocks.handleApiKeyDisable.mockResolvedValue({ success: true, message: 'api key disabled' });
    mocks.handleApiKeyEnable.mockResolvedValue({ success: true, message: 'api key enabled' });
  });

  it('registers the expected command names and descriptions', () => {
    const { commands, pi } = createMockPi();

    registerOpenRouterCommands(pi as any);

    expect([...commands.keys()]).toEqual([
      'openrouter-usage',
      'openrouter-session',
      'openrouter-account',
      'openrouter',
    ]);
    expect(commands.get('openrouter-usage')?.description).toBe(
      'Show OpenRouter usage: caps, spend, burn rate, and model breakdowns',
    );
    expect(commands.get('openrouter-session')?.description).toBe(
      'Show the current OpenRouter session ID for request grouping',
    );
    expect(commands.get('openrouter-account')?.description).toBe(
      'Show OpenRouter account and key health',
    );
    expect(commands.get('openrouter')?.description).toBe(
      `OpenRouter commands: ${OPENROUTER_SUBCOMMANDS.join(', ')}`,
    );
  });

  it('hides hash toggle subcommands from public /openrouter completions', () => {
    const { commands, pi } = createMockPi();

    registerOpenRouterCommands(pi as any);
    const command = commands.get('openrouter');

    expect(command.getArgumentCompletions('model-')).toEqual([
      { value: 'model-override-set', label: 'model-override-set' },
      { value: 'model-override-clear', label: 'model-override-clear' },
      { value: 'model-override-list', label: 'model-override-list' },
    ]);
    expect(command.getArgumentCompletions('api-key-')).toEqual([
      { value: 'api-key-create', label: 'api-key-create' },
    ]);
    expect(command.getArgumentCompletions('zzz')).toBeNull();
    expect(OPENROUTER_SUBCOMMANDS).toEqual([
      'usage',
      'account',
      'session',
      'models-sync',
      'models-status',
      'model-override-set',
      'model-override-clear',
      'model-override-list',
      'api-key-create',
    ]);
  });

  it('routes /openrouter usage through background refresh and overlay rendering', async () => {
    const { commands, pi } = createMockPi();
    const ctx = createMockContext();

    mocks.usageCacheGet.mockReturnValue({ total: {} });
    mocks.usageCacheGetTimestamp.mockReturnValue(Date.now());

    registerOpenRouterCommands(pi as any);
    await commands.get('openrouter').handler('usage', ctx);

    expect(mocks.startBackgroundRefresh).toHaveBeenCalledTimes(1);
    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
  });

  it('routes /openrouter account to the account overlay flow', async () => {
    const { commands, pi } = createMockPi();
    const ctx = createMockContext();

    registerOpenRouterCommands(pi as any);
    await commands.get('openrouter').handler('account', ctx);

    expect(mocks.getAllKeys).toHaveBeenCalledTimes(1);
    expect(mocks.resolveCurrentKeyRelation).toHaveBeenCalledWith([keyInfo]);
    expect(mocks.getCurrentKey).not.toHaveBeenCalled();
    expect(mocks.getAccountCredits).toHaveBeenCalledTimes(1);
    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
  });

  it('passes an inventory-match relation into the overlay disable guard', async () => {
    const { commands, pi } = createMockPi();
    const ctx = createMockContext();

    const activeKey = {
      ...keyInfo,
      name: 'default-space-key',
      label: 'sk-or-v1-8ef...062',
      hash: 'hash-default-space',
      workspaceName: 'Default',
    };
    mocks.getAllKeys.mockResolvedValue(createKeyInventory([activeKey]));
    mocks.resolveCurrentKeyRelation.mockResolvedValue({
      kind: 'inventory-match',
      hash: 'hash-default-space',
      label: 'sk-or-v1-8ef...062',
    });

    registerOpenRouterCommands(pi as any);
    await commands.get('openrouter').handler('account', ctx);

    const overlayFactory = ctx.ui.custom.mock.calls[0]![0];
    const overlay = overlayFactory(
      { requestRender: vi.fn() },
      { bold: (text: string) => text, fg: (_style: string, text: string) => text },
      {},
      vi.fn(),
    );

    expect(overlay.render(120).join('\n')).toContain(
      'readonly  Cannot disable the active management key.',
    );

    overlay.dispose();
  });

  it('allows disabling inventory rows when current auth is an external provisioning key', async () => {
    const { commands, pi } = createMockPi();
    const ctx = createMockContext();

    const inventoryKey = {
      ...keyInfo,
      name: 'default-space-key',
      label: 'sk-or-v1-8ef...062',
      hash: 'hash-default-space',
      workspaceName: 'Default',
    };
    mocks.getAllKeys.mockResolvedValue(createKeyInventory([inventoryKey]));
    mocks.resolveCurrentKeyRelation.mockResolvedValue({
      kind: 'external-provisioning',
      label: 'sk-or-v1-4a0...459',
    });

    registerOpenRouterCommands(pi as any);
    await commands.get('openrouter').handler('account', ctx);

    const overlayFactory = ctx.ui.custom.mock.calls[0]![0];
    const overlay = overlayFactory(
      { requestRender: vi.fn() },
      { bold: (text: string) => text, fg: (_style: string, text: string) => text },
      {},
      vi.fn(),
    );

    expect(overlay.render(120).join('\n')).toContain('t disable');
    expect(overlay.render(120).join('\n')).not.toContain(
      'readonly  Cannot verify current key matches this row.',
    );

    overlay.dispose();
  });

  it('keeps empty key inventory distinct from management-capability fallback in the command flow', async () => {
    const { commands, pi } = createMockPi();
    const ctx = createMockContext();

    mocks.getAllKeys.mockResolvedValue(createKeyInventory([], { canManageKeys: true }));

    registerOpenRouterCommands(pi as any);
    await commands.get('openrouter').handler('account', ctx);

    expect(mocks.getCurrentKey).not.toHaveBeenCalled();
    expect(mocks.getAccountCredits).toHaveBeenCalledTimes(1);
  });

  it('routes /openrouter account through the readonly fallback when management inventory is unavailable', async () => {
    const { commands, pi } = createMockPi();
    const ctx = createMockContext();

    mocks.getAllKeys.mockResolvedValue(
      createKeyInventory([], {
        canManageKeys: false,
        degradedReason: 'management-unavailable',
      }),
    );
    mocks.getCurrentKey.mockResolvedValue({ ...keyInfo, hash: undefined } as any);

    registerOpenRouterCommands(pi as any);
    await commands.get('openrouter').handler('account', ctx);

    expect(mocks.getCurrentKey).toHaveBeenCalled();
    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);

    const overlayFactory = ctx.ui.custom.mock.calls[0]![0];
    const overlay = overlayFactory(
      { requestRender: vi.fn() },
      { bold: (text: string) => text, fg: (_style: string, text: string) => text },
      {},
      vi.fn(),
    );

    expect(overlay.render(120).join('\n')).toContain(
      'readonly  Set OPENROUTER_MANAGEMENT_KEY to toggle keys.',
    );
    expect(overlay.render(120).join('\n')).not.toContain('·  t ');

    overlay.dispose();
  });

  it('routes /openrouter session to the current session notifier', async () => {
    const { commands, pi } = createMockPi();
    const ctx = createMockContext();

    registerOpenRouterCommands(pi as any);
    await commands.get('openrouter').handler('session', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith('OpenRouter session_id\npi:session-123', 'info');
  });

  it('keeps models-sync disabled messaging unchanged', async () => {
    const { commands, pi } = createMockPi();
    const ctx = createMockContext();

    mocks.isSyncEnabled.mockReturnValue(false);

    registerOpenRouterCommands(pi as any);
    await commands.get('openrouter').handler('models-sync', ctx);

    expect(mocks.syncModels).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      'OpenRouter model sync is disabled. Set openrouterModelSync: true in ~/.pi/agent/settings.json to enable.',
      'error',
    );
  });

  it('routes full models-sync through explicit full mode and updated success copy', async () => {
    const { commands, pi } = createMockPi();
    const ctx = createMockContext();

    mocks.syncModels.mockResolvedValue({
      success: true,
      registeredCount: 9,
      skippedCount: 2,
    });

    registerOpenRouterCommands(pi as any);
    await commands.get('openrouter').handler('models-sync', ctx);

    expect(mocks.syncModels).toHaveBeenCalledWith(ctx, 'full');
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      'OpenRouter models synced\n9 registered · 2 skipped · cache age: 0m',
      'info',
    );
  });

  it('threads --free through models-sync and shows the free-only sync note', async () => {
    const { commands, pi } = createMockPi();
    const ctx = createMockContext();

    mocks.syncModels.mockResolvedValue({
      success: true,
      registeredCount: 28,
      skippedCount: 3,
    });

    registerOpenRouterCommands(pi as any);
    await commands.get('openrouter').handler('models-sync --free', ctx);

    expect(mocks.syncModels).toHaveBeenCalledWith(ctx, 'free-only');
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "OpenRouter free models synced\n28 registered · 3 skipped · cache age: 0m\n\nSelect openrouter/free for OpenRouter's built-in free router, or choose a specific :free model.",
      'info',
    );
  });

  it('shows the free-empty no-op copy exactly', async () => {
    const { commands, pi } = createMockPi();
    const ctx = createMockContext();

    mocks.syncModels.mockResolvedValue({
      success: false,
      outcome: 'no-change',
      requestedMode: 'free-only',
      catalogMode: 'full',
      registeredCount: 0,
      skippedCount: 0,
      source: 'api',
      cacheUpdated: false,
      cacheAgeMs: 0,
      error: null,
    });

    registerOpenRouterCommands(pi as any);
    await commands.get('openrouter').handler('models-sync --free', ctx);

    expect(mocks.syncModels).toHaveBeenCalledWith(ctx, 'free-only');
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      'No free OpenRouter models found\nNo model catalog changed',
      'info',
    );
  });

  it('shows grouped skipped-details hints once per reason for models-status --free in free-only mode', async () => {
    const { commands, pi } = createMockPi();
    const ctx = createMockContext();

    mocks.getActiveCatalogState.mockReturnValue(
      createActiveCatalogState({
        mode: 'free-only',
        registeredModelIds: [
          'openrouter/free',
          'provider/a:free',
          'provider/b:free',
          'provider/c:free',
          'provider/d:free',
          'provider/e:free',
          'provider/f:free',
        ],
        registeredCount: 7,
        skippedDetails: [
          {
            id: 'provider/a:free',
            reason: 'missing context window',
            hint: "Add a local contextWindow override with '/openrouter model-override-set <model-id> contextWindow=<tokens>' if the model's limit is known.",
          },
          { id: 'provider/b:free', reason: 'missing context window' },
        ],
        skippedCount: 2,
      }),
    );
    mocks.loadCache.mockResolvedValue({ models: [], timestamp: Date.now() - 60000 });
    mocks.getCacheAgeMs.mockReturnValue(60000);
    mocks.formatDuration.mockReturnValue('1m');

    registerOpenRouterCommands(pi as any);
    await commands.get('openrouter').handler('models-status --free --skipped', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "OpenRouter models healthy\n7 registered · 2 skipped · free-only catalog · cache age: 1m\n\nOpenRouter skipped models: 2\n\n2 missing context window\n  suggestion: Add a local contextWindow override with '/openrouter model-override-set <model-id> contextWindow=<tokens>' if the model's limit is known.\n- provider/a:free\n- provider/b:free\n",
      'info',
    );
  });

  it('keeps model-override-set routing and active-model refresh notice unchanged', async () => {
    const { commands, pi } = createMockPi();
    const ctx = createMockContext();

    mocks.handleModelOverrideSet.mockResolvedValue({
      success: true,
      message: 'override set',
      modelId: 'active-model',
    });

    registerOpenRouterCommands(pi as any);
    await commands
      .get('openrouter')
      .handler('model-override-set anthropic/claude-sonnet-4 maxTokens=2048', ctx);

    expect(mocks.loadModelOverrides).toHaveBeenCalledTimes(1);
    expect(mocks.handleModelOverrideSet).toHaveBeenCalledWith(
      'anthropic/claude-sonnet-4 maxTokens=2048',
      {},
    );
    expect(ctx.ui.notify).toHaveBeenNthCalledWith(1, 'override set', 'info');
    expect(ctx.ui.notify).toHaveBeenNthCalledWith(
      2,
      'Model configuration updated. Run /openrouter models-sync to apply changes to the current conversation.',
      'info',
    );
  });

  it('keeps model-override-clear failure routing unchanged', async () => {
    const { commands, pi } = createMockPi();
    const ctx = createMockContext();

    mocks.handleModelOverrideClear.mockResolvedValue({
      success: false,
      message: 'override clear failed',
    });

    registerOpenRouterCommands(pi as any);
    await commands.get('openrouter').handler('model-override-clear anthropic/claude-sonnet-4', ctx);

    expect(mocks.handleModelOverrideClear).toHaveBeenCalledWith('anthropic/claude-sonnet-4', {});
    expect(ctx.ui.notify).toHaveBeenCalledWith('override clear failed', 'error');
  });

  it('keeps model-override-list routing unchanged', async () => {
    const { commands, pi } = createMockPi();
    const ctx = createMockContext();

    registerOpenRouterCommands(pi as any);
    await commands.get('openrouter').handler('model-override-list anthropic/', ctx);

    expect(mocks.handleModelOverrideList).toHaveBeenCalledWith('anthropic/');
    expect(ctx.ui.notify).toHaveBeenCalledWith('override list', 'info');
  });

  it('routes api-key-create through the dedicated handler, secure overlay, and redacted notifier', async () => {
    const { commands, pi } = createMockPi();
    const ctx = createMockContext();

    registerOpenRouterCommands(pi as any);
    await commands
      .get('openrouter')
      .handler('api-key-create team limit=25 reset=monthly byok=incl', ctx);

    expect(mocks.handleApiKeyCreate).toHaveBeenCalledWith('team limit=25 reset=monthly byok=incl');
    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      'api key created\nSecret shown in secure overlay; store it now.',
      'info',
    );
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(
      expect.stringContaining('sk-or-v1-created-secret'),
      expect.anything(),
    );

    const overlayFactory = ctx.ui.custom.mock.calls[0]![0];
    const overlay = overlayFactory(
      { requestRender: vi.fn() },
      { bold: (text: string) => text, fg: (_style: string, text: string) => text },
      {},
      vi.fn(),
    );
    const rendered = overlay.render(160).join('\n');
    expect(rendered.split('sk-or-v1-created-secret')).toHaveLength(2);
  });

  it('keeps hidden api-key-disable routing through the error notifier', async () => {
    const { commands, pi } = createMockPi();
    const ctx = createMockContext();

    mocks.handleApiKeyDisable.mockResolvedValue({ success: false, message: 'disable failed' });

    registerOpenRouterCommands(pi as any);
    await commands.get('openrouter').handler('api-key-disable hash-123', ctx);

    expect(mocks.handleApiKeyDisable).toHaveBeenCalledWith('hash-123');
    expect(ctx.ui.notify).toHaveBeenCalledWith('disable failed', 'error');
  });

  it('keeps hidden api-key-enable routing through the info notifier', async () => {
    const { commands, pi } = createMockPi();
    const ctx = createMockContext();

    registerOpenRouterCommands(pi as any);
    await commands.get('openrouter').handler('api-key-enable hash-123', ctx);

    expect(mocks.handleApiKeyEnable).toHaveBeenCalledWith('hash-123');
    expect(ctx.ui.notify).toHaveBeenCalledWith('api key enabled', 'info');
  });

  it('keeps unknown-subcommand messaging unchanged', async () => {
    const { commands, pi } = createMockPi();
    const ctx = createMockContext();

    registerOpenRouterCommands(pi as any);
    await commands.get('openrouter').handler('wat', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      `OpenRouter subcommands\nAvailable subcommands: ${OPENROUTER_SUBCOMMANDS.join(', ')}`,
      'error',
    );
  });

  describe('models-sync failure paths', () => {
    it('shows mode-aware cache-backed refresh failure copy', async () => {
      const { commands, pi } = createMockPi();
      const ctx = createMockContext();

      mocks.getActiveCatalogState.mockReturnValue(
        createActiveCatalogState({
          mode: 'free-only',
          registeredModelIds: ['openrouter/free', 'provider/a:free'],
          registeredCount: 2,
        }),
      );
      mocks.syncModels.mockResolvedValue({
        success: false,
        source: 'cache',
        registeredCount: 5,
        cacheAgeMs: 300000,
        error: 'API timeout',
      });
      mocks.formatDuration.mockReturnValue('5m');

      registerOpenRouterCommands(pi as any);
      await commands.get('openrouter').handler('models-sync', ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'OpenRouter models refresh failed\nUsing last successful free-only catalog · cache age: 5m',
        'warning',
      );
    });

    it('shows hard failure with error level and zero registered', async () => {
      const { commands, pi } = createMockPi();
      const ctx = createMockContext();

      mocks.syncModels.mockResolvedValue({
        success: false,
        source: 'none',
        error: 'Network unreachable',
      });

      registerOpenRouterCommands(pi as any);
      await commands.get('openrouter').handler('models-sync', ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'OpenRouter models unavailable\n0 registered\nError: Network unreachable',
        'error',
      );
    });
  });

  describe('models-status branch coverage', () => {
    it('shows not-synced error when no state and no cache', async () => {
      const { commands, pi } = createMockPi();
      const ctx = createMockContext();

      mocks.getSyncState.mockReturnValue(null);
      mocks.loadCache.mockResolvedValue(null);

      registerOpenRouterCommands(pi as any);
      await commands.get('openrouter').handler('models-status', ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith('OpenRouter models: not synced', 'error');
    });

    it('shows cached-only info with sync hint when no state but cache exists', async () => {
      const { commands, pi } = createMockPi();
      const ctx = createMockContext();

      mocks.getSyncState.mockReturnValue(null);
      mocks.loadCache.mockResolvedValue({ models: [{}, {}, {}], timestamp: Date.now() - 120000 });
      mocks.getCacheAgeMs.mockReturnValue(120000);
      mocks.formatDuration.mockReturnValue('2 minutes');

      registerOpenRouterCommands(pi as any);
      await commands.get('openrouter').handler('models-status', ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "OpenRouter models cached\n3 models in cache · age: 2 minutes\nRun '/openrouter models-sync' to register models",
        'info',
      );
    });

    it('filters active full catalogs for models-status --skipped --free regardless of flag order', async () => {
      const { commands, pi } = createMockPi();
      const ctx = createMockContext();

      mocks.getActiveCatalogState.mockReturnValue(
        createActiveCatalogState({
          mode: 'full',
          registeredModelIds: [
            'openrouter/free',
            'provider/free-a:free',
            'provider/paid-a',
            'provider/paid-b',
          ],
          registeredCount: 4,
          skippedDetails: [
            {
              id: 'provider/free-b:free',
              reason: 'missing context window',
              hint: "Add a local contextWindow override with '/openrouter model-override-set <model-id> contextWindow=<tokens>' if the model's limit is known.",
            },
            { id: 'provider/paid-c', reason: 'missing pricing' },
          ],
          skippedCount: 2,
        }),
      );
      mocks.loadCache.mockResolvedValue({ models: [], timestamp: Date.now() - 240000 });
      mocks.getCacheAgeMs.mockReturnValue(240000);
      mocks.formatDuration.mockReturnValue('4m');

      registerOpenRouterCommands(pi as any);
      await commands.get('openrouter').handler('models-status --free --skipped', ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "OpenRouter models healthy\n2 registered · 1 skipped · full catalog · cache age: 4m\n\nOpenRouter skipped models: 1\n\n1 missing context window\n  suggestion: Add a local contextWindow override with '/openrouter model-override-set <model-id> contextWindow=<tokens>' if the model's limit is known.\n- provider/free-b:free\n",
        'info',
      );
    });

    it('shows broken error when state exists but not from cache and not success', async () => {
      const { commands, pi } = createMockPi();
      const ctx = createMockContext();

      mocks.getSyncState.mockReturnValue({
        success: false,
        source: 'api',
        error: 'Invalid API key',
      });
      mocks.loadCache.mockResolvedValue(null);

      registerOpenRouterCommands(pi as any);
      await commands.get('openrouter').handler('models-status', ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'OpenRouter models broken\n0 registered\nError: Invalid API key',
        'error',
      );
    });
  });

  describe('showUsageOverlay stale and error paths', () => {
    beforeEach(() => {
      overlayConstructorCalls.length = 0;
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-25T12:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('shows stale summary when fetchAndAggregate returns null', async () => {
      const { commands, pi } = createMockPi();
      const ctx = createMockContext();

      const staleTimestamp = Date.now() - 5 * 60 * 1000; // 5 minutes ago
      const staleSummary = { total: { usage: 100 } };

      mocks.usageCacheGet.mockImplementation((_key, opts) =>
        opts?.allowStale ? staleSummary : null,
      );
      mocks.usageCacheGetTimestamp.mockImplementation((_key, opts) =>
        opts?.allowStale ? staleTimestamp : null,
      );
      mocks.fetchAndAggregate.mockResolvedValue(null);

      registerOpenRouterCommands(pi as any);
      await commands.get('openrouter-usage').handler('', ctx);

      expect(overlayConstructorCalls).toHaveLength(1);
      expect(overlayConstructorCalls[0]).toEqual({
        summary: staleSummary,
        error:
          'OpenRouter API key not found. Set OPENROUTER_MANAGEMENT_KEY (preferred) or OPENROUTER_API_KEY to use /usage.\nShowing last successful usage data.',
        cachedMinutesAgo: 5,
      });
    });

    it('shows stale summary when fetchAndAggregate throws', async () => {
      const { commands, pi } = createMockPi();
      const ctx = createMockContext();

      const staleTimestamp = Date.now() - 10 * 60 * 1000; // 10 minutes ago
      const staleSummary = { total: { usage: 200 } };

      mocks.usageCacheGet.mockImplementation((_key, opts) =>
        opts?.allowStale ? staleSummary : null,
      );
      mocks.usageCacheGetTimestamp.mockImplementation((_key, opts) =>
        opts?.allowStale ? staleTimestamp : null,
      );
      mocks.fetchAndAggregate.mockRejectedValue(new Error('Connection timeout'));

      registerOpenRouterCommands(pi as any);
      await commands.get('openrouter-usage').handler('', ctx);

      expect(overlayConstructorCalls).toHaveLength(1);
      expect(overlayConstructorCalls[0]).toEqual({
        summary: staleSummary,
        error: 'API Error: Connection timeout\nShowing last successful usage data.',
        cachedMinutesAgo: 10,
      });
    });

    it('shows error-only overlay when no stale data available', async () => {
      const { commands, pi } = createMockPi();
      const ctx = createMockContext();

      mocks.usageCacheGet.mockReturnValue(null);
      mocks.usageCacheGetTimestamp.mockReturnValue(null);
      mocks.fetchAndAggregate.mockResolvedValue(null);

      registerOpenRouterCommands(pi as any);
      await commands.get('openrouter-usage').handler('', ctx);

      expect(overlayConstructorCalls).toHaveLength(1);
      expect(overlayConstructorCalls[0]).toEqual({
        summary: null,
        error:
          'OpenRouter API key not found. Set OPENROUTER_MANAGEMENT_KEY (preferred) or OPENROUTER_API_KEY to use /usage.',
        cachedMinutesAgo: null,
      });
    });

    it('shows error-only overlay with null cachedMinutesAgo when fetchAndAggregate throws and no stale data', async () => {
      const { commands, pi } = createMockPi();
      const ctx = createMockContext();

      mocks.usageCacheGet.mockReturnValue(null);
      mocks.usageCacheGetTimestamp.mockReturnValue(null);
      mocks.fetchAndAggregate.mockRejectedValue(new Error('Network error'));

      registerOpenRouterCommands(pi as any);
      await commands.get('openrouter-usage').handler('', ctx);

      expect(overlayConstructorCalls).toHaveLength(1);
      expect(overlayConstructorCalls[0]).toEqual({
        summary: null,
        error: 'API Error: Network error',
        cachedMinutesAgo: null,
      });
    });
  });

  describe('startUsageBackgroundRefresh notify gating', () => {
    it('does not notify when ctx.hasUI is false', async () => {
      const { commands, pi } = createMockPi();
      const ctx = createMockContext();
      ctx.hasUI = false;

      registerOpenRouterCommands(pi as any);
      await commands.get('openrouter-usage').handler('', ctx);

      const onFailure = mocks.startBackgroundRefresh.mock.calls[0]?.[0]?.onFailure;
      expect(onFailure).toBeDefined();
      onFailure!({
        status: 'failed',
        consecutiveFailures: 5,
        lastError: 'Persistent failure',
        nextDelayMs: 60000,
      });

      expect(ctx.ui.notify).not.toHaveBeenCalled();
    });

    it('does not notify when lastError is missing', async () => {
      const { commands, pi } = createMockPi();
      const ctx = createMockContext();

      registerOpenRouterCommands(pi as any);
      await commands.get('openrouter-usage').handler('', ctx);

      const onFailure = mocks.startBackgroundRefresh.mock.calls[0]?.[0]?.onFailure;
      expect(onFailure).toBeDefined();
      onFailure!({
        status: 'failed',
        consecutiveFailures: 5,
        lastError: null,
        nextDelayMs: 60000,
      });

      expect(ctx.ui.notify).not.toHaveBeenCalled();
    });

    it('does not notify for transient non-rate-limit failures', async () => {
      const { commands, pi } = createMockPi();
      const ctx = createMockContext();

      registerOpenRouterCommands(pi as any);
      await commands.get('openrouter-usage').handler('', ctx);

      const onFailure = mocks.startBackgroundRefresh.mock.calls[0]?.[0]?.onFailure;
      expect(onFailure).toBeDefined();
      onFailure!({
        status: 'failed',
        consecutiveFailures: 2,
        lastError: 'Temporary glitch',
        nextDelayMs: 10000,
      });

      expect(ctx.ui.notify).not.toHaveBeenCalled();
    });

    it('notifies for persistent failures with warning level', async () => {
      const { commands, pi } = createMockPi();
      const ctx = createMockContext();

      registerOpenRouterCommands(pi as any);
      await commands.get('openrouter-usage').handler('', ctx);

      const onFailure = mocks.startBackgroundRefresh.mock.calls[0]?.[0]?.onFailure;
      expect(onFailure).toBeDefined();
      onFailure!({
        status: 'failed',
        consecutiveFailures: 4,
        lastError: 'Persistent auth error',
        nextDelayMs: 120000,
      });

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'OpenRouter usage refresh failed\nPersistent auth error',
        'warning',
      );
    });

    it('notifies for rate-limit failures even before persistence threshold', async () => {
      const { commands, pi } = createMockPi();
      const ctx = createMockContext();

      registerOpenRouterCommands(pi as any);
      await commands.get('openrouter-usage').handler('', ctx);

      const onFailure = mocks.startBackgroundRefresh.mock.calls[0]?.[0]?.onFailure;
      expect(onFailure).toBeDefined();
      onFailure!({
        status: 'failed',
        consecutiveFailures: 1,
        lastError: 'Rate limit exceeded',
        nextDelayMs: 60000,
      });

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'OpenRouter usage refresh failed\nRate limit exceeded',
        'warning',
      );
    });

    it.each(['HTTP 429: Too Many Requests', 'rate-limit exceeded for this key'])(
      'notifies for rate-limit error: %s',
      async (lastError) => {
        const { commands, pi } = createMockPi();
        const ctx = createMockContext();

        registerOpenRouterCommands(pi as any);
        await commands.get('openrouter-usage').handler('', ctx);

        const onFailure = mocks.startBackgroundRefresh.mock.calls[0]?.[0]?.onFailure;
        expect(onFailure).toBeDefined();
        onFailure!({
          status: 'failed',
          consecutiveFailures: 1,
          lastError,
          nextDelayMs: 60000,
        });

        expect(ctx.ui.notify).toHaveBeenCalledWith(
          `OpenRouter usage refresh failed\n${lastError}`,
          'warning',
        );
      },
    );

    it('includes stale suffix when status is stale', async () => {
      const { commands, pi } = createMockPi();
      const ctx = createMockContext();

      registerOpenRouterCommands(pi as any);
      await commands.get('openrouter-usage').handler('', ctx);

      const onFailure = mocks.startBackgroundRefresh.mock.calls[0]?.[0]?.onFailure;
      expect(onFailure).toBeDefined();
      onFailure!({
        status: 'stale',
        consecutiveFailures: 5,
        lastError: 'API down',
        nextDelayMs: 240000,
      });

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'OpenRouter usage refresh stale\nAPI down\nShowing last successful usage data.',
        'warning',
      );
    });
  });
});
