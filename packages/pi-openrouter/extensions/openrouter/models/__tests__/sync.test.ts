/**
 * Tests for the sync engine.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExtensionContext, ModelRegistry } from '@mariozechner/pi-coding-agent';
import type { CatalogMode, PiModelConfig, SkipReason, SyncResult } from '../types.js';
import { ROUTER_ALIASES } from '../types.js';
import { createPiModelConfig, createValidModel } from '../../__tests__/fixtures.js';
// Import modules
import {
  syncModels,
  setSyncState,
  getSyncState,
  getStatusText,
  areModelsAvailable,
  includeBuiltinRouterModels,
  isExplicitFreeModelId,
  filterModelsForCatalogMode,
  getActiveCatalogState,
  getBuiltinRoutersForCatalogMode,
  setActiveCatalogState,
  getSkipReasonsAsync,
} from '../sync.js';
import { fetchUserModels, AuthError } from '../../client.js';
import { loadCache, saveCache } from '../cache.js';

// Mock the client module to control API behavior
vi.mock('../../client.js', () => ({
  fetchUserModels: vi.fn(),
  isConfigured: vi.fn(),
  getApiKey: vi.fn(),
  AuthError: class AuthError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'AuthError';
    }
  },
}));

// Mock the cache module
vi.mock('../cache.js', () => ({
  loadCache: vi.fn(),
  saveCache: vi.fn(),
  setCacheDir: vi.fn(),
}));

/**
 * Factory for creating minimal mock ExtensionContext.
 * Only implements methods/properties actually used by sync tests.
 */
function createMockExtensionContext(
  overrides: {
    registerProvider?: typeof vi.fn;
  } = {},
): ExtensionContext {
  const mockFn = vi.fn;

  return {
    modelRegistry: {
      registerProvider: overrides.registerProvider ?? mockFn(),
    } as unknown as ModelRegistry,
    ui: createMockUI(),
    hasUI: true,
    cwd: '/tmp',
    sessionManager: createMockSessionManager(),
    model: undefined,
    isIdle: () => true,
    signal: undefined,
    abort: mockFn(),
    hasPendingMessages: () => false,
    shutdown: mockFn(),
    getContextUsage: mockFn(),
    compact: mockFn(),
    getSystemPrompt: mockFn(),
  } satisfies ExtensionContext;
}

function createMockUI(): ExtensionContext['ui'] {
  const mockFn = vi.fn;
  return {
    select: mockFn(),
    confirm: mockFn(),
    input: mockFn(),
    notify: mockFn(),
    onTerminalInput: mockFn(),
    setStatus: mockFn(),
    setWorkingMessage: mockFn(),
    setWorkingIndicator: mockFn(),
    setHiddenThinkingLabel: mockFn(),
    setWidget: mockFn(),
    setFooter: mockFn(),
    setHeader: mockFn(),
    setTitle: mockFn(),
    custom: mockFn(),
    pasteToEditor: mockFn(),
    setEditorText: mockFn(),
    getEditorText: mockFn(),
    editor: mockFn(),
    setEditorComponent: mockFn(),
    theme: {} as any,
    getAllThemes: mockFn(),
    getTheme: mockFn(),
    setTheme: mockFn(),
    getToolsExpanded: mockFn(),
    setToolsExpanded: mockFn(),
  };
}

/**
 * Creates a mock session manager for testing.
 * Uses `as any` since we only need the mock to satisfy ExtensionContext type,
 * and sync tests don't actually use the session manager.
 */
function createMockSessionManager(): ExtensionContext['sessionManager'] {
  const mockFn = vi.fn;
  return {
    getCurrentSessionId: mockFn(),
    getCurrentSessionPath: mockFn(),
    getEntry: mockFn(),
    getEntryHistory: mockFn(),
    getEntryById: mockFn(),
    getBranchEntries: mockFn(),
    getBranchSummary: mockFn(),
    getRecentEntries: mockFn(),
    getEntryCount: mockFn(),
  } as any;
}

