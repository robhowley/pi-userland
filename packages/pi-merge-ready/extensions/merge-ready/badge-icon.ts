import type { MergeReadyBadgeId } from './types.js';

export const BADGE_ICON_BY_ID = {
  draft: '📝',
  merge_conflicts: '⚠️',
  branch_out_of_date: '🔄',
  merge_blocked: '⛔',
  ci_failing: '❌',
  changes_requested: '🔁',
  unresolved_conversations: '💬',
  ci_running: '⏳',
  review_pending: '👀',
  ready: '✅',
  merged: '🎉',
  closed: '⛔',
  unknown: '❔',
} as const satisfies Record<MergeReadyBadgeId, string>;
