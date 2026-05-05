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
let consecutiveFailures = 0;
const MAX_RETRY_BACKOFF = 5; // Max 2^5 = 32x base interval (16 min)
const MAX_RETRY_COUNT = 4; // Stop after 4 consecutive failures

function getBackoffInterval(): number {
  const backoffMultiplier = Math.min(consecutiveFailures, MAX_RETRY_BACKOFF);
  return BACKGROUND_REFRESH_INTERVAL_MS * Math.pow(2, backoffMultiplier);
}

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

function scheduleRefresh(): void {
  const delay = consecutiveFailures > 0 ? getBackoffInterval() : BACKGROUND_REFRESH_INTERVAL_MS;

  refreshInterval = setInterval(async () => {
    try {
      const summary = await fetchAndAggregate();
      usageCache.set('usage', summary);

      // Reset failure count on success and restart with normal interval
      if (consecutiveFailures > 0) {
        consecutiveFailures = 0;
        stopBackgroundRefresh();
        scheduleRefresh();
      }
    } catch (err) {
      consecutiveFailures++;
      console.log(`Background refresh failed (${consecutiveFailures}/${MAX_RETRY_COUNT}):`, err);

      // Stop after max retries reached
      if (consecutiveFailures >= MAX_RETRY_COUNT) {
        console.log('Max retries reached, stopping background refresh');
        stopBackgroundRefresh();
        // TODO: Fire UI notification for persistent failure
        return;
      }

      // Restart with backoff interval
      stopBackgroundRefresh();
      scheduleRefresh();
    }
  }, delay);
}

export function startBackgroundRefresh(): void {
  if (refreshInterval) return;
  scheduleRefresh();
}

export function stopBackgroundRefresh(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}
