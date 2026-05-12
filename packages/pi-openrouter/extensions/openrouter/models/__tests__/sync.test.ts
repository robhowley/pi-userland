/**
 * Tests for the sync engine.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExtensionContext, ModelRegistry } from '@mariozechner/pi-coding-agent';
import type { SyncResult } from '../types.js';

// Import modules
import {
  syncModels,
  setSyncState,
  getSyncState,
  getStatusText,
  areModelsAvailable,
} from '../sync.js';
import { fetchUserModels, AuthError } from '../../client.js';
import { loadCache } from '../cache.js';

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

describe('syncModels', () => {
  const mockRegisterProvider = vi.fn();
  const mockCtx = createMockExtensionContext({ registerProvider: mockRegisterProvider });

  beforeEach(() => {
    vi.resetAllMocks();
    (setSyncState as (result: SyncResult | null) => void)(null);
    // Explicitly delete API key
    delete process.env['OPENROUTER_API_KEY'];
  });

  it('should return failure when API key is missing and no cache', async () => {
    // Ensure API key is not set
    delete process.env['OPENROUTER_API_KEY'];
    // Mock fetchUserModels to throw AuthError
    vi.mocked(fetchUserModels).mockRejectedValueOnce(new AuthError('OPENROUTER_API_KEY not set'));
    // Mock loadCache to return null (no cache available)
    vi.mocked(loadCache).mockResolvedValueOnce(null);

    const result = await syncModels(mockCtx);

    expect(result.success).toBe(false);
    expect(result.registeredCount).toBe(0);
    expect(result.source).toBe('none');
    expect(result.error).toContain('OPENROUTER_API_KEY not set');
  });

  it('should sync models from API and register with provider', async () => {
    // Mock successful API response with minimal model data
    const mockModel = {
      id: 'anthropic/claude-3-opus',
      name: 'Claude 3 Opus',
      architecture: {
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
      },
      contextLength: 200000,
      pricing: {
        prompt: 0.000015,
        completion: 0.000075,
        inputCacheRead: 0.0000015,
        inputCacheWrite: 0.0000075,
      },
      supportedParameters: ['reasoning'],
      topProvider: {
        contextLength: 200000,
        maxCompletionTokens: 4096,
      },
    };

    vi.mocked(fetchUserModels).mockResolvedValueOnce({
      data: [mockModel],
    } as any);

    vi.mocked(loadCache).mockResolvedValueOnce(null);

    const result = await syncModels(mockCtx);

    expect(result.success).toBe(true);
    expect(result.source).toBe('api');
    expect(result.registeredCount).toBeGreaterThan(0);
    expect(mockRegisterProvider).toHaveBeenCalled();
  });
});

describe('syncState management', () => {
  it('should store and retrieve sync state', () => {
    const mockResult: SyncResult = {
      success: true,
      registeredCount: 10,
      skippedCount: 2,
      source: 'api',
      cacheUpdated: true,
      cacheAgeMs: null,
      error: null,
    };

    setSyncState(mockResult);

    const retrieved = getSyncState();
    expect(retrieved).toEqual(mockResult);
  });

  it('should return null when no state set', () => {
    (setSyncState as (result: SyncResult | null) => void)(null);
    expect(getSyncState()).toBeNull();
  });
});

describe('getStatusText', () => {
  beforeEach(() => {
    (setSyncState as (result: SyncResult | null) => void)(null);
  });

  it('should return not synced when no state', () => {
    expect(getStatusText()).toBe('OpenRouter models: not synced');
  });

  it('should return healthy for successful sync', () => {
    setSyncState({
      success: true,
      registeredCount: 312,
      skippedCount: 18,
      source: 'api',
      cacheUpdated: true,
      cacheAgeMs: null,
      error: null,
    } as SyncResult);
    const text = getStatusText();
    expect(text).toContain('healthy');
    expect(text).toContain('312 registered');
  });

  it('should return cached for cache fallback', () => {
    setSyncState({
      success: false,
      registeredCount: 287,
      skippedCount: 21,
      source: 'cache',
      cacheUpdated: false,
      cacheAgeMs: 7200000, // 2 hours
      error: '401 unauthorized',
    } as SyncResult);
    const text = getStatusText();
    expect(text).toContain('cached');
    expect(text).toContain('287 registered');
  });

  it('should return broken for complete failure', () => {
    setSyncState({
      success: false,
      registeredCount: 0,
      skippedCount: 0,
      source: 'none',
      cacheUpdated: false,
      cacheAgeMs: null,
      error: 'missing or invalid OpenRouter auth',
    } as SyncResult);
    const text = getStatusText();
    expect(text).toContain('broken');
    expect(text).toContain('0 registered');
  });
});

describe('areModelsAvailable', () => {
  beforeEach(() => {
    (setSyncState as (result: SyncResult | null) => void)(null);
  });

  it('should return false when no state', () => {
    expect(areModelsAvailable()).toBe(false);
  });

  it('should return true when models are synced', () => {
    setSyncState({
      success: true,
      registeredCount: 10,
      skippedCount: 0,
      source: 'api',
      cacheUpdated: true,
      cacheAgeMs: null,
      error: null,
    } as SyncResult);
    expect(areModelsAvailable()).toBe(true);
  });

  it('should return true when using cache (models still available)', () => {
    setSyncState({
      success: false,
      registeredCount: 5,
      skippedCount: 0,
      source: 'cache',
      cacheUpdated: false,
      cacheAgeMs: 7200000,
      error: 'API error',
    } as SyncResult);
    expect(areModelsAvailable()).toBe(true);
  });

  it('should return false when no models registered', () => {
    setSyncState({
      success: false,
      registeredCount: 0,
      skippedCount: 0,
      source: 'none',
      cacheUpdated: false,
      cacheAgeMs: null,
      error: 'Complete failure',
    } as SyncResult);
    expect(areModelsAvailable()).toBe(false);
  });
});
