import {
  addUtcDays,
  dedupeLocalUsageEvents,
  getCurrentUtcDate,
  getUtcDateFromTimestamp,
  readLocalUsage,
} from './local-usage.js';
import type { LocalUsageEvent } from './types.js';

const STATUS_WINDOW_DAYS = 30;
const STATUS_WINDOW_LABEL = '30d avg';
const STATUS_PREFIX = 'OR';
const STATUS_SEPARATOR = ' · ';

export interface OpenRouterStatusStats {
  todayLocalSpend: number;
  averageLocalDailySpendLast30Days: number;
  burnRateMultiplier: number | null;
}

export type OpenRouterStatusBarLoadResult =
  | { kind: 'ready'; text: string }
  | { kind: 'empty' }
  | { kind: 'failed' };

function getUtcDateForNow(now?: Date): string {
  return now ? now.toISOString().slice(0, 10) : getCurrentUtcDate();
}

export function calculateOpenRouterStatusStats(
  events: LocalUsageEvent[],
  nowUtcDate: string = getCurrentUtcDate(),
): OpenRouterStatusStats | null {
  const windowStartUtc = addUtcDays(nowUtcDate, -(STATUS_WINDOW_DAYS - 1));
  const uniqueEvents = dedupeLocalUsageEvents(events);

  let todayLocalSpend = 0;
  let totalLocalSpendInWindow = 0;

  for (const event of uniqueEvents) {
    const completedDateUtc = getUtcDateFromTimestamp(event.completedAt);
    if (completedDateUtc < windowStartUtc || completedDateUtc > nowUtcDate) {
      continue;
    }

    const cost = event.cost ?? 0;
    totalLocalSpendInWindow += cost;

    if (completedDateUtc === nowUtcDate) {
      todayLocalSpend += cost;
    }
  }

  if (totalLocalSpendInWindow <= 0) {
    return null;
  }

  const averageLocalDailySpendLast30Days = totalLocalSpendInWindow / STATUS_WINDOW_DAYS;

  return {
    todayLocalSpend,
    averageLocalDailySpendLast30Days,
    burnRateMultiplier:
      averageLocalDailySpendLast30Days === 0
        ? null
        : todayLocalSpend / averageLocalDailySpendLast30Days,
  };
}

export function formatOpenRouterStatusBar(stats: OpenRouterStatusStats): string {
  const today = `${STATUS_PREFIX} $${stats.todayLocalSpend.toFixed(2)} today`;
  if (stats.burnRateMultiplier === null) {
    return today;
  }

  return `${today}${STATUS_SEPARATOR}${stats.burnRateMultiplier.toFixed(1)}x ${STATUS_WINDOW_LABEL}`;
}

export async function loadOpenRouterStatusStats(now?: Date): Promise<OpenRouterStatusStats | null> {
  const todayUtc = getUtcDateForNow(now);
  const fromDateUtc = addUtcDays(todayUtc, -(STATUS_WINDOW_DAYS - 1));
  const events = await readLocalUsage({ fromDateUtc, toDateUtc: todayUtc });

  return calculateOpenRouterStatusStats(events, todayUtc);
}

export async function loadOpenRouterStatusBar(now?: Date): Promise<OpenRouterStatusBarLoadResult> {
  try {
    const stats = await loadOpenRouterStatusStats(now);
    if (!stats) {
      return { kind: 'empty' };
    }

    return {
      kind: 'ready',
      text: formatOpenRouterStatusBar(stats),
    };
  } catch {
    return { kind: 'failed' };
  }
}
