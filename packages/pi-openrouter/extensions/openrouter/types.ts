export interface TokenStats {
  input: number;
  output: number;
  reasoning: number;
  total: number;
}

export interface ModelStats {
  name: string;
  spend7d: number;
  spend30d: number;
  tokens7d: TokenStats;
  tokens30d: TokenStats;
  requests7d: number;
  requests30d: number;
}

export interface ProviderStats {
  name: string;
  spend: number;
  tokens: TokenStats;
  requests: number;
}

export interface UsageSummary {
  today: number;
  week: number;
  month: number;
  cap: number;
  burnRate: number;
  topModels: ModelStats[];
  byProvider: ProviderStats[];
  byDay: Record<string, number>;
  timestamp: number;
  hasActivityData: boolean;
}

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
}
