import type { ActivityItem } from '@openrouter/sdk/models/index.js';
import type { ModelStats, ProviderStats, TokenStats, UsageSummary } from './types.js';
import { ZERO_AGGREGATE, type LocalUsageEvent } from './types.js';

/** Convert a Date to YYYY-MM-DD string in UTC (matching OpenRouter API format) */
function utcISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Extract date part (YYYY-MM-DD) from a local usage event */
function getEventDate(event: LocalUsageEvent): string {
  // event.completedAt is ISO 8601 UTC timestamp like "2026-05-06T14:30:00.000Z"
  // Extract YYYY-MM-DD part
  return event.completedAt.slice(0, 10);
}

export function aggregateUsage(
  credits: { totalUsage: number; totalCredits?: number },
  analytics: ActivityItem[],
  timestamp: number = Date.now(),
  localEvents: LocalUsageEvent[] = [],
): UsageSummary {
  const now = new Date();
  // Use UTC dates to match OpenRouter API (which uses UTC)
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const startOfWeek = new Date(startOfDay);
  startOfWeek.setUTCDate(startOfWeek.getUTCDate() - 7);

  const weekData = analytics.filter((d) => {
    // API dates are YYYY-MM-DD in UTC; compare by UTC date boundary
    return d.date >= utcISODate(startOfWeek);
  });

  const todayData = analytics.filter((d) => {
    // API dates are YYYY-MM-DD in UTC; compare by UTC date boundary
    return d.date >= utcISODate(startOfDay);
  });

  const weekFromAnalytics = sumSpend(weekData);
  const todayFromAnalytics = sumSpend(todayData);
  const month = credits.totalUsage;

  // Add local events to compute combined totals
  const weekFromLocal = localEvents
    .filter((e) => getEventDate(e) >= utcISODate(startOfWeek))
    .reduce((sum, e) => sum + (e.cost || 0), 0);
  const todayFromLocal = localEvents
    .filter((e) => getEventDate(e) >= utcISODate(startOfDay))
    .reduce((sum, e) => sum + (e.cost || 0), 0);

  const week = weekFromAnalytics + weekFromLocal;
  const today = todayFromAnalytics + todayFromLocal;

  // Merge analytics with local events for model/provider stats
  // Convert local events to ActivityItem-like format for existing functions
  const localItems = localEvents.map((e) => ({
    date: getEventDate(e),
    usage: e.cost || 0,
    promptTokens: e.promptTokens || 0,
    completionTokens: e.completionTokens || 0,
    reasoningTokens: e.reasoningTokens || 0,
    requests: e.requests || 1,
    model: e.model || 'unknown',
    providerName: e.provider || 'unknown',
    // Required fields that aren't used by our functions
    byokUsageInference: 0,
    endpointId: 'local-turns',
    modelPermaslug: e.model || 'unknown',
  }));

  const allData = [...analytics, ...localItems] as any[];

  // Build model stats for both 7d and 30d windows
  // Use allData (combined API + local) for 30d, weekData (combined) for 7d
  const modelStatsMap = buildModelStats(weekData, allData);
  const topModels = Array.from(modelStatsMap.values())
    .sort((a, b) => b.spend30d - a.spend30d)
    .slice(0, 10);

  const summary = {
    today,
    week,
    month,
    cap: credits.totalCredits ?? 0,
    burnRate: (week / 7) * 30,
    topModels,
    byProvider: buildProviderStats(allData),
    byDay: aggregateByDay(allData),
    timestamp,
    hasActivityData: true, // aggregateUsage is only called when analytics data is available
    officialThroughDate: undefined as string | undefined,
    official: ZERO_AGGREGATE,
    local: ZERO_AGGREGATE,
    combined: ZERO_AGGREGATE,
  } as UsageSummary;

  return summary;
}

function sumSpend(data: ActivityItem[]): number {
  return data.reduce((sum, d) => sum + d.usage, 0);
}

function aggregateTokens(data: ActivityItem[]): TokenStats {
  return data.reduce(
    (acc, d) => {
      acc.input += d.promptTokens || 0;
      acc.output += d.completionTokens || 0;
      acc.reasoning += (d.reasoningTokens || 0) as number;
      acc.total +=
        (d.promptTokens || 0) + (d.completionTokens || 0) + ((d.reasoningTokens || 0) as number);
      return acc;
    },
    { input: 0, output: 0, reasoning: 0, total: 0 } as TokenStats,
  );
}

function aggregateRequests(data: ActivityItem[]): number {
  return data.reduce((sum, d) => sum + (d.requests || 0), 0);
}

function buildModelStats(data7d: ActivityItem[], data30d: ActivityItem[]): Map<string, ModelStats> {
  const all = new Map<string, ModelStats>();
  const modelNames = new Set<string>();

  // Collect all unique model names from both time windows
  for (const d of data30d) modelNames.add(d.model);
  for (const d of data7d) modelNames.add(d.model);

  for (const name of modelNames) {
    const data7dForModel = data7d.filter((d) => d.model === name);
    const data30dForModel = data30d.filter((d) => d.model === name);

    all.set(name, {
      name,
      spend7d: data7dForModel.reduce((s, d) => s + d.usage, 0),
      spend30d: data30dForModel.reduce((s, d) => s + d.usage, 0),
      tokens7d: aggregateTokens(data7dForModel),
      tokens30d: aggregateTokens(data30dForModel),
      requests7d: aggregateRequests(data7dForModel),
      requests30d: aggregateRequests(data30dForModel),
    });
  }

  return all;
}

function buildProviderStats(data: ActivityItem[]): ProviderStats[] {
  const byName = new Map<string, ActivityItem[]>();

  for (const d of data) {
    const existing = byName.get(d.providerName) || [];
    existing.push(d);
    byName.set(d.providerName, existing);
  }

  const stats: ProviderStats[] = [];
  for (const [name, items] of byName) {
    stats.push({
      name,
      spend: items.reduce((s, d) => s + d.usage, 0),
      tokens: aggregateTokens(items),
      requests: aggregateRequests(items),
    });
  }

  return stats.sort((a, b) => b.spend - a.spend);
}

function aggregateByDay(data: ActivityItem[]): Record<string, number> {
  const byDay: Record<string, number> = {};
  for (const d of data) {
    const day = d.date;
    byDay[day] = (byDay[day] || 0) + d.usage;
  }
  return byDay;
}
