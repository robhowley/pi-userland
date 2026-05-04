import type { AnalyticsResponse, UsageSummary } from './types.js';

export function aggregateUsage(
  credits: { total_usage: number; total_credits: number },
  analytics: AnalyticsResponse | null,
): UsageSummary {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek = new Date(startOfDay);
  startOfWeek.setDate(startOfWeek.getDate() - 7);

  // Filter by time periods (use empty array if no analytics)
  const weekData = analytics
    ? analytics.data.filter((d) => {
        const ts = d.date ? new Date(d.date) : now;
        return ts >= startOfWeek;
      })
    : [];

  const todayData = analytics
    ? analytics.data.filter((d) => {
        const ts = d.date ? new Date(d.date) : now;
        return ts >= startOfDay;
      })
    : [];

  const week = sumSpend(weekData);
  const today = sumSpend(todayData);
  const month = credits.total_usage;

  // Top models by 7d spend
  const modelSpend = aggregateByModel(analytics ? analytics.data : []);
  const topModels = Object.entries(modelSpend)
    .map(([name, spend]) => ({ name, spend }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 3);

  const result: UsageSummary = {
    today,
    week,
    month,
    cap: credits.total_credits,
    burnRate: (week / 7) * 30,
    topModels,
  };

  const byModel = aggregateByModel(analytics ? analytics.data : []);
  if (Object.keys(byModel).length > 0) {
    result.byModel = byModel;
  }
  const byKey = aggregateByKey(analytics ? analytics.data : []);
  if (Object.keys(byKey).length > 0) {
    result.byKey = byKey;
  }
  const byDay = aggregateByDay(analytics ? analytics.data : []);
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
    .reduce(
      (acc, d) => {
        acc[d.model_permaslug] = (acc[d.model_permaslug] || 0) + d.usage;
        return acc;
      },
      {} as Record<string, number>,
    );
}

function aggregateByKey(data: AnalyticsResponse['data']): Record<string, number> {
  return data
    .reduce(
      (acc, d) => {
        acc[d.provider_name] = (acc[d.provider_name] || 0) + d.usage;
        return acc;
      },
      {} as Record<string, number>,
    );
}

function aggregateByDay(data: AnalyticsResponse['data']): Record<string, number> {
  const byDay: Record<string, number> = {};
  for (const d of data) {
    // date format is "YYYY-MM-DD HH:MM:SS", extract just the date part
    const day = d.date.split(' ')[0];
    byDay[day] = (byDay[day] || 0) + d.usage;
  }
  return byDay;
}
