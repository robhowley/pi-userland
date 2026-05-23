import type { CacheEntry, UsageSummary, LocalUsageEvent } from './types.js';
import type { ActivityItem } from '@openrouter/sdk/models/index.js';
import { aggregateUsage } from './format.js';
import { getCredits, getActivity } from './client.js';
import { readLocalUsage, aggregateLocal, getCurrentUtcDate, addUtcDays } from './local-usage.js';
import { combineUsageAggregates, createZeroAggregate } from './types.js';

export const CACHE_TTL_MS = 45000;
export const BACKGROUND_REFRESH_INTERVAL_MS = 30000;

interface CacheGetOptions {
  allowStale?: boolean;
}

export class TTLCache<T> {
  private cache = new Map<string, CacheEntry<T>>();

  constructor(private ttlMs: number = CACHE_TTL_MS) {}

  get(key: string, options: CacheGetOptions = {}): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (!options.allowStale && Date.now() - entry.timestamp > this.ttlMs) {
      return undefined;
    }

    return entry.data;
  }

  getTimestamp(key: string, options: CacheGetOptions = {}): number | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (!options.allowStale && Date.now() - entry.timestamp > this.ttlMs) {
      return undefined;
    }

    return entry.timestamp;
  }

  set(key: string, data: T): void {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  clear(key?: string): void {
    if (key) {
      this.cache.delete(key);
      return;
    }
    this.cache.clear();
  }
}

export const usageCache = new TTLCache<UsageSummary>(CACHE_TTL_MS);

export type RefreshStatus = 'idle' | 'healthy' | 'refreshing' | 'stale' | 'failed';

export interface RefreshState {
  status: RefreshStatus;
  consecutiveFailures: number;
  lastError: string | null;
  lastSuccessAt: number | null;
  nextDelayMs: number | null;
}

export interface StartBackgroundRefreshOptions {
  onFailure?: (state: RefreshState) => void;
}

let refreshTimer: NodeJS.Timeout | null = null;
let refreshActive = false;
let consecutiveFailures = 0;
let refreshFailureCallback: ((state: RefreshState) => void) | undefined;
let refreshState: RefreshState = {
  status: 'idle',
  consecutiveFailures: 0,
  lastError: null,
  lastSuccessAt: null,
  nextDelayMs: null,
};
const MAX_RETRY_BACKOFF = 5; // Max 2^5 = 32x base interval (16 min)
const RATE_LIMIT_BACKOFF_MULTIPLIER = 8; // 4 minutes with the default 30s interval

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRateLimitError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes('429') || message.includes('rate limit') || message.includes('rate-limit')
  );
}

function getBackoffInterval(error?: unknown): number {
  const backoffMultiplier = Math.min(consecutiveFailures, MAX_RETRY_BACKOFF);
  const exponentialDelay = BACKGROUND_REFRESH_INTERVAL_MS * Math.pow(2, backoffMultiplier);
  const cappedDelay = Math.min(
    exponentialDelay,
    BACKGROUND_REFRESH_INTERVAL_MS * Math.pow(2, MAX_RETRY_BACKOFF),
  );

  if (!isRateLimitError(error)) {
    return cappedDelay;
  }

  const rateLimitDelay = BACKGROUND_REFRESH_INTERVAL_MS * RATE_LIMIT_BACKOFF_MULTIPLIER;
  return Math.min(
    Math.max(cappedDelay, rateLimitDelay),
    BACKGROUND_REFRESH_INTERVAL_MS * Math.pow(2, MAX_RETRY_BACKOFF),
  );
}

export function getRefreshState(): RefreshState {
  return { ...refreshState };
}

function scheduleRefresh(delay: number): void {
  if (!refreshActive) return;
  refreshState = { ...refreshState, nextDelayMs: delay };

  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    await runBackgroundRefreshOnce();
    if (refreshActive) {
      scheduleRefresh(refreshState.nextDelayMs ?? BACKGROUND_REFRESH_INTERVAL_MS);
    }
  }, delay);
}