function createSdkModel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test/model',
    name: 'Test Model',
    architecture: {
      inputModalities: ['text'],
      outputModalities: ['text'],
    },
    contextLength: 128000,
    pricing: {
      prompt: 0.000001,
      completion: 0.000002,
      inputCacheRead: 0,
      inputCacheWrite: 0,
    },
    supportedParameters: [],
    topProvider: {
      contextLength: 128000,
      maxCompletionTokens: 4096,
    },
    ...overrides,
  } as any;
}

function createSkipReasons(count: number): SkipReason[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `bad/model-${index + 1}`,
    reason: 'missing context window',
  }));
}

function createSyncResult(overrides: Partial<SyncResult> = {}): SyncResult {
  return {
    success: true,
    outcome: 'synced',
    requestedMode: 'full',
    catalogMode: 'full',
    registeredCount: 1,
    skippedCount: 0,
    skippedDetails: [],
    source: 'api',
    cacheUpdated: true,
    cacheAgeMs: 0,
    error: null,
    ...overrides,
  };
}

describe('catalog mode helpers', () => {
  it('detects explicit free model IDs', () => {
    expect(isExplicitFreeModelId('provider/model:free')).toBe(true);
    expect(isExplicitFreeModelId('provider/model')).toBe(false);
    expect(isExplicitFreeModelId('openrouter/free')).toBe(false);
  });

  it('filters raw models before mapping for free-only mode', () => {
    const models = [
      { id: 'provider/paid-model' },
      { id: 'provider/free-model:free' },
      { id: 'openrouter/free' },
    ];

    expect(filterModelsForCatalogMode(models, 'full').map((model) => model.id)).toEqual([
      'provider/paid-model',
      'provider/free-model:free',
      'openrouter/free',
    ]);
    expect(filterModelsForCatalogMode(models, 'free-only').map((model) => model.id)).toEqual([
      'provider/free-model:free',
    ]);
  });

  it('returns mode-specific built-in routers', () => {
    expect(getBuiltinRoutersForCatalogMode('full').map((model) => model.id)).toEqual(
      ROUTER_ALIASES,
    );
    expect(getBuiltinRoutersForCatalogMode('free-only').map((model) => model.id)).toEqual([
      'openrouter/free',
    ]);
  });

  it('includes built-in routers exactly once for full mode by default', () => {
    const configs = includeBuiltinRouterModels([
      createPiModelConfig({ id: 'user/model-a' }),
      createPiModelConfig({ id: ROUTER_ALIASES[0]! }),
    ]);
    const registeredIds = configs.map((model) => model.id);

    expect(registeredIds).toEqual(['user/model-a', ...ROUTER_ALIASES]);
    for (const routerId of ROUTER_ALIASES) {
      expect(registeredIds.filter((id) => id === routerId)).toHaveLength(1);
    }
  });

  it('injects only openrouter/free in free-only mode', () => {
    const configs = includeBuiltinRouterModels(
      [createPiModelConfig({ id: 'user/model:free' })],
      'free-only',
    );
    expect(configs.map((model) => model.id)).toEqual(['user/model:free', 'openrouter/free']);
  });
});

