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
  officialThroughDate?: string | undefined;

  /** Aggregate from Activity API */
  official: UsageAggregate;

  /** Aggregate from local JSONL after officialThroughDate */
  local: UsageAggregate;

  /** Combined official + local */
  combined: UsageAggregate;
}

export interface LocalUsageEvent {
  /** UUID for deduplication */
  id: string;

  /** Generation ID from OpenRouter **/
  generationId: string;

  /** Existing pi-openrouter session ID */
  sessionId: string;

  /** ISO 8601 UTC timestamp */
  completedAt: string;

  /** Always 1 per completed turn; typed as number for flexibility */
  requests?: number;

  model?: string;

  /**
   * Actual OpenRouter routed provider (NOT "openrouter").
   * Examples: "ionstream/fp8", "parasail/bf16", "inceptron/int4"
   */
  provider?: string;

  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
}

export interface UsageAggregate {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

export const ZERO_AGGREGATE: UsageAggregate = {
  requests: 0,
  promptTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
};

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

// Re-export model types
export * from './models/types.js';
