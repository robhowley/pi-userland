import type { ActivityItem, UsageSummary } from './types.js';

export function aggregateUsage(
  credits: { totalUsage: number; totalCredits?: number },
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

  // Top models by 7d spend
  const modelSpend7d = aggregateByModel(weekData);
  const topModels7d = Object.entries(modelSpend7d)
    .map(([name, spend]) => ({ name, spend }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 3);

  // Top models by 30d spend
  const modelSpend30d = aggregateByModel(analytics);
  const topModels30d = Object.entries(modelSpend30d)
    .map(([name, spend]) => ({ name, spend }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 3);

  return {
    today,
    week,
    month,
    cap: credits.totalCredits ?? 0,
    burnRate: (week / 7) * 30,
    topModels7d,
    topModels30d,
    byModel: aggregateByModel(analytics),
    byKey: aggregateByProvider(analytics),
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

function aggregateByProvider(data: ActivityItem[]): Record<string, number> {
  return data.reduce((acc, d) => {
    acc[d.providerName] = (acc[d.providerName] || 0) + d.usage;
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
