// Raw API responses
export interface CreditsResponse {
  data: {
    total_credits: number;
    total_usage: number;
  };
}

export interface AnalyticsResponse {
  data: Array<{
    id: string;
    type: 'model' | 'key';
    usage: number;
    tokens?: {
      input: number;
      output: number;
      cached?: number;
    };
    timestamp?: string;
  }>;
}

// Domain types
export interface UsageSummary {
  today: number;
  week: number;
  month: number;
  cap?: number;
  burnRate: number;
  cacheRate?: number;
  topModels: { name: string; spend: number }[];
  byModel?: Record<string, number>;
  byKey?: Record<string, number>;
  byDay?: Record<string, number>;
}
