import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import type { ModelsCache } from './types.js';

const CACHE_FILENAME = 'models-cache.json';
const DEFAULT_CACHE_DIR = join(homedir(), '.pi', 'openrouter');

// Allow overriding cache directory for testing
let cacheDirOverride: string | null = null;

/**
 * Get the cache directory.
 * Uses override if set (for testing), otherwise uses default.
 */
function getCacheDir(): string {
  return cacheDirOverride ?? DEFAULT_CACHE_DIR;
}

/**
 * Set a custom cache directory (for testing).
 * Pass null to reset to default.
 */
export function setCacheDir(dir: string | null): void {
  cacheDirOverride = dir;
}

/**
 * Get the full path to the cache file.
 */
function getCachePath(): string {
  return join(getCacheDir(), CACHE_FILENAME);
}

/**
 * Ensure the cache directory exists.
 */
async function ensureCacheDir(): Promise<void> {
  await mkdir(getCacheDir(), { recursive: true });
}

/**
 * Load cached models from disk.
 * Returns null if cache doesn't exist or is corrupted.
 */
export async function loadCache(): Promise<ModelsCache | null> {
  try {
    const cachePath = getCachePath();
    const data = await readFile(cachePath, 'utf-8');
    const parsed = JSON.parse(data) as ModelsCache;

    // Validate structure
    if (!parsed.models || !Array.isArray(parsed.models) || typeof parsed.timestamp !== 'number') {
      return null;
    }

    return parsed;
  } catch {
    // File doesn't exist, permission error, or invalid JSON
    return null;
  }
}

/**
 * Save models to cache on disk.
 */
export async function saveCache(cache: ModelsCache): Promise<void> {
  await ensureCacheDir();
  const cachePath = getCachePath();
  await writeFile(cachePath, JSON.stringify(cache, null, 2));
}

/**
 * Get the age of the cache in milliseconds.
 */
export function getCacheAgeMs(cache: ModelsCache): number {
  return Date.now() - cache.timestamp;
}

/**
 * Format cache age for display.
 * Examples: "4m", "2h", "1d"
 */
export function formatCacheAge(cache: ModelsCache | null): string | null {
  if (!cache) return null;

  const ageMs = getCacheAgeMs(cache);
  const minutes = Math.floor(ageMs / 60000);

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }

  return `${Math.floor(hours / 24)}d`;
}
