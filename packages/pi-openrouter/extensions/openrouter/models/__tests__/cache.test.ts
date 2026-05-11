import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { loadCache, saveCache, getCacheAgeMs, formatCacheAge } from '../cache.js';
import type { ModelsCache, OpenRouterModel } from '../types.js';

// Use the same cache directory as the implementation
const CACHE_DIR = join(homedir(), '.pi', 'openrouter');
const CACHE_FILE = join(CACHE_DIR, 'models-cache.json');

// Helper to create a mock cache
function createMockCache(overrides: Partial<ModelsCache> = {}): ModelsCache {
  const mockModel: OpenRouterModel = {
    id: 'test/model',
    name: 'Test Model',
    context_length: 128000,
    pricing: { prompt: '0.000001', completion: '0.000003' },
  };

  return {
    models: [mockModel],
    timestamp: Date.now() - 1000, // 1 second ago
    ...overrides,
  };
}

async function setupTestCache(): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
  } catch {
    // Directory may already exist
  }
}

async function cleanupTestCache(): Promise<void> {
  try {
    await rm(CACHE_DIR, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

describe('loadCache', () => {
  beforeEach(setupTestCache);
  afterEach(cleanupTestCache);

  it('should return null when cache file does not exist', async () => {
    const result = await loadCache();
    expect(result).toBeNull();
  });

  it('should return parsed cache when file exists and is valid', async () => {
    const mockCache = createMockCache({ timestamp: 1234567890 });
    await saveCache(mockCache);

    const result = await loadCache();
    expect(result).not.toBeNull();
    expect(result!.timestamp).toBe(1234567890);
    expect(result!.models).toHaveLength(1);
    expect(result!.models[0]!.id).toBe('test/model');
  });

  it('should return null when cache file contains invalid JSON', async () => {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(CACHE_FILE, 'not valid json');

    const result = await loadCache();
    expect(result).toBeNull();
  });

  it('should return null when cache structure is invalid', async () => {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify({ timestamp: 1234 })); // missing models

    const result = await loadCache();
    expect(result).toBeNull();
  });
});

describe('saveCache', () => {
  beforeEach(setupTestCache);
  afterEach(cleanupTestCache);

  it('should create cache file with valid JSON', async () => {
    const mockCache = createMockCache();

    await saveCache(mockCache);

    // Verify it can be loaded back
    const loaded = await loadCache();
    expect(loaded).not.toBeNull();
    expect(loaded!.timestamp).toBe(mockCache.timestamp);
    expect(loaded!.models).toEqual(mockCache.models);
  });

  it('should overwrite existing cache file', async () => {
    const firstCache = createMockCache({ timestamp: 1000 });
    const secondCache = createMockCache({ timestamp: 2000 });

    await saveCache(firstCache);
    await saveCache(secondCache);

    const loaded = await loadCache();
    expect(loaded!.timestamp).toBe(2000);
  });
});

describe('getCacheAgeMs', () => {
  it('should calculate age correctly for recent cache', () => {
    const cache = createMockCache({ timestamp: Date.now() - 60000 }); // 1 minute ago
    const age = getCacheAgeMs(cache);

    // Allow 100ms tolerance for test execution time
    expect(age).toBeGreaterThanOrEqual(60000);
    expect(age).toBeLessThan(61000);
  });

  it('should return 0 for cache with current timestamp', () => {
    const cache = createMockCache({ timestamp: Date.now() });
    const age = getCacheAgeMs(cache);
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(100);
  });
});

describe('formatCacheAge', () => {
  it('should return null for null cache', () => {
    expect(formatCacheAge(null)).toBeNull();
  });

  it('should format minutes when less than 1 hour', () => {
    const cache = createMockCache({ timestamp: Date.now() - 4 * 60000 }); // 4 minutes
    expect(formatCacheAge(cache)).toBe('4m');
  });

  it('should format hours when between 1 hour and 1 day', () => {
    const cache = createMockCache({ timestamp: Date.now() - 2 * 60 * 60000 }); // 2 hours
    expect(formatCacheAge(cache)).toBe('2h');
  });

  it('should format days when over 1 day', () => {
    const cache = createMockCache({ timestamp: Date.now() - 25 * 60 * 60000 }); // 25 hours
    expect(formatCacheAge(cache)).toBe('1d');
  });

  it('should handle exact hour boundaries', () => {
    const cache = createMockCache({ timestamp: Date.now() - 60 * 60000 }); // exactly 1 hour
    expect(formatCacheAge(cache)).toBe('1h');
  });
});
