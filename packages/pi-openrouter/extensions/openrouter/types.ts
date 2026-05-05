export interface UsageSummary {
  today: number;
  week: number;
  month: number;
  cap: number;
  burnRate: number;
  topModels7d: { name: string; spend: number }[];
  topModels30d: { name: string; spend: number }[];
  byModel?: Record<string, number>;
  byKey?: Record<string, number>;
  byDay?: Record<string, number>;
  timestamp: number;
}

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
}
