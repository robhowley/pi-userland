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

  /** Date of latest official Activity API data (YYYY-MM-DD) */
  officialThroughDate?: string;

  /** Aggregate from Activity API (always estimated: false) */
  official: UsageAggregate;

  /** Aggregate from local JSONL after officialThroughDate */
  local: UsageAggregate;

  /** Combined official + local */
  combined: UsageAggregate;
}

export interface LocalUsageEvent {
  /** UUID for deduplication */
  id: string;

  /** Existing pi-openrouter session ID */
  sessionId: string;

  /** ISO 8601 UTC timestamp */
  completedAt: string;

  /** Always 1 per completed turn */
  requests: 1;

  model?: string;

  /**
   * Actual OpenRouter routed provider (NOT "openrouter").
   * Examples: "ionstream/fp8", "parasail/bf16", "inceptron/int4"
   */
  provider?: string;

  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  cost?: number;

  /** True if cost was computed, not from API response */
  estimated?: boolean;
}

export interface UsageAggregate {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cost: number;

  /**
   * True if ANY contributing event had estimated === true.
   * Activity API data is always estimated: false.
   */
  estimated: boolean;
}

export const ZERO_AGGREGATE: UsageAggregate = {
  requests: 0,
  promptTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  cost: 0,
  estimated: false,
};

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
}
