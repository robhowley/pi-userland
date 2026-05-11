/**
 * Tests for the sync engine.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { SyncResult } from '../types.js';

// Import modules
import {
  syncModels,
  setSyncState,
  getSyncState,
  getStatusText,
  areModelsAvailable,
} from '../sync.js';

describe('syncModels', () => {
  const mockCtx = {} as ExtensionContext;

  beforeEach(() => {
    vi.resetAllMocks();
    (setSyncState as (result: SyncResult | null) => void)(null);
    // Explicitly delete API key
    delete process.env['OPENROUTER_API_KEY'];
  });

  it('should return failure when API key is missing and no cache', async () => {
    // Ensure API key is not set
    delete process.env['OPENROUTER_API_KEY'];

    const result = await syncModels(mockCtx);

    expect(result.success).toBe(false);
    expect(result.registeredCount).toBe(0);
    expect(result.source).toBe('none');
    expect(result.error).toContain('OPENROUTER_API_KEY not set');
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
