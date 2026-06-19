import type { IdentityFreshnessThresholds } from './types.js';

export const IDENTITY_PATH_SEGMENTS = ['.pi', 'session-deck', 'identity'] as const;

export const DEFAULT_IDENTITY_REFRESH_INTERVAL_MS = 45_000;

export const DEFAULT_IDENTITY_FRESHNESS_THRESHOLDS: IdentityFreshnessThresholds = {
  freshAfterMs: 2 * 60_000,
  staleAfterMs: 30 * 60_000,
};

export function resolveIdentityFreshnessThresholds(
  overrides: Partial<IdentityFreshnessThresholds> = {},
): IdentityFreshnessThresholds {
  return {
    ...DEFAULT_IDENTITY_FRESHNESS_THRESHOLDS,
    ...overrides,
  };
}
