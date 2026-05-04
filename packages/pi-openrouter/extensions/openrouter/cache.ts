import type { UsageSummary } from './types.js';
import { aggregateUsage } from './format.js';
import { fetchCredits, fetchActivity } from './openrouter.js';

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

// Background refresh - fetch new data every 60 seconds
let refreshInterval: NodeJS.Timeout | null = null;

export function startBackgroundRefresh(): void {
  if (refreshInterval) return; // Already running

  refreshInterval = setInterval(async () => {
    try {
      const credits = await fetchCredits();
      let analytics: any = null;
      try {
        analytics = await fetchActivity();
      } catch (err) {
        // Activity fetch failed (management key required), continue with credits only
        console.log('Activity fetch failed (management key required):', err);
      }
      const summary = aggregateUsage(credits.data, analytics);
      usageCache.set('usage', summary);
      lastFetchTime.value = Date.now();
    } catch (err) {
      console.log('Background refresh failed:', err);
    }
  }, 60000);
}

export function stopBackgroundRefresh(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

// Auto-start on module load
startBackgroundRefresh();
