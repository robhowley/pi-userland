import type { UsageSummary } from './types.js';

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export class TTLCache<T> {
  private cache = new Map<string, CacheEntry<T>>();

  constructor(private ttlMs: number = 45000) {}

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.data;
  }

  set(key: string, data: T): void {
    this.cache.set(key, { data, timestamp: Date.now() });
  }
}

export const usageCache = new TTLCache<UsageSummary>(45000);
export const lastFetchTime = { value: 0 }; // For "cached Xm ago" display
