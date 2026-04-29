/**
 * Session Hygiene Types
 */

export interface Thresholds {
  yellow: { cost: number; context: number };
  red: { cost: number; context: number };
}

export interface SessionState {
  /** Reconstructed + accumulated assistant cost for the active session branch */
  totalCost: number;
  /** Cumulative non-cached input tokens for cache hit-rate display */
  inputTokens: number;
  /** Cumulative cache-read tokens for cache hit-rate display */
  cacheReadTokens: number;
}

export type HealthLevel = 'green' | 'yellow' | 'red';
