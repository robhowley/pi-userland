import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import {
  loadCache,
  saveCache,
  getCacheAgeMs,
  formatDuration,
  formatCacheAge,
  setCacheDir,
} from '../cache.js';
import { createMockCache } from '../../__tests__/fixtures.js';

// Each test gets its own isolated temp directory
let testCacheDir: string;

async function setupTestCache(): Promise<void> {
  // Create isolated temp directory for this test
  testCacheDir = join(tmpdir(), `pi-openrouter-test-${randomUUID()}`);
  await mkdir(testCacheDir, { recursive: true });
  // Tell the cache module to use our test directory
  setCacheDir(testCacheDir);
}

async function cleanupTestCache(): Promise<void> {
  // Reset cache dir to default (null means use default)
  setCacheDir(null);
  // Clean up temp directory
  try {
    await rm(testCacheDir, { recursive: true, force: true });
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
    const mockCache = createMockCache({ catalogMode: 'free-only', timestamp: 1234567890 });
    await saveCache(mockCache);

    const result = await loadCache();
    expect(result).not.toBeNull();
    expect(result!.catalogMode).toBe('free-only');
    expect(result!.timestamp).toBe(1234567890);
    expect(result!.models).toHaveLength(1);
    expect(result!.models[0]!.id).toBe('test/model');
  });

  it('should return null when cache file contains invalid JSON', async () => {
    await mkdir(testCacheDir, { recursive: true });
    const cacheFile = join(testCacheDir, 'models-cache.json');
    await writeFile(cacheFile, 'not valid json');

    const result = await loadCache();
    expect(result).toBeNull();
  });

  it('should return null when cache structure is invalid', async () => {
    await mkdir(testCacheDir, { recursive: true });
    const cacheFile = join(testCacheDir, 'models-cache.json');
    await writeFile(cacheFile, JSON.stringify({ timestamp: 1234 })); // missing models

    const result = await loadCache();
    expect(result).toBeNull();
  });

  it('should normalize old cache files without catalogMode to full', async () => {
    await mkdir(testCacheDir, { recursive: true });
    const cacheFile = join(testCacheDir, 'models-cache.json');
    const oldCache = createMockCache({ timestamp: 1234567890 });
    const legacyCache = {
      models: oldCache.models,
      skippedDetails: oldCache.skippedDetails,
      timestamp: oldCache.timestamp,
    };

    await writeFile(cacheFile, JSON.stringify(legacyCache));

    const result = await loadCache();
    expect(result).not.toBeNull();
    expect(result!.catalogMode).toBe('full');
  });

  it('should return null when cache timestamp is too far in the future', async () => {
    await mkdir(testCacheDir, { recursive: true });
    const cacheFile = join(testCacheDir, 'models-cache.json');
    await writeFile(
      cacheFile,
      JSON.stringify(createMockCache({ timestamp: Date.now() + 6 * 60000 })),
    );

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
    expect(loaded!.catalogMode).toBe('full');
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

  it('should clamp future timestamps when saving', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T12:00:00.000Z'));

    try {
      const now = Date.now();
      const mockCache = createMockCache({ timestamp: now + 60000 });

      await saveCache(mockCache);

      const loaded = await loadCache();
      expect(loaded).not.toBeNull();
      expect(loaded!.timestamp).toBe(now);
    } finally {
      vi.useRealTimers();
    }
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

  it('should clamp small future skew to age 0', () => {
    const cache = createMockCache({ timestamp: Date.now() + 60000 });
    expect(getCacheAgeMs(cache)).toBe(0);
  });
});

describe('formatDuration', () => {
  it('should return unknown for null values', () => {
    expect(formatDuration(null)).toBe('unknown');
  });

  it('should format zero as less than one minute', () => {
    expect(formatDuration(0)).toBe('<1m');
  });

  it('should format negative values as less than one minute', () => {
    expect(formatDuration(-1)).toBe('<1m');
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

  it('should clamp future cache age display to less than one minute', () => {
    const cache = createMockCache({ timestamp: Date.now() + 60000 });
    expect(formatCacheAge(cache)).toBe('<1m');
  });
});
