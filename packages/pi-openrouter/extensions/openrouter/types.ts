// Raw API responses
export interface CreditsResponse {
  data: {
    total_credits: number;
    total_usage: number;
  };
}

export interface AnalyticsResponse {
  data: Array<{
    date: string;
    model_permaslug: string;
    endpoint_id: string;
    usage: number;
    byok_usage_inference: number;
    requests: number;
    prompt_tokens: number;
    completion_tokens: number;
    reasoning_tokens: number;
    byok_requests: number;
    model: string;
    provider_name: string;
  }>;
}

// Domain types
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
}
