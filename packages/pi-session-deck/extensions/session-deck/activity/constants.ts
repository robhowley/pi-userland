import type { ActivityThresholds } from './types.js';

export const ACTIVITY_PATH_SEGMENTS = ['.pi', 'session-deck', 'activity'] as const;

export const DEFAULT_ACTIVITY_THRESHOLDS: ActivityThresholds = {
  freshAfterMs: 60_000,
  staleAfterMs: 2 * 60_000,
  toolStuckAfterMs: 10 * 60_000,
  veryStaleAfterMs: 30 * 60_000,
  futureSkewMs: 5_000,
  compactionStaleAfterMs: 2 * 60_000,
  compactionExpiredAfterMs: 10 * 60_000,
};

export const DEFAULT_ACTIVITY_REFRESH_INTERVAL_MS = 30_000;

export const MAX_ACTIVITY_ERROR_LENGTH = 200;

export function resolveActivityThresholds(
  overrides: Partial<ActivityThresholds> = {},
): ActivityThresholds {
  return {
    ...DEFAULT_ACTIVITY_THRESHOLDS,
    ...overrides,
  };
}
