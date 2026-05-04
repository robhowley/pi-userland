import type { AnalyticsResponse, UsageSummary } from './types.js';

export function aggregateUsage(
  credits: { total_usage: number },
  analytics: AnalyticsResponse,
): UsageSummary {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek = new Date(startOfDay);
  startOfWeek.setDate(startOfWeek.getDate() - 7);

  // Filter by time periods
  const weekData = analytics.data.filter((d) => {
    const ts = d.timestamp ? new Date(d.timestamp) : now;
    return ts >= startOfWeek;
  });

  const todayData = analytics.data.filter((d) => {
    const ts = d.timestamp ? new Date(d.timestamp) : now;
    return ts >= startOfDay;
  });

  const week = sumSpend(weekData);
  const today = sumSpend(todayData);
  const month = credits.total_usage;

  // Top models by 7d spend
  const modelSpend = aggregateByModel(weekData);
  const topModels = Object.entries(modelSpend)
    .map(([name, spend]) => ({ name, spend }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 3);

  // Cache rate needs to handle undefined case properly
  const cacheRate = calculateCacheRate(weekData);

  const result: UsageSummary = {
    today,
    week,
    month,
    burnRate: (week / 7) * 30,
    topModels,
  };

  if (cacheRate !== undefined) {
    result.cacheRate = cacheRate;
  }

  const byModel = aggregateByModel(analytics.data);
  if (Object.keys(byModel).length > 0) {
    result.byModel = byModel;
  }
  const byKey = aggregateByKey(analytics.data);
  if (Object.keys(byKey).length > 0) {
    result.byKey = byKey;
  }
  const byDay = aggregateByDay(analytics.data);
  if (Object.keys(byDay).length > 0) {
    result.byDay = byDay;
  }

  return result;
}

function sumSpend(data: AnalyticsResponse['data']): number {
  return data.reduce((sum, d) => sum + d.usage, 0);
}

function aggregateByModel(data: AnalyticsResponse['data']): Record<string, number> {
  return data
    .filter((d) => d.type === 'model')
    .reduce(
      (acc, d) => {
        acc[d.id] = (acc[d.id] || 0) + d.usage;
        return acc;
      },
      {} as Record<string, number>,
    );
}

function aggregateByKey(data: AnalyticsResponse['data']): Record<string, number> {
  return data
    .filter((d) => d.type === 'key')
    .reduce(
      (acc, d) => {
        acc[d.id] = (acc[d.id] || 0) + d.usage;
        return acc;
      },
      {} as Record<string, number>,
    );
}

function aggregateByDay(data: AnalyticsResponse['data']): Record<string, number> {
  const byDay: Record<string, number> = {};
  for (const d of data) {
    if (!d.timestamp) continue;
    const day = d.timestamp.split('T')[0];
    // TypeScript can't infer day is string from split, so we need assertion
    const dayStr = day as string;
    byDay[dayStr] = (byDay[dayStr] || 0) + d.usage;
  }
  return byDay;
}

function calculateCacheRate(data: AnalyticsResponse['data']): number | undefined {
  let totalInput = 0,
    totalCached = 0;
  for (const d of data) {
    if (d.tokens) {
      totalInput += d.tokens.input || 0;
      totalCached += d.tokens.cached || 0;
    }
  }
  if (totalInput + totalCached === 0) return undefined;
  return totalCached / (totalInput + totalCached);
}