describe('syncModels', () => {
  const mockRegisterProvider = vi.fn();
  const mockCtx = createMockExtensionContext({ registerProvider: mockRegisterProvider });

  beforeEach(() => {
    vi.resetAllMocks();
    setSyncState(null);
    setActiveCatalogState(null);
    delete process.env['OPENROUTER_API_KEY'];
  });

  it('returns unavailable when API key is missing and no cache exists', async () => {
    vi.mocked(fetchUserModels).mockRejectedValueOnce(
      new AuthError(
        'OpenRouter API key not configured. Set OPENROUTER_API_KEY or OPENROUTER_MANAGEMENT_KEY.',
      ),
    );
    vi.mocked(loadCache).mockResolvedValueOnce(null);

    const result = await syncModels(mockCtx);

    expect(result).toMatchObject({
      success: false,
      outcome: 'unavailable',
      source: 'none',
      requestedMode: 'full',
      catalogMode: null,
      registeredCount: 0,
    });
    expect(result.error).toContain('OpenRouter API key not configured');
    expect(getActiveCatalogState()).toBeNull();
  });

  it('syncs the full API catalog, persists full-mode cache metadata, and seeds active state', async () => {
    vi.mocked(fetchUserModels).mockResolvedValueOnce({
      data: [
        createSdkModel({
          id: 'user/model-a',
          name: 'User Model A',
        }),
      ],
    } as any);

    const result = await syncModels(mockCtx);
    const providerConfig = mockRegisterProvider.mock.calls[0]![1] as { models: PiModelConfig[] };
    const registeredIds = providerConfig.models.map((model) => model.id);

    expect(result).toMatchObject({
      success: true,
      outcome: 'synced',
      requestedMode: 'full',
      catalogMode: 'full',
      source: 'api',
      cacheUpdated: true,
      registeredCount: 1 + ROUTER_ALIASES.length,
    });
    expect(registeredIds).toEqual(['user/model-a', ...ROUTER_ALIASES]);
    expect(vi.mocked(saveCache)).toHaveBeenCalledWith(
      expect.objectContaining({
        catalogMode: 'full',
      }),
    );
    const savedCache = vi.mocked(saveCache).mock.calls[0]![0];
    expect(savedCache.models.map((model) => model.id)).toEqual(['user/model-a', ...ROUTER_ALIASES]);
    expect(getActiveCatalogState()).toEqual({
      mode: 'full',
      registeredModelIds: ['user/model-a', ...ROUTER_ALIASES],
      registeredCount: 1 + ROUTER_ALIASES.length,
      skippedCount: 0,
      skippedDetails: [],
      source: 'api',
      cacheAgeMs: 0,
    });
  });

  it('syncs free-only mode, excludes paid variants, and does not inflate skipped counts from filtered paid models', async () => {
    vi.mocked(fetchUserModels).mockResolvedValueOnce({
      data: [
        createSdkModel({ id: 'provider/model', name: 'Paid Variant' }),
        createSdkModel({ id: 'provider/model:free', name: 'Free Variant' }),
        createSdkModel({
          id: 'provider/invalid-paid',
          name: 'Invalid Paid Variant',
          contextLength: 0,
          topProvider: { contextLength: 0, maxCompletionTokens: 4096 },
        }),
        createSdkModel({
          id: 'provider/invalid-free:free',
          name: 'Invalid Free Variant',
          contextLength: 0,
          topProvider: { contextLength: 0, maxCompletionTokens: 4096 },
        }),
      ],
    } as any);

    const result = await syncModels(mockCtx, 'free-only');
    const providerConfig = mockRegisterProvider.mock.calls[0]![1] as { models: PiModelConfig[] };
    const registeredIds = providerConfig.models.map((model) => model.id);
    const savedCache = vi.mocked(saveCache).mock.calls[0]![0];

    expect(result).toMatchObject({
      success: true,
      outcome: 'synced',
      requestedMode: 'free-only',
      catalogMode: 'free-only',
      source: 'api',
      registeredCount: 2,
      skippedCount: 1,
    });
    expect(result.skippedDetails).toEqual([
      {
        id: 'provider/invalid-free:free',
        reason: 'missing context window',
        hint: expect.stringContaining('contextWindow'),
      },
    ]);
    expect(registeredIds).toEqual(['provider/model:free', 'openrouter/free']);
    expect(registeredIds).not.toContain('provider/model');
    expect(registeredIds).not.toContain('provider/invalid-paid');
    expect(registeredIds).not.toContain('openrouter/auto');
    expect(registeredIds).not.toContain('openrouter/owl-alpha');
    expect(savedCache.catalogMode).toBe('free-only');
    expect(savedCache.models.map((model) => model.id)).toEqual([
      'provider/model:free',
      'provider/invalid-free:free',
      'openrouter/free',
    ]);
    expect(getActiveCatalogState()).toEqual({
      mode: 'free-only',
      registeredModelIds: ['provider/model:free', 'openrouter/free'],
      registeredCount: 2,
      skippedCount: 1,
      skippedDetails: [
        {
          id: 'provider/invalid-free:free',
          reason: 'missing context window',
          hint: expect.stringContaining('contextWindow'),
        },
      ],
      source: 'api',
      cacheAgeMs: 0,
    });
  });

  it('treats an empty free-only API catalog as a no-op before router injection', async () => {
    const previousState = {
      mode: 'full' as CatalogMode,
      registeredCount: 4,
      skippedCount: 2,
      skippedDetails: createSkipReasons(2),
      source: 'api' as const,
      cacheAgeMs: 0,
    };
    setActiveCatalogState(previousState);

    vi.mocked(fetchUserModels).mockResolvedValueOnce({
      data: [createSdkModel({ id: 'provider/paid-a' }), createSdkModel({ id: 'provider/paid-b' })],
    } as any);

    const result = await syncModels(mockCtx, 'free-only');

    expect(result).toMatchObject({
      success: false,
      outcome: 'no-change',
      requestedMode: 'free-only',
      catalogMode: 'full',
      registeredCount: 0,
      skippedCount: 0,
      cacheUpdated: false,
      source: 'api',
      error: null,
    });
    expect(mockRegisterProvider).not.toHaveBeenCalled();
    expect(saveCache).not.toHaveBeenCalled();
    expect(getActiveCatalogState()).toEqual(previousState);
  });

  it('re-registers cached models using the cached catalog mode on API failure', async () => {
    vi.mocked(fetchUserModels).mockRejectedValueOnce(new Error('api down'));
    vi.mocked(loadCache).mockResolvedValueOnce({
      catalogMode: 'free-only',
      models: [
        createValidModel({ id: 'cached/model:free', name: 'Cached Free Model' }),
        createValidModel({ id: 'cached/paid-model', name: 'Cached Paid Model' }),
        createValidModel({ id: 'openrouter/free', name: 'Free Router' }),
      ],
      skippedDetails: [
        {
          id: 'cached/bad:free',
          reason: 'missing context window',
          hint: "Add a local contextWindow override with '/openrouter model-override-set <model-id> contextWindow=<tokens>' if the model's limit is known.",
        },
      ],
      timestamp: Date.now() - 60000,
    });

    const result = await syncModels(mockCtx, 'full');
    const providerConfig = mockRegisterProvider.mock.calls[0]![1] as { models: PiModelConfig[] };
    const registeredIds = providerConfig.models.map((model) => model.id);

    expect(result).toMatchObject({
      success: false,
      outcome: 'cache-fallback',
      requestedMode: 'full',
      catalogMode: 'free-only',
      source: 'cache',
      registeredCount: 2,
      skippedCount: 1,
    });
    expect(registeredIds).toEqual(['cached/model:free', 'openrouter/free']);
    expect(registeredIds).not.toContain('cached/paid-model');
    expect(registeredIds).not.toContain('openrouter/auto');
    expect(registeredIds).not.toContain('openrouter/owl-alpha');
    expect(result.skippedDetails).toEqual([
      {
        id: 'cached/bad:free',
        reason: 'missing context window',
        hint: expect.stringContaining('contextWindow'),
      },
    ]);
    expect(getActiveCatalogState()).toEqual({
      mode: 'free-only',
      registeredModelIds: ['cached/model:free', 'openrouter/free'],
      registeredCount: 2,
      skippedCount: 1,
      skippedDetails: [
        {
          id: 'cached/bad:free',
          reason: 'missing context window',
          hint: expect.stringContaining('contextWindow'),
        },
      ],
      source: 'cache',
      cacheAgeMs: expect.any(Number),
    });
  });

  it('preserves the active catalog when refresh fails and no cache is available', async () => {
    setActiveCatalogState({
      mode: 'full',
      registeredCount: 4,
      skippedCount: 0,
      skippedDetails: [],
      source: 'api',
      cacheAgeMs: 0,
    });
    vi.mocked(fetchUserModels).mockRejectedValueOnce(new Error('network down'));
    vi.mocked(loadCache).mockResolvedValueOnce(null);

    const result = await syncModels(mockCtx, 'free-only');

    expect(result).toMatchObject({
      success: false,
      outcome: 'unavailable',
      requestedMode: 'free-only',
      catalogMode: 'full',
      source: 'none',
      registeredCount: 0,
    });
    expect(getActiveCatalogState()).toEqual({
      mode: 'full',
      registeredCount: 4,
      skippedCount: 0,
      skippedDetails: [],
      source: 'api',
      cacheAgeMs: 0,
    });
    expect(await areModelsAvailable()).toBe(true);
  });
});

