import type { ActivityItem, UsageSummary } from './types.js';

export function aggregateUsage(
  credits: { totalUsage: number },
  analytics: ActivityItem[]
): UsageSummary {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek = new Date(startOfDay);
  startOfWeek.setDate(startOfWeek.getDate() - 7);

  const weekData = analytics.filter(d => {
    const ts = new Date(d.date);
    return ts >= startOfWeek;
  });

  const todayData = analytics.filter(d => {
    const ts = new Date(d.date);
    return ts >= startOfDay;
  });

  const week = sumSpend(weekData);
  const today = sumSpend(todayData);
  const month = credits.totalUsage;

  const modelSpend = aggregateByModel(weekData);
  const topModels = Object.entries(modelSpend)
    .map(([name, spend]) => ({ name, spend }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 3);

  return {
    today,
    week,
    month,
    cap: 0,
    burnRate: (week / 7) * 30,
    topModels7d: topModels,
    topModels30d: [],
    byModel: aggregateByModel(analytics),
    byKey: aggregateByEndpoint(analytics),
    byDay: aggregateByDay(analytics),
  };
}

function sumSpend(data: ActivityItem[]): number {
  return data.reduce((sum, d) => sum + d.usage, 0);
}

function aggregateByModel(data: ActivityItem[]): Record<string, number> {
  return data.reduce((acc, d) => {
    acc[d.model] = (acc[d.model] || 0) + d.usage;
    return acc;
  }, {} as Record<string, number>);
}

function aggregateByEndpoint(data: ActivityItem[]): Record<string, number> {
  return data.reduce((acc, d) => {
    acc[d.endpointId] = (acc[d.endpointId] || 0) + d.usage;
    return acc;
  }, {} as Record<string, number>);
}

function aggregateByDay(data: ActivityItem[]): Record<string, number> {
  const byDay: Record<string, number> = {};
  for (const d of data) {
    const day = d.date;
    byDay[day] = (byDay[day] || 0) + d.usage;
  }
  return byDay;
}
