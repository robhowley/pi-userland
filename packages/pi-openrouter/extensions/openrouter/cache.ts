import type { UsageSummary } from './types.js';
import type { ActivityItem } from '@openrouter/sdk/models/index.js';
import { aggregateUsage } from './format.js';
import { getCredits, getActivity } from './client.js';

export const CACHE_TTL_MS = 45000;
export const BACKGROUND_REFRESH_INTERVAL_MS = 30000;

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export class TTLCache<T> {
  private cache = new Map<string, CacheEntry<T>>();

  constructor(private ttlMs: number = CACHE_TTL_MS) {}

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.data;
  }

  getTimestamp(key: string): number | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.timestamp;
  }

  set(key: string, data: T): void {
    this.cache.set(key, { data, timestamp: Date.now() });
  }
}

export const usageCache = new TTLCache<UsageSummary>(CACHE_TTL_MS);

let refreshInterval: NodeJS.Timeout | null = null;

export async function fetchAndAggregate(): Promise<UsageSummary> {
  const credits = await getCredits();
  let analytics: ActivityItem[] | null = null;
  try {
    analytics = await getActivity();
  } catch (err) {
    console.log('Activity fetch failed (management key required):', err);
  }
  const timestamp = Date.now();
  return aggregateUsage(credits, analytics ?? [], timestamp);
}

export function startBackgroundRefresh(): void {
  if (refreshInterval) return;

  refreshInterval = setInterval(async () => {
    try {
      const summary = await fetchAndAggregate();
      const timestamp = Date.now();
      usageCache.set('usage', summary);
    } catch (err) {
      console.log('Background refresh failed:', err);
    }
  }, BACKGROUND_REFRESH_INTERVAL_MS);
}

export function stopBackgroundRefresh(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}
