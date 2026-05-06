import type { CacheEntry, UsageSummary } from './types.js';
import type { ActivityItem } from '@openrouter/sdk/models/index.js';
import { aggregateUsage } from './format.js';
import { getCredits, getActivity } from './client.js';
import { readLocalUsage, aggregateLocal, getCurrentUtcDate, addUtcDays } from './local-usage.js';
import { ZERO_AGGREGATE } from './types.js';

export const CACHE_TTL_MS = 45000;
export const BACKGROUND_REFRESH_INTERVAL_MS = 30000;

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

export async function fetchAndAggregate(): Promise<UsageSummary | null> {
  const credits = await getCredits();
  if (!credits) return null;
  let analytics: ActivityItem[] | null = null;
  let hasActivityData = true;
  try {
    analytics = await getActivity();
    if (!analytics) hasActivityData = false;
  } catch (err) {
    // getActivity() requires a management key; suppress this expected error
    if (!(err instanceof Error) || !err.message.includes('management key')) {
      console.log('Activity fetch failed');
    }
    hasActivityData = false;
  }
  const timestamp = Date.now();

  // Get official aggregate from Activity API data
  const officialThroughDate = (function (): string | undefined {
    if (!analytics || analytics.length === 0) return undefined;
    let maxDate = '';
    // Match YYYY-MM-DD or YYYY-MM-DD HH:MM:SS
    const dateRE = /^\d{4}-\d{2}-\d{2}/;
    for (let i = 0; i < analytics.length; i++) {
      const d = analytics[i];
      if (d && d.date && dateRE.test(d.date)) {
        const datePart = d.date.slice(0, 10); // Extract YYYY-MM-DD
        if (datePart > maxDate) {
          maxDate = datePart;
        }
      }
    }
    return maxDate || undefined;
  })();

  // Compute official aggregate (only from Activity API data up to officialThroughDate)
  const officialAggregate =
    hasActivityData && analytics && analytics.length > 0
      ? aggregateLocal(
          analytics.map(
            (item) =>
              ({
                id: item.date + '-' + item.providerName + '-' + item.model,
                sessionId: 'activity-api',
                completedAt: item.date + 'T00:00:00.000Z',
                requests: item.requests || 1,
                model: item.model,
                provider: item.providerName,
                promptTokens: item.promptTokens,
                completionTokens: item.completionTokens,
                reasoningTokens: item.reasoningTokens,
                cost: item.usage,
                estimated: false,
              }) as any,
          ),
        )
      : ZERO_AGGREGATE;

  // Read local JSONL after officialThroughDate
  const localEvents: any[] = [];
  if (officialThroughDate) {
    // Read from the day after officialThroughDate to today
    const localFrom = addUtcDays(officialThroughDate, 1);
    const localTo = getCurrentUtcDate();
    try {
      const localEventsList = await readLocalUsage({
        fromDateUtc: localFrom,
        toDateUtc: localTo,
      });
      localEvents.push(...localEventsList);
    } catch (err) {
      // Fail open - if local read fails, continue with empty local
      console.log('Local usage read failed:', err);
    }
  }

  // Aggregate local events
  const localAggregate = aggregateLocal(localEvents);

  // Combine official + local
  const combinedAggregate: any = {
    requests: officialAggregate.requests + localAggregate.requests,
    promptTokens: officialAggregate.promptTokens + localAggregate.promptTokens,
    completionTokens: officialAggregate.completionTokens + localAggregate.completionTokens,
    reasoningTokens: officialAggregate.reasoningTokens + localAggregate.reasoningTokens,
    cacheReadTokens: officialAggregate.cacheReadTokens + localAggregate.cacheReadTokens,
    cacheWriteTokens: officialAggregate.cacheWriteTokens + localAggregate.cacheWriteTokens,
    cost: officialAggregate.cost + localAggregate.cost,
  };

  // Build full summary with local events included for 7d/30d totals
  const summary = aggregateUsage(credits, analytics ?? [], timestamp, localEvents);
  summary.hasActivityData = hasActivityData;
  summary.officialThroughDate = (officialThroughDate as string | undefined) ?? undefined;
  summary.official = officialAggregate;
  summary.local = localAggregate;
  summary.combined = combinedAggregate;

  return summary;
}

function scheduleRefresh(): void {
  const delay = consecutiveFailures > 0 ? getBackoffInterval() : BACKGROUND_REFRESH_INTERVAL_MS;

  refreshInterval = setInterval(async () => {
    try {
      const summary = await fetchAndAggregate();
      if (summary) {
        usageCache.set('usage', summary);

        // Reset failure count on success and restart with normal interval
        if (consecutiveFailures > 0) {
          consecutiveFailures = 0;
          stopBackgroundRefresh();
          scheduleRefresh();
        }
      }
    } catch {
      consecutiveFailures++;
      console.log(`Background refresh failed (${consecutiveFailures}/${MAX_RETRY_COUNT})`);

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
