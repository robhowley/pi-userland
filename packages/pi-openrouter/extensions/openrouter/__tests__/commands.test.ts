import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  usageCacheGet: vi.fn(),
  usageCacheGetTimestamp: vi.fn(),
  usageCacheSet: vi.fn(),
  startBackgroundRefresh: vi.fn(),
  fetchAndAggregate: vi.fn(),
  getCurrentSessionId: vi.fn(),
  getAllKeys: vi.fn(),
  getCurrentKey: vi.fn(),
  getAccountCredits: vi.fn(),
  computeRollupStatus: vi.fn(),
  sortKeys: vi.fn(),
  syncModels: vi.fn(),
  getSyncState: vi.fn(),
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
}));

vi.mock('../cache.js', () => ({
  usageCache: {
    get: mocks.usageCacheGet,
    getTimestamp: mocks.usageCacheGetTimestamp,
    set: mocks.usageCacheSet,
  },
  startBackgroundRefresh: mocks.startBackgroundRefresh,
  fetchAndAggregate: mocks.fetchAndAggregate,
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
  getAccountCredits: mocks.getAccountCredits,
}));

vi.mock('../account-format.js', () => ({
  computeRollupStatus: mocks.computeRollupStatus,
  sortKeys: mocks.sortKeys,
}));

vi.mock('../models/sync.js', () => ({
  syncModels: mocks.syncModels,
  getSyncState: mocks.getSyncState,
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
      custom: vi.fn().mockResolvedValue(undefined),
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

describe('registerOpenRouterCommands', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    mocks.getCurrentSessionId.mockReturnValue('pi:session-123');
    mocks.usageCacheGet.mockReturnValue(null);
    mocks.usageCacheGetTimestamp.mockReturnValue(null);
    mocks.fetchAndAggregate.mockResolvedValue({});
    mocks.getAllKeys.mockResolvedValue([keyInfo]);
    mocks.getCurrentKey.mockResolvedValue(keyInfo);
    mocks.getAccountCredits.mockResolvedValue(25);
    mocks.computeRollupStatus.mockReturnValue({ status: 'healthy', message: 'healthy' });
    mocks.sortKeys.mockImplementation((keys) => keys);
    mocks.syncModels.mockResolvedValue({ success: true, registeredCount: 3, skippedCount: 0 });
    mocks.getSyncState.mockReturnValue(null);
    mocks.isSyncEnabled.mockReturnValue(true);
    mocks.getSkipReasonsAsync.mockResolvedValue([]);
    mocks.groupSkipReasons.mockReturnValue({});
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
      'OpenRouter commands: usage, account, session, models-sync, models-status',
    );
  });

  it('keeps /openrouter subcommand completions unchanged', () => {
    const { commands, pi } = createMockPi();

    registerOpenRouterCommands(pi as any);
    const command = commands.get('openrouter');

    expect(command.getArgumentCompletions('model-')).toEqual([
      { value: 'model-override-set', label: 'model-override-set' },
      { value: 'model-override-clear', label: 'model-override-clear' },
      { value: 'model-override-list', label: 'model-override-list' },
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
    expect(mocks.getAccountCredits).toHaveBeenCalledTimes(1);
    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
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

  it('keeps models-sync success notifications unchanged', async () => {
    const { commands, pi } = createMockPi();
    const ctx = createMockContext();

    mocks.syncModels.mockResolvedValue({
      success: true,
      registeredCount: 9,
      skippedCount: 2,
    });

    registerOpenRouterCommands(pi as any);
    await commands.get('openrouter').handler('models-sync', ctx);

    expect(mocks.syncModels).toHaveBeenCalledWith(ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      'OpenRouter models synced\n9 registered · 2 skipped · cache updated',
      'info',
    );
  });

  it('keeps models-status skipped-details output unchanged', async () => {
    const { commands, pi } = createMockPi();
    const ctx = createMockContext();

    mocks.getSyncState.mockReturnValue({ success: true, registeredCount: 7 });
    mocks.getSkipReasonsAsync.mockResolvedValue([
      { id: 'provider/a', reason: 'missing context window' },
      { id: 'provider/b', reason: 'missing context window' },
    ]);
    mocks.groupSkipReasons.mockReturnValue({ 'missing context window': 2 });
    mocks.loadCache.mockResolvedValue({ models: [], timestamp: Date.now() - 60000 });
    mocks.getCacheAgeMs.mockReturnValue(60000);
    mocks.formatDuration.mockReturnValue('1 minute');

    registerOpenRouterCommands(pi as any);
    await commands.get('openrouter').handler('models-status --skipped', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      'OpenRouter models healthy\n7 registered · 2 skipped · cache age: 1 minute\n\nOpenRouter skipped models: 2\n\n2 missing context window\n- provider/a\n- provider/b\n',
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
});