async function runBackgroundRefreshOnce(): Promise<void> {
  refreshState = { ...refreshState, status: 'refreshing' };

  try {
    const summary = await fetchAndAggregate();
    if (!summary) {
      throw new Error('OpenRouter usage unavailable: no configured API key or credits response.');
    }

    usageCache.set('usage', summary);
    consecutiveFailures = 0;
    refreshState = {
      status: 'healthy',
      consecutiveFailures,
      lastError: null,
      lastSuccessAt: Date.now(),
      nextDelayMs: BACKGROUND_REFRESH_INTERVAL_MS,
    };
  } catch (error) {
    consecutiveFailures++;
    const hasStaleData = usageCache.get('usage', { allowStale: true }) !== undefined;
    refreshState = {
      status: hasStaleData ? 'stale' : 'failed',
      consecutiveFailures,
      lastError: getErrorMessage(error),
      lastSuccessAt: refreshState.lastSuccessAt,
      nextDelayMs: getBackoffInterval(error),
    };
    refreshFailureCallback?.(getRefreshState());
  }
}

/**
 * Extract the latest date from Activity API data.
 * Returns undefined if analytics is null, empty, or has no valid dates.
 */
function getOfficialThroughDate(analytics: ActivityItem[] | null): string | undefined {
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
}

/**
 * Compute the date range for reading local JSONL usage.
 * Returns { fromDateUtc, toDateUtc } for the bounded window.
 *
 * Product decision:
 * - If officialThroughDate exists: read from day after through today
 * - If no official data: read from today - 29 days through today (30 days total)
 */
function getLocalUsageReadRange(
  officialThroughDate: string | undefined,
  now: string,
): { fromDateUtc: string; toDateUtc: string } {
  if (officialThroughDate) {
    // Read from the day after officialThroughDate to today
    return {
      fromDateUtc: addUtcDays(officialThroughDate, 1),
      toDateUtc: now,
    };
  } else {
    // No official data: read bounded 30-day window (today - 29 through today)
    return {
      fromDateUtc: addUtcDays(now, -29),
      toDateUtc: now,
    };
  }
}

export async function fetchAndAggregate(): Promise<UsageSummary | null> {
  const credits = await getCredits();
  if (!credits) return null;
  let analytics: ActivityItem[] | null = null;
  let hasActivityData = true;
  try {
    analytics = await getActivity();
    if (!analytics) hasActivityData = false;
  } catch {
    // getActivity() requires a management key; suppress this expected error
    hasActivityData = false;
  }
  const timestamp = Date.now();

  // Get official aggregate from Activity API data
  const officialThroughDate = getOfficialThroughDate(analytics);

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
              }) as LocalUsageEvent,
          ),
        )
      : createZeroAggregate();

  // Read local JSONL for bounded recent window
  // Always compute local read range when credits exist (Activity API may be absent/empty)
  const now = getCurrentUtcDate();
  const localReadRange = getLocalUsageReadRange(officialThroughDate, now);
  const localEvents: LocalUsageEvent[] = [];
  try {
    const localEventsList = await readLocalUsage(localReadRange);
    localEvents.push(...localEventsList);
  } catch {
    // Fail open - if local read fails, continue with empty local
  }

  // Aggregate local events
  const localAggregate = aggregateLocal(localEvents);

  // Combine official + local
  const combinedAggregate = combineUsageAggregates(officialAggregate, localAggregate);

  // Build full summary with local events included for 7d/30d totals
  const summary = aggregateUsage(credits, analytics ?? [], timestamp, localEvents);
  summary.hasActivityData = hasActivityData;
  summary.officialThroughDate = (officialThroughDate as string | undefined) ?? undefined;
  summary.official = officialAggregate;
  summary.local = localAggregate;
  summary.combined = combinedAggregate;

  return summary;
}

export function startBackgroundRefresh(options: StartBackgroundRefreshOptions = {}): void {
  if (options.onFailure) {
    refreshFailureCallback = options.onFailure;
  }
  if (refreshActive || refreshTimer) return;
  refreshActive = true;
  scheduleRefresh(BACKGROUND_REFRESH_INTERVAL_MS);
}

export function stopBackgroundRefresh(): void {
  refreshActive = false;
  refreshFailureCallback = undefined;
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  consecutiveFailures = 0;
  refreshState = {
    status: 'idle',
    consecutiveFailures,
    lastError: null,
    lastSuccessAt: null,
    nextDelayMs: null,
  };
}
