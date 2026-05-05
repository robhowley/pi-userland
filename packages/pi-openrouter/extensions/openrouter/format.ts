import type { ActivityItem } from '@openrouter/sdk/models/index.js';
import type { ModelStats, ProviderStats, TokenStats, UsageSummary } from './types.js';

export function aggregateUsage(
  credits: { totalUsage: number; totalCredits?: number },
  analytics: ActivityItem[],
  timestamp: number = Date.now(),
): UsageSummary {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek = new Date(startOfDay);
  startOfWeek.setDate(startOfWeek.getDate() - 7);

  const weekData = analytics.filter((d) => {
    const ts = new Date(d.date);
    return ts >= startOfWeek;
  });

  const todayData = analytics.filter((d) => {
    const ts = new Date(d.date);
    return ts >= startOfDay;
  });

  const week = sumSpend(weekData);
  const today = sumSpend(todayData);
  const month = credits.totalUsage;

  // Build model stats for both 7d and 30d windows
  const modelStatsMap = buildModelStats(weekData, analytics);
  const topModels = Array.from(modelStatsMap.values())
    .sort((a, b) => b.spend30d - a.spend30d)
    .slice(0, 10);

  return {
    today,
    week,
    month,
    cap: credits.totalCredits ?? 0,
    burnRate: (week / 7) * 30,
    topModels,
    byProvider: buildProviderStats(analytics),
    byDay: aggregateByDay(analytics),
    timestamp,
  };
}

function sumSpend(data: ActivityItem[]): number {
  return data.reduce((sum, d) => sum + d.usage, 0);
}

function aggregateTokens(data: ActivityItem[]): TokenStats {
  return data.reduce(
    (acc, d) => {
      acc.input += d.promptTokens || 0;
      acc.output += d.completionTokens || 0;
      acc.reasoning += d.reasoningTokens || 0;
      acc.total += (d.promptTokens || 0) + (d.completionTokens || 0) + (d.reasoningTokens || 0);
      return acc;
    },
    { input: 0, output: 0, reasoning: 0, total: 0 } as TokenStats,
  );
}

function aggregateRequests(data: ActivityItem[]): number {
  return data.reduce((sum, d) => sum + (d.requests || 0), 0);
}

function buildModelStats(
  data7d: ActivityItem[],
  data30d: ActivityItem[],
): Map<string, ModelStats> {
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
