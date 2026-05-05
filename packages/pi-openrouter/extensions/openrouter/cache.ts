import type { UsageSummary, ActivityItem } from './types.js';
import { aggregateUsage } from './format.js';
import { getCredits, getActivity } from './client.js';

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
export const lastFetchTime = { value: 0 };

let refreshInterval: NodeJS.Timeout | null = null;

export function startBackgroundRefresh(): void {
  if (refreshInterval) return;

  refreshInterval = setInterval(async () => {
    try {
      const credits = await getCredits();
      let analytics: ActivityItem[] | null = null;
      try {
        analytics = await getActivity();
      } catch (err) {
        console.log('Activity fetch failed (management key required):', err);
      }
      const timestamp = Date.now();
      const summary = aggregateUsage(credits, analytics ?? [], timestamp);
      usageCache.set('usage', summary);
      lastFetchTime.value = timestamp;
    } catch (err) {
      console.log('Background refresh failed:', err);
    }
  }, 30000);
}

export function stopBackgroundRefresh(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}