describe('sync state management', () => {
  beforeEach(() => {
    setSyncState(null);
    setActiveCatalogState(null);
  });

  it('stores and retrieves sync state', () => {
    const mockResult = createSyncResult({
      registeredCount: 10,
      skippedCount: 2,
      skippedDetails: createSkipReasons(2),
    });

    setSyncState(mockResult);
    expect(getSyncState()).toEqual(mockResult);
  });

  it('stores and retrieves active catalog state separately from sync state', () => {
    setSyncState(createSyncResult({ outcome: 'unavailable', success: false, source: 'none' }));
    setActiveCatalogState({
      mode: 'free-only',
      registeredCount: 3,
      skippedCount: 1,
      skippedDetails: createSkipReasons(1),
      source: 'cache',
      cacheAgeMs: 60000,
    });

    expect(getSyncState()?.outcome).toBe('unavailable');
    expect(getActiveCatalogState()).toEqual({
      mode: 'free-only',
      registeredCount: 3,
      skippedCount: 1,
      skippedDetails: createSkipReasons(1),
      source: 'cache',
      cacheAgeMs: 60000,
    });
  });
});

describe('getStatusText', () => {
  beforeEach(() => {
    setSyncState(null);
    setActiveCatalogState(null);
  });

  it('returns not synced when no sync or active state exists', () => {
    expect(getStatusText()).toBe('OpenRouter models: not synced');
  });

  it('prefers the active catalog state over the last sync result', () => {
    setSyncState(
      createSyncResult({
        success: false,
        outcome: 'unavailable',
        source: 'none',
        registeredCount: 0,
      }),
    );
    setActiveCatalogState({
      mode: 'full',
      registeredCount: 287,
      skippedCount: 21,
      skippedDetails: createSkipReasons(21),
      source: 'cache',
      cacheAgeMs: 7200000,
    });

    const text = getStatusText();
    expect(text).toContain('cached');
    expect(text).toContain('287 registered');
  });

  it('should return broken for complete failure', () => {
    setSyncState({
      success: false,
      outcome: 'unavailable',
      requestedMode: 'full',
      catalogMode: null,
      registeredCount: 0,
      skippedCount: 0,
      skippedDetails: [],
      source: 'none',
      cacheUpdated: false,
      cacheAgeMs: null,
      error: 'missing or invalid OpenRouter auth',
    });
    const text = getStatusText();
    expect(text).toContain('broken');
    expect(text).toContain('0 registered');
  });
});

describe('areModelsAvailable', () => {
  beforeEach(() => {
    setSyncState(null);
    setActiveCatalogState(null);
  });

  it('returns false when no active state or cache exists', async () => {
    vi.mocked(loadCache).mockResolvedValueOnce(null);
    expect(await areModelsAvailable()).toBe(false);
  });

  it('returns true when an active catalog is registered', async () => {
    setActiveCatalogState({
      mode: 'full',
      registeredCount: 10,
      skippedCount: 0,
      skippedDetails: [],
      source: 'api',
      cacheAgeMs: 0,
    });
    expect(await areModelsAvailable()).toBe(true);
  });
});

describe('getSkipReasonsAsync', () => {
  beforeEach(() => {
    setSyncState(null);
    setActiveCatalogState(null);
  });

  it('returns the full skip list when maxResults is omitted and slices only when requested', async () => {
    const skippedDetails = createSkipReasons(12);
    setActiveCatalogState({
      mode: 'full',
      registeredCount: 25,
      skippedCount: skippedDetails.length,
      skippedDetails,
      source: 'api',
      cacheAgeMs: 0,
    });

    expect(await getSkipReasonsAsync()).toHaveLength(12);
    expect(await getSkipReasonsAsync(10)).toHaveLength(10);
  });
});
