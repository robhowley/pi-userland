import type { PresenceThresholds } from './types.js';

export const PRESENCE_PATH_SEGMENTS = ['.pi', 'session-deck', 'presence'] as const;

export const SESSION_DECK_COMMAND_NAME = 'session-deck';

export const DEFAULT_PRESENCE_THRESHOLDS: PresenceThresholds = {
  heartbeatIntervalMs: 10_000,
  liveAfterMs: 30_000,
  deadAfterMs: 5 * 60_000,
  reapAfterMs: 24 * 60 * 60_000,
  futureSkewMs: 5_000,
  pidReuseGraceMs: 2_000,
};

export function resolvePresenceThresholds(
  overrides: Partial<PresenceThresholds> = {},
): PresenceThresholds {
  return {
    ...DEFAULT_PRESENCE_THRESHOLDS,
    ...overrides,
  };
}
